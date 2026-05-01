import { loadServiceSql } from "@/db/sqlLoader.js";
import { pickRandom } from "../utils.js";
import { BuildingSchema, ensureBuildingSchema, RoomSchema, SuiteSchema } from "./buildingSchema.js";
import { GameState, Position } from "../gameSystem/gameSessionStore.js";
import { query } from "@/db/client.js";
import { DbBuildingFeatureDetailRow, FeatureId, mapBuildingDetailRowToFeatureDetail } from "../featureDetail.js";

/**
 * 内部（指 BuildingRoom/BuildingSubRoom）兼做物品/家具/载具在建筑内的存储地
 */
export interface BuildingRecord {
  featureId: string;
  category: string;
  centerPosition: Position;
  tags: Record<string, string>;
  levels: Record<number, BuildingLevel>; // key 为楼层数号
}

export interface BuildingLevel {
  level: number;
  description: string;
  sectors: Record<string, BuildingSector>; // key 为该 Sector 的名字
}

export interface BuildingSector {
  name: string;
  area: number;
  centerPosition: Position;
  rooms: Record<string, BuildingRoom | BuildingSuite>; // key 为普通房间或套房容器的 id
}

/**
 * 兼做物品/家具/载具在建筑内的存储地。
 */
export interface BuildingRoom {
  roomId: string;
  description: string;
  access?: "entrance" | "vertical" | "internal";
}

/**
 * 套房只是逻辑分组，不是玩家可直接停留的位置。
 * 因此 suite 本身不再暴露 roomId，玩家若位于套房范围内，必须继续落到某个具体 subRoom。
 */
export interface BuildingSuite {
  suiteId: string;
  description: string;
  subRooms: Record<string, BuildingSubRoom>;
}

/**
 * 特意无 access。
 * subRoom 才是套房内部可实际落脚的位置，因此保留 roomId。
 * 兼做物品/家具/载具在建筑内的存储地。
 */
export interface BuildingSubRoom {
  roomId: string;
  description: string;
}

interface DbContainingBuildingRow extends DbBuildingFeatureDetailRow {
  center_lon: number;
  center_lat: number;
}

interface ContainingBuildingSnapshot {
  featureId: FeatureId;
  tags: Record<string, string>;
}

//#region 常量

const BEDROOM_WILD_KEY = "bedroom_wild";
type BedroomWildTargetKey = "bedroom" | "kids_bedroom" | "office";
const BEDROOM_WILD_TARGET_KEYS: BedroomWildTargetKey[] = ["bedroom", "kids_bedroom", "office"];

//#region 主函数

/**
 * 把 BuildingSchema 转成运行期更易消费的 BuildingRecord。
 * 这里会把 count > 1 的房间膨胀成多个具名 roomId，方便玩家位置与可见范围直接引用。
 * @param schema
 * @returns
 */
export function generateBuildingRecord(schema: BuildingSchema): BuildingRecord {
  const levels = Object.values(schema.levels)
    .flatMap((levelSchema) => levelSchema.span.map((level) => toBuildingLevel(level, levelSchema)))
    .reduce<Record<number, BuildingLevel>>((accumulator, level) => {
      accumulator[level.level] = level;
      return accumulator;
    }, {});

  return {
    featureId: schema.featureId,
    category: schema.category,
    centerPosition: schema.centerPosition,
    tags: {},
    levels,
  };
}

const fetchBuildingTagsByPositionSqlPromise = loadServiceSql("buildingGeneration/sql/fetchBuildingTagsByPosition.sql");

/**
 * 根据玩家坐标查找所处建筑。
 *
 * 若返回 feature id，说明开局应走室内分支；
 * 若没有结果，则保持室外开局。
 * @param position
 * @returns 命中的 building feature id，或者 null
 */
export async function findContainingBuildingFeatureId(position: Position): Promise<ContainingBuildingSnapshot | null> {
  const sql = await fetchBuildingTagsByPositionSqlPromise;
  const result = await query<DbContainingBuildingRow>(sql, [position.lon, position.lat]);
  const row = result.rows[0];
  if (!row) {
    return null;
  }

  const detail = mapBuildingDetailRowToFeatureDetail(row);
  return {
    featureId: detail.featureId,
    tags: detail.tags,
  };
}

export async function ensureBuildingRecord(featureId: FeatureId, state: GameState): Promise<BuildingRecord> {
  const existing = state.buildingRecords[featureId];
  if (existing) {
    return existing;
  }

  const schema = await ensureBuildingSchema(featureId, state);
  const record = generateBuildingRecord(schema);
  state.buildingRecords[featureId] = record;
  return record;
}

//#region 蓝图生成建筑

/**
 * 从蓝图生成楼层
 * @param level
 * @param schema
 * @returns
 */
function toBuildingLevel(level: number, schema: BuildingSchema["levels"][string]): BuildingLevel {
  const sectors = Object.entries(schema.sectors).reduce<Record<string, BuildingSector>>((accumulator, [sectorName, sector]) => {
    accumulator[sectorName] = {
      name: sectorName,
      area: sector.area,
      centerPosition: sector.centerPosition,
      rooms: expandSectorRooms(level, sector.rooms),
    };
    return accumulator;
  }, {});

  return {
    level,
    description: schema.description,
    sectors,
  };
}

/**
 * 从蓝图生成房间
 * @param rooms
 * @returns
 */
function expandSectorRooms(
  level: number,
  rooms: Record<string, RoomSchema | SuiteSchema>,
): Record<string, BuildingRoom | BuildingSuite> {
  const expandedEntries: Array<readonly [string, BuildingRoom | BuildingSuite]> = [];
  Object.entries(rooms).forEach(([roomKey, room]) => {
    if ("subRooms" in room) {
      const suiteCount = normalizeCount(room.count);
      rangeCount(suiteCount).forEach((index) => {
        const suiteId = toIndexedRoomId(level, roomKey, index, suiteCount);
        expandedEntries.push([suiteId, {
          suiteId,
          description: room.description,
          subRooms: expandSuiteSubRooms(level, suiteId, room.subRooms),
        }]);
      });
      return;
    }

    const roomCount = normalizeCount(room.count);
    rangeCount(roomCount).forEach((index) => {
      const roomId = toIndexedRoomId(level, roomKey, index, roomCount);
      expandedEntries.push([roomId, {
        roomId,
        description: room.description,
        ...(room.access ? { access: room.access } : {}),
      }]);
    });
  });

  return Object.fromEntries(expandedEntries);
}

/**
 * 从蓝图生成套房的子房间
 * @param level
 * @param suiteId
 * @param subRooms
 * @returns
 */
function expandSuiteSubRooms(
  level: number,
  suiteId: string,
  subRooms: SuiteSchema["subRooms"],
): Record<string, BuildingSubRoom> {
  const expandedEntries = Object.entries(subRooms).flatMap(([subRoomKey, subRoom]) => {
    // TODO 目前只有一种通配房间
    if (subRoomKey === BEDROOM_WILD_KEY) {
      return expandBedroomWildSubRooms(level, suiteId, normalizeCount(subRoom.count));
    }

    return expandConcreteSubRooms(suiteId, subRoomKey, subRoom.description, normalizeCount(subRoom.count));
  });

  return Object.fromEntries(expandedEntries);
}

//#region 辅助函数

/**
 * wildcard 只在 BuildingRecord 展开阶段实例化，不回写 BuildingSchema。
 * `bedroom_wild` 的 count 是共享预算，至少保留 1 个普通卧室，剩余额度再随机分给儿童卧室与办公室。
 */
function expandBedroomWildSubRooms(
  level: number,
  suiteId: string,
  count: number,
): Array<readonly [string, BuildingSubRoom]> {
  const allocations = allocateBedroomWildTargets(count);
  return BEDROOM_WILD_TARGET_KEYS.flatMap((roomKey: BedroomWildTargetKey) => (
    expandConcreteSubRooms(
      suiteId,
      roomKey,
      describeBedroomWildTarget(roomKey),
      allocations[roomKey],
    )
  ));
}

function allocateBedroomWildTargets(count: number): Record<BedroomWildTargetKey, number> {
  const totalCount = Math.max(1, count);
  const allocations: Record<BedroomWildTargetKey, number> = {
    bedroom: 1,
    kids_bedroom: 0,
    office: 0,
  };

  for (let remaining = totalCount - 1; remaining > 0; remaining -= 1) {
    const roomKey: BedroomWildTargetKey = pickRandom(BEDROOM_WILD_TARGET_KEYS);
    allocations[roomKey] += 1;
  }

  return allocations;
}

function describeBedroomWildTarget(roomKey: BedroomWildTargetKey): string {
  switch (roomKey) {
    case "bedroom":
      return "卧室";
    case "kids_bedroom":
      return "儿童卧室";
    case "office":
      return "办公室";
  }
}

function expandConcreteSubRooms(
  suiteId: string,
  subRoomKey: string,
  description: string,
  count: number,
): Array<readonly [string, BuildingSubRoom]> {
  return rangeCount(count).map((index) => {
    const roomId = `${suiteId}/${toIndexedSubRoomId(subRoomKey, index, count)}`;
    return [roomId, {
      roomId,
      description,
    } satisfies BuildingSubRoom] as const;
  });
}


function normalizeCount(count: number | undefined): number {
  if (!Number.isFinite(count) || !count || count < 1) {
    return 1;
  }

  return Math.floor(count);
}

function rangeCount(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index + 1);
}

function toIndexedSubRoomId(roomKey: string, index: number, count: number): string {
  return count > 1 ? `${roomKey}_idx${index}` : `${roomKey}`;
}

function toIndexedRoomId(level: number, roomKey: string, index: number, count: number): string {
  return count > 1 ? `${roomKey}_lvl${level}_idx${index}` : `lvl${level}_${roomKey}`;
}

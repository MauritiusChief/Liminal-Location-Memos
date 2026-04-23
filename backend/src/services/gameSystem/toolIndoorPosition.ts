import { query } from "@/db/client.js";
import { FeatureId } from "../featureDetail.js";
import { BuildingSchema, RoomSchema, SuiteSchema, generateBuildingSchema, pickRandom } from "./buildingClassifier.js";
import { GameState, PlayerIndoorLocation, PlayerVisibleLocation, Position } from "./gameSessionStore.js";

export interface BuildingRecord {
  featureId: string;
  category: string;
  centerPosition: Position;
  levels: Record<number, BuildingLevel>; // key 为楼层数号
}

interface BuildingLevel {
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
 */
export interface BuildingSubRoom {
  roomId: string;
  description: string;
}

export interface IndoorRoomContext {
  level: number;
  sectorName: string;
  locationType: "room" | "suite" | "subRoom";
  suiteId?: string;
  suiteDescription?: string;
  roomId?: string;
  roomDescription?: string;
}

interface DbContainingBuildingRow {
  feature_id: string | null;
}

//#region 主函数

/**
 * 根据玩家坐标查找所处建筑。
 *
 * 若返回 feature id，说明开局应走室内分支；
 * 若没有结果，则保持室外开局。
 * @param position
 * @returns 命中的 building feature id，或者 null
 */
export async function findContainingBuildingFeatureId(position: Position): Promise<FeatureId | null> {
  const sql = `
SELECT b.osm_type || '/' || b.osm_id AS feature_id
FROM osm_buildings b
WHERE ST_Covers(b.geom, ST_SetSRID(ST_MakePoint($1, $2), 4326))
LIMIT 1;
`;
  const result = await query<DbContainingBuildingRow>(sql, [position.lon, position.lat]);
  const featureId = result.rows[0]?.feature_id;
  return featureId || null;
}

/**
 * 针对某建筑，获取存储在 GameState 中的 Building Schema 或者生成所需的 Building Schema。
 * @param featureId
 * @param state
 */
export async function ensureBuildingSchema(featureId: FeatureId, state: GameState): Promise<BuildingSchema> {
  const existing = state.buildingSchemas[featureId];
  if (existing) {
    return existing;
  }

  const generated = await generateBuildingSchema(featureId, Object.values(state.buildingSchemas));
  if (!generated) {
    throw new Error(`Failed to generate building schema for ${featureId}.`);
  }

  Object.assign(state.buildingSchemas, generated);

  const resolved = state.buildingSchemas[featureId]
    ?? (Object.keys(generated).length === 1 ? Object.values(generated)[0] : undefined);
  if (!resolved) {
    throw new Error(`Generated building schema does not contain ${featureId}.`);
  }

  return resolved;
}

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
    levels,
  };
}

/**
 * 为开局选择一个可实际停留的室内位置。
 * suite 只是逻辑概念，因此候选只包含普通房间与 suite 内的 subRoom。
 * @param record
 * @returns
 */
export function chooseInitialIndoorLocation(record: BuildingRecord): PlayerIndoorLocation {
  const levels = Object.values(record.levels);
  if (levels.length === 0) {
    throw new Error(`Building record ${record.featureId} has no levels.`);
  }

  const level = pickRandom(levels);
  const sectors = Object.values(level.sectors);
  if (sectors.length === 0) {
    throw new Error(`Building record ${record.featureId} level ${level.level} has no sectors.`);
  }

  const sector = pickRandom(sectors);
  const roomContexts = listSectorInteractiveContexts(level.level, sector);
  if (roomContexts.length === 0) {
    throw new Error(`Building record ${record.featureId} level ${level.level} sector ${sector.name} has no occupiable rooms.`);
  }

  const chosen = pickRandom(roomContexts);
  return {
    buildingId: record.featureId,
    level: chosen.level,
    ...(chosen.suiteId ? { suiteId: chosen.suiteId } : {}),
    roomId: chosen.roomId!,
  };
}

/**
 * 反查玩家当前所处位置的楼层、sector 和 suite 上下文。
 * 这样 world state、可见范围和 sector VD 激活都能共用同一套定位结果。
 * @param record
 * @param location
 * @returns
 */
export function findIndoorLocationContext(
  record: BuildingRecord,
  location: PlayerIndoorLocation,
): IndoorRoomContext | null {
  const level = record.levels[location.level];
  if (!level) {
    return null;
  }

  for (const sector of Object.values(level.sectors)) {
    const roomContext = listSectorInteractiveContexts(location.level, sector)
      .find((entry) => (
        entry.roomId === location.roomId
        && entry.suiteId === location.suiteId
      ));
    if (roomContext) {
      return roomContext;
    }
  }

  return null;
}

/**
 * 反查某个可见位置实际对应的上下文。
 * 可见位置既可能是普通房间，也可能是 suite 容器，或者 suite 内某个 subRoom。
 * @param record
 * @param location
 * @returns
 */
export function findVisibleLocationContext(
  record: BuildingRecord,
  location: PlayerVisibleLocation,
): IndoorRoomContext | null {
  const level = record.levels[location.level];
  if (!level) {
    return null;
  }

  for (const sector of Object.values(level.sectors)) {
    const visibleContext = listSectorVisibleContexts(location.level, sector)
      .find((entry) => (
        entry.suiteId === location.suiteId
        && entry.roomId === location.roomId
      ));
    if (visibleContext) {
      return visibleContext;
    }
  }

  return null;
}

/**
 * 根据当前玩家室内位置生成基板 active visible locations。
 * 当前最小规则只暴露所在 sector 内的普通房间与 suite 外部。
 * @param state
 * @returns
 */
export function fillBasicActiveIndoorLocations(state: GameState): void {
  const location = state.playerIndoorLocation;
  if (!location) {
    state.activeVisibleLocations = [];
    return;
  }

  const record = state.buildingRecords[location.buildingId];
  if (!record) {
    throw new Error(`Missing building record for ${location.buildingId}.`);
  }

  const roomContext = findIndoorLocationContext(record, location);
  if (!roomContext) {
    throw new Error(`Room ${location.roomId} is not present in building ${location.buildingId}.`);
  }

  const sector = record.levels[roomContext.level]?.sectors[roomContext.sectorName];
  if (!sector) {
    throw new Error(`Sector ${roomContext.sectorName} is not present in building ${location.buildingId} level ${roomContext.level}.`);
  }

  state.activeVisibleLocations = listSectorVisibleLocations(location.buildingId, roomContext.level, sector);
}

//#region 帮助函数

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
      rooms: expandSectorRooms(sector.rooms),
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
  rooms: Record<string, RoomSchema | SuiteSchema>,
): Record<string, BuildingRoom | BuildingSuite> {
  const expandedEntries: Array<readonly [string, BuildingRoom | BuildingSuite]> = [];
  Object.entries(rooms).forEach(([roomKey, room]) => {
    if ("subRooms" in room) {
      const suiteCount = normalizeCount(room.count);
      rangeCount(suiteCount).forEach((index) => {
        const suiteId = toIndexedRoomId(roomKey, index, suiteCount);
        expandedEntries.push([suiteId, {
          suiteId,
          description: room.description,
          subRooms: expandSuiteSubRooms(suiteId, room.subRooms),
        }]);
      });
      return;
    }

    const roomCount = normalizeCount(room.count);
    rangeCount(roomCount).forEach((index) => {
      const roomId = toIndexedRoomId(roomKey, index, roomCount);
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
 * @param suiteId
 * @param subRooms
 * @returns
 */
function expandSuiteSubRooms(
  suiteId: string,
  subRooms: SuiteSchema["subRooms"],
): Record<string, BuildingSubRoom> {
  const expandedEntries = Object.entries(subRooms).flatMap(([subRoomKey, subRoom]) => {
    const subRoomCount = normalizeCount(subRoom.count);
    return rangeCount(subRoomCount).map((index) => {
      const roomId = `${suiteId}/${toIndexedRoomId(subRoomKey, index, subRoomCount)}`;
      return [roomId, {
        roomId,
        description: subRoom.description,
      } satisfies BuildingSubRoom] as const;
    });
  });

  return Object.fromEntries(expandedEntries);
}

/**
 * 把某 sector 内部所有的房间收拾为扁平化的 list
 * @param level
 * @param sector
 * @returns
 */
function listSectorInteractiveContexts(level: number, sector: BuildingSector): IndoorRoomContext[] {
  const contexts: IndoorRoomContext[] = [];
  Object.entries(sector.rooms).forEach(([roomKey, room]) => {
    if ("subRooms" in room) {
      Object.values(room.subRooms).forEach((subRoom) => {
        contexts.push({
          level,
          sectorName: sector.name,
          locationType: "subRoom",
          roomId: subRoom.roomId,
          roomDescription: subRoom.description,
          suiteId: roomKey,
          suiteDescription: room.description,
        });
      });
      return;
    }

    contexts.push({
      level,
      sectorName: sector.name,
      locationType: "room",
      roomId: room.roomId,
      roomDescription: room.description,
    });
  });

  return contexts;
}

function listSectorVisibleContexts(level: number, sector: BuildingSector): IndoorRoomContext[] {
  const contexts: IndoorRoomContext[] = [];
  Object.values(sector.rooms).forEach((room) => {
    if ("subRooms" in room) {
      contexts.push({
        level,
        sectorName: sector.name,
        locationType: "suite",
        suiteId: room.suiteId,
        suiteDescription: room.description,
      });
      return;
    }

    contexts.push({
      level,
      sectorName: sector.name,
      locationType: "room",
      roomId: room.roomId,
      roomDescription: room.description,
    });
  });

  return contexts;
}

/**
 * 生成当前 sector 的基板可见范围：
 * - 普通房间直接公开 roomId；
 * - suite 只公开 suiteId，默认不自动公开内部 subRoom。
 * @param buildingId
 * @param level
 * @param sector
 * @returns
 */
export function listSectorVisibleLocations(
  buildingId: FeatureId,
  level: number,
  sector: BuildingSector,
): PlayerVisibleLocation[] {
  return listSectorVisibleContexts(level, sector).map((context) => ({
    buildingId,
    level: context.level,
    ...(context.suiteId ? { suiteId: context.suiteId } : {}),
    ...(context.locationType === "room" && context.roomId ? { roomId: context.roomId } : {}),
  }));
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

function toIndexedRoomId(roomKey: string, index: number, count: number): string {
  return count > 1 ? `${roomKey}_${index}` : roomKey;
}

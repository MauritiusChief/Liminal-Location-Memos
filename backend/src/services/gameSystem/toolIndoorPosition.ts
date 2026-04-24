import { query } from "@/db/client.js";
import { loadServiceSql } from "@/db/sqlLoader.js";
import { DbBuildingFeatureDetailRow, FeatureId, mapBuildingDetailRowToFeatureDetail } from "../featureDetail.js";
import { BuildingSchema, RoomSchema, SuiteSchema, generateBuildingSchema, pickRandom } from "./buildingClassifier.js";
import { GameState, PlayerIndoorLocation, PlayerVisibleLocation, Position } from "./gameSessionStore.js";

export interface BuildingRecord {
  featureId: string;
  category: string;
  centerPosition: Position;
  tags: Record<string, string>;
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

interface DbContainingBuildingRow extends DbBuildingFeatureDetailRow {
  center_lon: number;
  center_lat: number;
}

export interface ContainingBuildingSnapshot {
  featureId: FeatureId;
  tags: Record<string, string>;
}

const BEDROOM_WILD_KEY = "bedroom_wild";
type BedroomWildTargetKey = "bedroom" | "kids_bedroom" | "office";
const BEDROOM_WILD_TARGET_KEYS: BedroomWildTargetKey[] = ["bedroom", "kids_bedroom", "office"];

//#region 主函数

const fetchBuildingTagsByPositionSqlPromise = loadServiceSql("gameSystem/sql/fetchBuildingTagsByPosition.sql");

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
  // 此处过滤所有抽象套房
  const roomContexts = listSectorIndoorRoomContexts(level.level, sector).filter(room => room.locationType !== 'suite');
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

export function chooseBuildingEntranceIndoorLocation(record: BuildingRecord): PlayerIndoorLocation {
  const firstLevel = record.levels[1];
  if (!firstLevel) {
    return chooseInitialIndoorLocation(record);
  }

  const entranceRooms = Object.values(firstLevel.sectors)
    .flatMap((sector) => listSectorIndoorRoomContexts(1, sector))
    .filter((entry): entry is IndoorRoomContext & { roomId: string } => (
      entry.locationType === "room"
      && Boolean(entry.roomId)
      && getRoomAccess(record, entry) === "entrance"
    ));
  if (entranceRooms.length > 0) {
    const chosen = pickRandom(entranceRooms);
    return {
      buildingId: record.featureId,
      level: 1,
      roomId: chosen.roomId,
    };
  }

  const nonSubRooms = Object.values(firstLevel.sectors)
    .flatMap((sector) => listSectorIndoorRoomContexts(1, sector))
    .filter((entry) => entry.locationType !== "subRoom");
  if (nonSubRooms.length === 0) {
    return chooseInitialIndoorLocation(record);
  }

  const chosen = pickRandom(nonSubRooms);
  if (chosen.locationType === "room" && chosen.roomId) {
    return {
      buildingId: record.featureId,
      level: 1,
      roomId: chosen.roomId,
    };
  }

  if (chosen.locationType === "suite" && chosen.suiteId) {
    const level = record.levels[1];
    const sector = level?.sectors[chosen.sectorName];
    const suite = sector?.rooms[chosen.suiteId];
    if (suite && "subRooms" in suite) {
      const subRooms = Object.values(suite.subRooms);
      if (subRooms.length > 0) {
        const pickedSubRoom = pickRandom(subRooms);
        return {
          buildingId: record.featureId,
          level: 1,
          suiteId: chosen.suiteId,
          roomId: pickedSubRoom.roomId,
        };
      }
    }
  }

  return chooseInitialIndoorLocation(record);
}

/**
 * 反查玩家当前所处位置的楼层、sector 和 suite 上下文。
 * 这样 world state、可见范围和 sector VD 激活都能共用同一套定位结果。
 * @param record
 * @param location 兼容 PlayerIndoorLocation 和 PlayerVisibleLocation
 * @returns
 */
export function findLocationContext(
  record: BuildingRecord,
  location: PlayerIndoorLocation | PlayerVisibleLocation,
): IndoorRoomContext | null {
  const level = record.levels[location.level];
  if (!level) {
    return null;
  }

  for (const sector of Object.values(level.sectors)) {
    const roomContext = listSectorIndoorRoomContexts(location.level, sector)
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
 * 根据当前玩家室内位置生成基板 active visible locations。
 * 在普通房间时只可见所在 sector 内的普通房间与 suite 外部，在 suite 时则只有子房间可见。
 * @param state
 * @returns
 */
export function fillBasicActiveIndoorLocations(state: GameState): void {
  state.activeVisibleLocations = buildBasicActiveIndoorLocations(state);
}

export function buildBasicActiveIndoorLocations(state: GameState): PlayerVisibleLocation[] {
  const location = state.playerIndoorLocation;
  if (!location) {
    return [];
  }

  const record = state.buildingRecords[location.buildingId];
  if (!record) {
    throw new Error(`Missing building record for ${location.buildingId}.`);
  }

  // TODO 反查逻辑也许不需要？可改成 location 存储足够的信息
  const roomContext = findLocationContext(record, location);
  if (!roomContext) {
    throw new Error(`Room ${location.roomId} is not present in building ${location.buildingId}.`);
  }

  const sector = record.levels[roomContext.level]?.sectors[roomContext.sectorName];
  if (!sector) {
    throw new Error(`Sector ${roomContext.sectorName} is not present in building ${location.buildingId} level ${roomContext.level}.`);
  }

  if (roomContext.locationType === "subRoom" && roomContext.suiteId) { // 套房内则只可见内部子房间
    const locatedSuiteSubRooms = listSuiteSubRoomVisibleLocations(location.buildingId, roomContext.level, sector, roomContext.suiteId);
    return dedupeVisibleLocations(locatedSuiteSubRooms);
  } else { // 否则是默认生成的基板 activePlayerVisibleLocations
    const basicVisibleLocations = listSectorVisibleLocations(location.buildingId, roomContext.level, sector);
    return dedupeVisibleLocations(basicVisibleLocations);
  }
}

type IndoorLocationMove = "enter" | "leave" | "move";
type IndoorVisibleEdit = "reveal" | "hide";

export async function applySetPlayerIndoorLocationTool(
  state: GameState,
  args: any,
): Promise<void> {
  const move = typeof args?.move === "string" ? args.move : "";
  if (move !== "enter" && move !== "leave" && move !== "move") {
    return;
  }

  if (move === "leave") {
    state.playerIndoorLocation = null;
    state.activeVisibleLocations = [];
    return;
  }

  if (move === "enter") {
    if (typeof args?.buildingId !== "string" || !args.buildingId) {
      return;
    }

    const record = await ensureBuildingRecord(args.buildingId, state);
    state.playerIndoorLocation = chooseBuildingEntranceIndoorLocation(record);
    return;
  }

  if (!state.playerIndoorLocation) {
    return;
  }

  const targetBuildingId = typeof args?.buildingId === "string" && args.buildingId
    ? args.buildingId
    : state.playerIndoorLocation.buildingId;
  const level = Number(args?.level);
  const roomId = typeof args?.roomId === "string" ? args.roomId : "";
  const suiteId = typeof args?.suiteId === "string" && args.suiteId ? args.suiteId : undefined;
  if (!Number.isFinite(level) || !roomId) {
    return;
  }

  const record = await ensureBuildingRecord(targetBuildingId, state);
  const targetLocation = resolveOccupiableIndoorLocation(record, {
    buildingId: targetBuildingId,
    level,
    suiteId,
    roomId,
  });
  if (!targetLocation) {
    return;
  }

  state.playerIndoorLocation = targetLocation;
}

export function applySyncActiveIndoorLocationsTool(state: GameState, args: any): void {
  const location = state.playerIndoorLocation;
  if (!location) {
    return;
  }

  const edit = typeof args?.edit === "string" ? args.edit : "";
  if (edit !== "reveal" && edit !== "hide") {
    return;
  }

  const level = Number(args?.level);
  const suiteId = typeof args?.suiteId === "string" && args.suiteId ? args.suiteId : undefined;
  const roomId = typeof args?.roomId === "string" && args.roomId ? args.roomId : undefined;
  if (!Number.isFinite(level)) {
    return;
  }

  const record = state.buildingRecords[location.buildingId];
  if (!record) {
    return;
  }

  const targetLocation = resolveVisibleIndoorLocation(record, {
    buildingId: location.buildingId,
    level,
    suiteId,
    roomId,
  });
  if (!targetLocation) {
    return;
  }

  if (edit === "reveal") {
    state.activeVisibleLocations = dedupeVisibleLocations([
      ...state.activeVisibleLocations,
      targetLocation,
    ]);
    return;
  }

  const currentKey = toVisibleLocationKey(location);
  const targetKey = toVisibleLocationKey(targetLocation);
  if (currentKey === targetKey) {
    return;
  }

  state.activeVisibleLocations = state.activeVisibleLocations
    .filter((entry) => toVisibleLocationKey(entry) !== targetKey);
}

export function formatBuildingRecordPrompt(record: BuildingRecord): string {
  const levelLines = Object.values(record.levels)
    .sort((left, right) => left.level - right.level)
    .flatMap((level) => {
      const sectorLines = Object.values(level.sectors).flatMap((sector) => {
        const roomLines = Object.values(sector.rooms).flatMap((room) => {
          if ("subRooms" in room) {
            const subRoomLines = Object.values(room.subRooms)
              .map((subRoom) => `      - subRoom ${subRoom.roomId}: ${subRoom.description}`);
            return [
              `    - suite ${room.suiteId}: ${room.description}`,
              ...subRoomLines,
            ];
          }

          const access = room.access ? ` [access=${room.access}]` : "";
          return [`    - room ${room.roomId}: ${room.description}${access}`];
        });

        return [
          `  - sector ${sector.name} (area=${sector.area}, center=(${sector.centerPosition.lat}, ${sector.centerPosition.lon}))`,
          ...roomLines,
        ];
      });

      return [
        `- level ${level.level}: ${level.description}`,
        ...sectorLines,
      ];
    });

  return [
    `buildingId=${record.featureId}`,
    `category=${record.category}`,
    `center=(${record.centerPosition.lat}, ${record.centerPosition.lon})`,
    `tags=${JSON.stringify(record.tags)}`,
    "levels:",
    ...levelLines,
  ].join("\n");
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
    // TODO 目前只有一种通配房间
    if (subRoomKey === BEDROOM_WILD_KEY) {
      return expandBedroomWildSubRooms(suiteId, normalizeCount(subRoom.count));
    }

    return expandConcreteSubRooms(suiteId, subRoomKey, subRoom.description, normalizeCount(subRoom.count));
  });

  return Object.fromEntries(expandedEntries);
}

//#region 扁平化函数

/**
 * 把某 sector 内部所有的房间（包括套房子房间和套房本身）收拾为扁平化的 list
 * 使用前一定需要根据用途（需不需要套房本身呈现）过滤结果
 * @param level
 * @param sector
 * @returns 包括套房子房间和套房本身在内的所有房间
 */
function listSectorIndoorRoomContexts(level: number, sector: BuildingSector): IndoorRoomContext[] {
  const contexts: IndoorRoomContext[] = [];
  Object.entries(sector.rooms).forEach(([roomKey, room]) => {
    if ("subRooms" in room) {
      // 套房本体
      contexts.push({
        level,
        sectorName: sector.name,
        locationType: "suite",
        suiteId: room.suiteId,
        suiteDescription: room.description,
      });
      // 套房内部所有子房间
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
    // 普通房间
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
 * @returns 默认不公开内部 subRoom 的基板 activePlayerVisibleLocations
 */
export function listSectorVisibleLocations(
  buildingId: FeatureId,
  level: number,
  sector: BuildingSector,
): PlayerVisibleLocation[] {
  return listSectorIndoorRoomContexts(level, sector)
  .filter(room => room.locationType !== 'subRoom') // 默认不公开 subRoom
    .map((context) => ({
      buildingId,
      level: context.level,
      ...(context.suiteId ? { suiteId: context.suiteId } : {}),
      ...(context.locationType === "room" && context.roomId ? { roomId: context.roomId } : {}),
    }));
}

/**
 * 列出某套房内部所有的子房间
 * @param buildingId
 * @param level
 * @param sector
 * @param suiteId
 * @returns
 */
function listSuiteSubRoomVisibleLocations(
  buildingId: FeatureId,
  level: number,
  sector: BuildingSector,
  suiteId: string,
): PlayerVisibleLocation[] {
  const suite = sector.rooms[suiteId];
  if (!suite || !("subRooms" in suite)) {
    return [];
  }

  return Object.values(suite.subRooms).map((subRoom) => ({
    buildingId,
    level,
    suiteId,
    roomId: subRoom.roomId,
  }));
}

//#region 辅助函数

function dedupeVisibleLocations(locations: PlayerVisibleLocation[]): PlayerVisibleLocation[] {
  const seen = new Set<string>();
  return locations.filter((location) => {
    const key = [
      location.buildingId,
      String(location.level),
      location.suiteId ?? "",
      location.roomId ?? "",
    ].join("|");
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function resolveVisibleIndoorLocation(
  record: BuildingRecord,
  location: PlayerVisibleLocation,
): PlayerVisibleLocation | null {
  const context = findLocationContext(record, location);
  if (!context) {
    return null;
  }

  if (context.locationType === "suite") {
    return {
      buildingId: record.featureId,
      level: context.level,
      suiteId: context.suiteId,
    };
  }

  if (!context.roomId) {
    return null;
  }

  return {
    buildingId: record.featureId,
    level: context.level,
    ...(context.suiteId ? { suiteId: context.suiteId } : {}),
    roomId: context.roomId,
  };
}

export function resolveOccupiableIndoorLocation(
  record: BuildingRecord,
  location: PlayerVisibleLocation,
): PlayerIndoorLocation | null {
  const context = findLocationContext(record, location);
  if (!context || context.locationType === "suite" || !context.roomId) {
    return null;
  }

  return {
    buildingId: record.featureId,
    level: context.level,
    ...(context.suiteId ? { suiteId: context.suiteId } : {}),
    roomId: context.roomId,
  };
}

function getRoomAccess(record: BuildingRecord, context: IndoorRoomContext): BuildingRoom["access"] | undefined {
  if (context.locationType !== "room" || !context.roomId) {
    return undefined;
  }

  const level = record.levels[context.level];
  const sector = level?.sectors[context.sectorName];
  if (!sector) {
    return undefined;
  }

  const room = Object.values(sector.rooms)
    .find((entry): entry is BuildingRoom => !("subRooms" in entry) && entry.roomId === context.roomId);
  return room?.access;
}

function toVisibleLocationKey(location: PlayerVisibleLocation): string {
  return [
    location.buildingId,
    String(location.level),
    location.suiteId ?? "",
    location.roomId ?? "",
  ].join("|");
}

/**
 * wildcard 只在 BuildingRecord 展开阶段实例化，不回写 BuildingSchema。
 * `bedroom_wild` 的 count 是共享预算，至少保留 1 个普通卧室，剩余额度再随机分给儿童卧室与办公室。
 */
function expandBedroomWildSubRooms(
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
    const roomId = `${suiteId}/${toIndexedRoomId(subRoomKey, index, count)}`;
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

function toIndexedRoomId(roomKey: string, index: number, count: number): string {
  return count > 1 ? `${roomKey}_${index}` : roomKey;
}

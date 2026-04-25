import { query } from "@/db/client.js";
import { loadServiceSql } from "@/db/sqlLoader.js";
import { DbBuildingFeatureDetailRow, FeatureId, mapBuildingDetailRowToFeatureDetail } from "../featureDetail.js";
import { BuildingSchema, generateBuildingSchema } from "./buildingSchema.js";
import { GameState, PlayerIndoorLocation, PlayerVisibleLocation, Position } from "./gameSessionStore.js";
import { BuildingRecord, BuildingRoom, BuildingSector, generateBuildingRecord } from "./buildingRecord.js";
import { pickRandom } from "../utils.js";

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
 * 实际被呼叫的函数
 * @param state
 * @param args
 * @returns
 */
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

//#region 内部逻辑函数

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
    sectorName: chosen.sectorName,
    locationType: chosen.locationType,
    ...(chosen.suiteId ? { suiteId: chosen.suiteId, suiteDescription: chosen.suiteDescription } : {}),
    roomId: chosen.roomId!,
    roomDescription: chosen.roomDescription,
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
      sectorName: chosen.sectorName,
      locationType: chosen.locationType,
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

//#region 扁平化函数

/**
 * 把某 sector 内部所有的房间（包括套房子房间和套房本身）收拾为扁平化的 list
 * 使用前一定需要根据用途（需不需要套房本身呈现）过滤结果
 * @param level
 * @param sector
 * @returns 包括套房子房间和套房本身在内的所有房间
 */
export function listSectorIndoorRoomContexts(level: number, sector: BuildingSector): IndoorRoomContext[] {
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
      sectorName: sector.name,
      locationType: context.locationType,
      ...(
        context.suiteId
        ? {suiteId: context.suiteId, suiteDescription: context.suiteDescription}
        : {}
      ),
      ...(
        context.locationType === "room" && context.roomId
        ? { roomId: context.roomId, roomDescription: context.roomDescription }
        : {}
      ),
    }));
}

//#region 辅助函数

export function dedupeVisibleLocations(locations: PlayerVisibleLocation[]): PlayerVisibleLocation[] {
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

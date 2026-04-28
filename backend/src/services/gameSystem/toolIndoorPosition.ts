import { FeatureId } from "../featureDetail.js";
import { GameState, PlayerIndoorLocation, PlayerVisibleLocation, Position } from "./gameSessionStore.js";
import { BuildingLevel, BuildingRecord, BuildingRoom, BuildingSector, ensureBuildingRecord } from "./buildingRecord.js";
import { pickRandom } from "../utils.js";

/**
 * suiteId 和 roomId 均可选，因此可以表示单纯的套房概念本身的同时也可以表示房间
 */
export interface IndoorRoomContext {
  level: number;
  sectorName: string;
  locationType: "room" | "suite" | "subRoom";
  suiteId?: string;
  suiteDescription?: string;
  roomId?: string;
  roomDescription?: string;
}

//#region 主函数

/**
 * 实际执行的设置玩家位置的函数
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
    // 自动选取一楼入口
    const record = await ensureBuildingRecord(args.buildingId, state);
    state.playerIndoorLocation = chooseBuildingEntranceIndoorLocation(record);
    console.log(`[${new Date().toISOString()}] 位置工具尝试抵达一楼入口，实际位置${state.playerIndoorLocation}`);
    return;
  }

  if (!state.playerIndoorLocation) {
    return;
  }

  const targetBuildingId = typeof args?.buildingId === "string" && args.buildingId
    ? args.buildingId
    : state.playerIndoorLocation.buildingId;
  const record = await ensureBuildingRecord(targetBuildingId, state);
  const level = Number(args?.level);
  // const sectorName = typeof args?.sectorName === "string" ? args.sectorName : "";
  const roomId = typeof args?.roomId === "string" ? args.roomId : "";
  const suiteId = typeof args?.suiteId === "string" && args.suiteId ? args.suiteId : undefined;
  if (!Number.isFinite(level) || !roomId) {
    // 自动选择 level 此楼层的垂直通道
    state.playerIndoorLocation = chooseLevelVirtialAccessIndoorLocation(args.buildingId, record.levels[level])
    console.log(`[${new Date().toISOString()}] 位置工具尝试抵达${level}楼，实际位置${state.playerIndoorLocation}`);
    return;
  }

  const targetLocation = findLocationContext(record, level, suiteId, roomId)
  if (!targetLocation) return
  console.log(`[${new Date().toISOString()}] 尝试使用位置工具，实际位置${state.playerIndoorLocation}`);
  state.playerIndoorLocation = targetLocation;
}

/**
 * 反查玩家当前所处位置的楼层、sector 和 suite 上下文。
 * @param record
 * @param levelCode
 * @param suiteId
 * @param roomId
 * @returns
 */
export function findLocationContext(
  record: BuildingRecord,
  levelCode: number,
  suiteId: string,
  roomId: string,
): PlayerIndoorLocation | null {
  const level = record.levels[levelCode];
  if (!level) {
    return null;
  }

  for (const sector of Object.values(level.sectors)) {
    const roomContext = listSectorIndoorRoomContexts(levelCode, sector)
      .find((entry) => (
        entry.roomId === roomId
        && entry.suiteId === suiteId
      ));
    if (roomContext) {
      return {
        buildingId: record.featureId,
        roomId,
        roomDescription: roomContext.roomDescription || "",
        ...roomContext
      };
    }
  }

  return null;
}

//#region 内部逻辑函数

/**
 * 寻找带入口的房间，若没有则在1楼随机选择一个房间
 * @param record
 * @returns
 */
export function chooseBuildingEntranceIndoorLocation(record: BuildingRecord): PlayerIndoorLocation {
  const firstLevel = record.levels[1];
  if (!firstLevel) {
    return chooseRandomIndoorLocation(record);
  }
  // 优先选取一楼带入口的房间
  const entranceRooms = Object.values(firstLevel.sectors)
    .flatMap((sector) => listSectorIndoorRoomContexts(1, sector))
    .filter((entry): entry is IndoorRoomContext & { roomId: string } => (
      entry.locationType === "room"
      && Boolean(entry.roomId)
      && getRoomAccessInBuilding(record, entry) === "entrance"
    ));
  if (entranceRooms.length > 0) {
    const chosen = pickRandom(entranceRooms);
    return {
      buildingId: record.featureId,
      level: 1,
      sectorName: chosen.sectorName,
      locationType: chosen.locationType,
      roomId: chosen.roomId,
      roomDescription: chosen.roomDescription ?? ""
    };
  }
  // 若无则在1楼随机选择
  return chooseRandomLevelIndoorLocation(record.featureId, firstLevel);
}

/**
 * 寻找给定楼层带垂直通道的的房间，若无则在此楼层随机选择一个房间
 * @param featureId
 * @param level
 * @returns
 */
export function chooseLevelVirtialAccessIndoorLocation(featureId: FeatureId, level: BuildingLevel): PlayerIndoorLocation {
  const accessRooms = Object.values(level)
    .filter((entry): entry is IndoorRoomContext & { roomId: string} => (
      entry.locationType === "room"
      && Boolean(entry.roomId)
      && getRoomAccessInLevel(level, entry) === "vertical"
    ))
  if (accessRooms.length > 0) {
    const chosen = pickRandom(accessRooms);
    return {
      buildingId: featureId,
      level: 1,
      sectorName: chosen.sectorName,
      locationType: chosen.locationType,
      roomId: chosen.roomId,
      roomDescription: chosen.roomDescription ?? ""
    };
  }
  // 随机选择
  return chooseRandomLevelIndoorLocation(featureId, level);
}

/**
 * 在整个建筑中随机选择一个可实际停留的室内位置。
 * suite 只是逻辑概念，因此候选只包含普通房间与 suite 内的 subRoom。
 * @param record
 * @returns
 */
export function chooseRandomIndoorLocation(record: BuildingRecord): PlayerIndoorLocation {
  const levels = Object.values(record.levels);
  if (levels.length === 0) {
    throw new Error(`Building record ${record.featureId} has no levels.`);
  }

  const level = pickRandom(levels);

  return chooseRandomLevelIndoorLocation(record.featureId, level)
}

/**
 * 在给定楼层中随机选择一个可实际停留的室内位置。
 * suite 只是逻辑概念，因此候选只包含普通房间与 suite 内的 subRoom。
 * @param level
 * @param record
 */
function chooseRandomLevelIndoorLocation(featureId: FeatureId, level: BuildingLevel): PlayerIndoorLocation {
  const sectors = Object.values(level.sectors);
  if (sectors.length === 0) {
    throw new Error(`Building record ${featureId} level ${level.level} has no sectors.`);
  }

  const sector = pickRandom(sectors);
  // 此处过滤所有抽象套房
  const roomContexts = listSectorIndoorRoomContexts(level.level, sector).filter(room => room.locationType !== 'suite');
  if (roomContexts.length === 0) {
    throw new Error(`Building record ${featureId} level ${level.level} sector ${sector.name} has no occupiable rooms.`);
  }

  const chosen = pickRandom(roomContexts);
  return {
    buildingId: featureId,
    level: chosen.level,
    sectorName: chosen.sectorName,
    locationType: chosen.locationType,
    ...(chosen.suiteId ? { suiteId: chosen.suiteId, suiteDescription: chosen.suiteDescription } : {}),
    roomId: chosen.roomId!,
    roomDescription: chosen.roomDescription ?? "",
  };
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

function getRoomAccessInBuilding(record: BuildingRecord, context: IndoorRoomContext): BuildingRoom["access"] | undefined {
  if (context.locationType !== "room" || !context.roomId) {
    return undefined;
  }

  const level = record.levels[context.level];
  return getRoomAccessInLevel(level, context)
}

function getRoomAccessInLevel(level: BuildingLevel, context: IndoorRoomContext): BuildingRoom["access"] | undefined {
  const sector = level?.sectors[context.sectorName];
  if (!sector) {
    return undefined;
  }

  const room = Object.values(sector.rooms)
    .find((entry): entry is BuildingRoom => !("subRooms" in entry) && entry.roomId === context.roomId);
  return room?.access;
}

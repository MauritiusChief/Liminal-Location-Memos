import { FeatureId } from "../featureDetail.js";
import { BuildingSector } from "./buildingRecord.js";
import { GameState, PlayerVisibleLocation } from "./gameSessionStore.js";
import { dedupeVisibleLocations, findLocationContext, listSectorVisibleLocations } from "./toolIndoorPosition.js";


/**
 * 更新玩家可见范围的函数
 * @param state
 * @param args
 * @returns
 */
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
  if (!Number.isFinite(level)) return

  const record = state.buildingRecords[location.buildingId];
  if (!record) return

  const targetLocation = findLocationContext(record, level, suiteId, roomId)
  if (!targetLocation) return

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

/**
 * 根据当前玩家室内位置生成基板 active visible locations。
 * 在普通房间时只可见所在 sector 内的普通房间与 suite 外部，在 suite 时则只有子房间可见。
 * @param state
 */
export function fillBasicActiveIndoorLocations(state: GameState): void {
  const location = state.playerIndoorLocation;
  if (!location) return

  const record = state.buildingRecords[location.buildingId];

  const sector = record.levels[location.level]?.sectors[location.sectorName];

  if (location.locationType === "subRoom" && location.suiteId) { // 套房内则只可见内部子房间
    const locatedSuiteSubRooms = listSuiteSubRoomVisibleLocations(location.buildingId, location.level, sector, location.suiteId);
    state.activeVisibleLocations = dedupeVisibleLocations(locatedSuiteSubRooms);
  } else { // 否则是默认生成的基板 activePlayerVisibleLocations
    const basicVisibleLocations = listSectorVisibleLocations(location.buildingId, location.level, sector);
    state.activeVisibleLocations = dedupeVisibleLocations(basicVisibleLocations);
  }
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
    sectorName: sector.name,
    locationType: 'subRoom',
    suiteId,
    suiteDescription: suite.description,
    roomId: subRoom.roomId,
    roomDescription: subRoom.description,
  }));
}

function toVisibleLocationKey(location: PlayerVisibleLocation): string {
  return [
    location.buildingId,
    String(location.level),
    location.suiteId ?? "",
    location.roomId ?? "",
  ].join("|");
}

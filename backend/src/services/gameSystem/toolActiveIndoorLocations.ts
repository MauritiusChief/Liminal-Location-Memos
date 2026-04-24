import { GameState, PlayerVisibleLocation } from "./gameSessionStore.js";
import { dedupeVisibleLocations, resolveVisibleIndoorLocation } from "./toolIndoorPosition.js";


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
function toVisibleLocationKey(location: PlayerVisibleLocation): string {
  return [
    location.buildingId,
    String(location.level),
    location.suiteId ?? "",
    location.roomId ?? "",
  ].join("|");
}

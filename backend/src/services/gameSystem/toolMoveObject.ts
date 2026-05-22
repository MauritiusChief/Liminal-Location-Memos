import { randomUUID } from "node:crypto";
import { findRoomInBuilding } from "../buildingGeneration/buildingRecord.js";
import type { GameState } from "./gameSessionStore.js";
import type { GeneralContent } from "../objectGeneration/objectGeneraterShared.js";
import type { CardboardFurnitureRecord } from "../objectGeneration/furnitureTemplates.js";
import type { CardboardLootsRecord, CardboardItemRecord, ContentRecord, ItemRecord } from "../objectGeneration/itemTemplates.js";
import { findObjectByUUID, recalculateMVLChain } from "./toolObjectUtils.js";

/**
 * 应用移动物体工具：将指定物体从当前位置移动到目标位置。
 *
 * 目标可以是 "ground"（当前房间地面）、"inventory"（玩家背包）、
 * 或一个容器物体的 UUID（放入该容器内部）。
 *
 * 防自引用：不能将一个容器移入自身或其子孙容器内。
 */
export function applyMoveObjectTool(state: GameState, args: any): void {
  const objectUUID = typeof args?.object_uuid === "string" && args.object_uuid ? args.object_uuid : "";
  const destination = typeof args?.destination === "string" && args.destination ? args.destination : "";
  if (!objectUUID || !destination) return;

  const found = findObjectByUUID(state, objectUUID);
  if (!found) return;

  // 防自引用：检查目标容器是否在待移动物体的子树中
  if (destination !== "ground" && destination !== "inventory") {
    if (isUUIDInSubtree(found.object, destination)) return;
  }

  // 移除
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  delete found.container[found.key];

  // 放入目标位置
  if (destination === "ground") {
    placeInCurrentRoom(state, found.object);
  } else if (destination === "inventory") {
    state.playerInventory[found.object.uuid] = found.object;
  } else {
    placeInContainer(state, found.object, destination);
  }

  // 源端 MVL 重算（若物体是从嵌套容器中取出）
  if (found.parentChain.length > 0) {
    recalculateMVLChain(found.parentChain);
  }
}

//#region 内部函数

/**
 * 将物体放入当前房间的地面 content 中。
 */
function placeInCurrentRoom(state: GameState, object: GeneralContent): void {
  const location = state.playerIndoorLocation;
  if (!location) return;

  const record = state.buildingRecords[location.buildingId];
  if (!record) return;

  const room = findRoomInBuilding(record, location);
  if (!room) return;

  if (!room.content) {
    room.content = {};
  }
  room.content[object.uuid] = object;
}

/**
 * 将物体放入目标容器内部。
 * - FurnitureRecord / ItemRecord → 以 ContentRecord 包裹放入 content
 * - CardboardFurnitureRecord → 直接放入 loots
 */
function placeInContainer(state: GameState, object: GeneralContent, containerUUID: string): void {
  const containerResult = findObjectByUUID(state, containerUUID);
  if (!containerResult) return;

  const container = containerResult.object;

  // FurnitureRecord 或 ItemRecord：包裹 ContentRecord
  if ("content" in container) {
    const contentMap = (container as unknown as { content: Record<string, ContentRecord> }).content;
    const wrapper: ContentRecord = {
      uuid: randomUUID(),
      content: object as unknown as CardboardLootsRecord | CardboardItemRecord | ItemRecord,
    };
    contentMap[wrapper.uuid] = wrapper;
    // 容器 MVL 重算——取容器自身的父链，因为容器位置不变
    recalculateMVLChain(containerResult.parentChain.concat([container]));
    return;
  }

  // CardboardFurnitureRecord：放入 loots
  if ("loots" in container) {
    const loots = (container as CardboardFurnitureRecord).loots;
    loots[object.uuid] = object as unknown as CardboardLootsRecord | CardboardItemRecord;
    return;
  }

  // 不支持放入的容器类型 —— 回退到地面
  placeInCurrentRoom(state, object);
}

/**
 * 递归检查 targetUUID 是否在 subtree 物体的子孙中（防自引用）。
 */
function isUUIDInSubtree(subtree: GeneralContent, targetUUID: string): boolean {
  if (subtree.uuid === targetUUID) return true;

  // 检查 CardboardFurnitureRecord.loots
  if ("loots" in subtree) {
    for (const child of Object.values((subtree as CardboardFurnitureRecord).loots)) {
      if (isUUIDInSubtree(child as unknown as GeneralContent, targetUUID)) return true;
    }
  }

  // 检查 FurnitureRecord / ItemRecord content
  if ("content" in subtree) {
    const contentMap = (subtree as unknown as { content: Record<string, ContentRecord> }).content;
    for (const cr of Object.values(contentMap)) {
      const inner = cr.content as unknown as GeneralContent;
      if (isUUIDInSubtree(inner, targetUUID)) return true;
    }
  }

  return false;
}

//#endregion

import { randomUUID } from "node:crypto";
import type { GameState } from "./gameSessionStore.js";
import type { BuildingRecord, BuildingRoom, BuildingSubRoom } from "../buildingGeneration/buildingRecord.js";
import { findRoomInBuilding } from "../buildingGeneration/buildingRecord.js";
import type { GeneralContent, ObjectRecord } from "../objectGeneration/objectGeneraterShared.js";
import type { CardboardFurnitureRecord } from "../objectGeneration/furnitureTemplates.js";
import type { CardboardLootsRecord, ContentRecord, ItemRecord, PartRecord } from "../objectGeneration/itemTemplates.js";

//#region 类型

/**
 * 物体在游戏世界中的定位结果。
 * container 是可直接用 key 进行 delete 操作的父级 Record 引用；
 * parentChain 记录了从外层到内层（不含目标自身）的父物体链，供 MVL 向上重算用。
 */
export interface FindObjectResult {
  /** 所属来源 */
  source: "inventory" | "room";
  /** 直接父级容器引用（可 delete） */
  container: Record<string, unknown>;
  /** 在 container 中的键名 */
  key: string;
  /** 找到的物体本身 */
  object: GeneralContent;
  /** 父物体链（从外到内，不含目标），空数组表示顶层 */
  parentChain: GeneralContent[];
}

//#endregion

//#region 搜索函数

/**
 * 在当前房间 content 树及玩家背包中搜索指定 UUID 的物体。
 * 若玩家不在室内则仅搜索背包。
 */
export function findObjectByUUID(state: GameState, uuid: string): FindObjectResult | null {
  // 搜索背包
  const invResult = searchInGeneralContentMap(state.playerInventory, uuid, []);
  if (invResult) {
    return { ...invResult, source: "inventory" as const };
  }

  // 搜索当前房间
  const location = state.playerIndoorLocation;
  if (!location) return null;

  const record = state.buildingRecords[location.buildingId];
  if (!record) return null;

  const room = findRoomInBuilding(record, location);
  if (!room?.content) return null;

  const roomResult = searchInGeneralContentMap(room.content, uuid, []);
  if (roomResult) {
    return { ...roomResult, source: "room" as const };
  }

  return null;
}

/**
 * 在 GeneralContent map（房间 content 或背包）中递归搜索指定 UUID。
 * 同时搜索其下嵌套的子容器（FurnitureRecord.content / CardboardFurnitureRecord.loots 等）。
 */
function searchInGeneralContentMap(
  map: Record<string, GeneralContent>,
  targetUUID: string,
  parentChain: GeneralContent[],
): Omit<FindObjectResult, "source"> | null {
  for (const [key, obj] of Object.entries(map)) {
    if (obj.uuid === targetUUID) {
      return { container: map as unknown as Record<string, unknown>, key, object: obj, parentChain: [...parentChain] };
    }

    const nested = searchInsideObject(obj, targetUUID, [...parentChain, obj]);
    if (nested) return nested;
  }
  return null;
}

/**
 * 在某个物体内部的子容器中递归搜索（loots / content）。
 */
function searchInsideObject(
  obj: GeneralContent,
  targetUUID: string,
  parentChain: GeneralContent[],
): Omit<FindObjectResult, "source"> | null {
  // CardboardFurnitureRecord — loots 容器
  if ("loots" in obj && obj.loots) {
    const loots = (obj as CardboardFurnitureRecord).loots;
    for (const [key, lootOrItem] of Object.entries(loots)) {
      if (lootOrItem.uuid === targetUUID) {
        return {
          container: loots as unknown as Record<string, unknown>,
          key,
          object: lootOrItem as unknown as GeneralContent,
          parentChain: [...parentChain],
        };
      }
    }
  }

  // FurnitureRecord / ItemRecord — content 容器（ContentRecord 包裹）
  if ("content" in obj && obj.content) {
    const contentMap = (obj as unknown as { content: Record<string, ContentRecord> }).content;
    for (const [key, contentRecord] of Object.entries(contentMap)) {
      const inner = contentRecord.content as unknown as GeneralContent;
      if (inner.uuid === targetUUID) {
        return {
          container: contentMap as unknown as Record<string, unknown>,
          key,
          object: inner,
          parentChain: [...parentChain],
        };
      }
      const nested = searchInsideObject(inner, targetUUID, [...parentChain, inner]);
      if (nested) return nested;
    }
  }

  return null;
}

//#endregion

//#region MVL 重算函数

/**
 * 重算精算对象（ObjectRecord / ItemRecord / FurnitureRecord）的 total mass / volume / length。
 * 累加 children（parts + content）的 MVL：
 * - 精算 child 取 mass / volume
 * - Cardboard child 取 aprxMass / aprxVolume，并设 isMVLApproximate = true
 * - mass 始终累加；volume 仅 isSoftContainer 时才累加 child volume
 * - length 恒等于 selfLength
 */
export function recalculateObjectMVL(obj: ObjectRecord): void {
  let totalMass = obj.selfMass;
  let totalVolume = obj.selfVolume;
  let hasCardboardChild = false;

  // 零件 parts
  if ("parts" in obj) {
    const parts = (obj as unknown as { parts: Record<string, PartRecord> }).parts;
    for (const part of Object.values(parts)) {
      const content = part.content;
      if (typeof content === "string") continue; // 字符串零件无独立 MVL
      if ("mass" in content) {
        totalMass += content.mass;
        if (obj.isSoftContainer) totalVolume += content.volume;
        if (content.isMVLApproximate) hasCardboardChild = true;
      } else if ("aprxMass" in content) {
        totalMass += content.aprxMass;
        if (obj.isSoftContainer) totalVolume += content.aprxVolume;
        hasCardboardChild = true;
      }
    }
  }

  // 内容物 content（ContentRecord 包裹）
  if ("content" in obj) {
    const contentMap = (obj as unknown as { content: Record<string, ContentRecord> }).content;
    for (const contentRecord of Object.values(contentMap)) {
      const inner = contentRecord.content as unknown as ObjectRecord;
      if ("mass" in inner) {
        totalMass += inner.mass;
        if (obj.isSoftContainer) totalVolume += inner.volume;
        if (inner.isMVLApproximate) hasCardboardChild = true;
      } else if ("aprxMass" in inner) {
        totalMass += (inner as unknown as { aprxMass: number }).aprxMass;
        if (obj.isSoftContainer) {
          totalVolume += (inner as unknown as { aprxVolume: number }).aprxVolume;
        }
        hasCardboardChild = true;
      }
    }
  }

  obj.mass = totalMass;
  obj.volume = obj.isSoftContainer ? totalVolume : obj.selfVolume;
  obj.length = obj.selfLength;
  obj.isMVLApproximate = hasCardboardChild;
}

/**
 * 从 Cardboard 对象中扣除指定 MVL 量。
 * 返回 true 表示扣除后对象 MVL ≤ 0（应删除）。
 * 用于 take_from_loots / create_object 从 Loots 扣除 MVL。
 */
export function adjustCardboardMVL(
  obj: { aprxMass: number; aprxVolume: number; aprxLength: number },
  deltaMass: number,
  deltaVolume: number,
  deltaLength: number,
): boolean {
  obj.aprxMass = Math.max(0, obj.aprxMass - deltaMass);
  obj.aprxVolume = Math.max(0, obj.aprxVolume - deltaVolume);
  obj.aprxLength = Math.max(0, obj.aprxLength - deltaLength);
  return obj.aprxMass <= 0 || obj.aprxVolume <= 0;
}

/**
 * 从指定物体的父链向上逐层重算 MVL。
 * parentChain 是 findObjectByUUID 返回的从外到内的父物体列表。
 * 从最内层（直接父）开始向外重算。
 */
export function recalculateMVLChain(parentChain: GeneralContent[]): void {
  // 从最内层（链尾）向外重算
  for (let i = parentChain.length - 1; i >= 0; i--) {
    const parent = parentChain[i];
    if ("selfMass" in parent) {
      recalculateObjectMVL(parent as unknown as ObjectRecord);
    }
    // Cardboard 父容器不需要重算（使用 aprx MVL，通过 adjustCardboardMVL 手动管理）
  }
}

//#endregion

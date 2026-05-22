import { randomUUID } from "node:crypto";
import type { GameState } from "./gameSessionStore.js";
import type { GeneralContent, ObjectRecord } from "../objectGeneration/objectGeneraterShared.js";
import type { CardboardFurnitureRecord, FurnitureRecord } from "../objectGeneration/furnitureTemplates.js";
import { FURNITURE_VARIANT_CARDBOARDS } from "../objectGeneration/furnitureTemplates.js";
import type { CardboardItemRecord, CardboardLootsRecord, ContentRecord, ItemRecord, PartRecord } from "../objectGeneration/itemTemplates.js";
import { findObjectByUUID, recalculateObjectMVL, recalculateMVLChain } from "./toolObjectUtils.js";

//#region refine_cardboard_by_template

/**
 * 应用模板细化 Cardboard 对象工具：将纸板状态的 Item/Furniture 转为精算对象。
 *
 * CardboardItemRecord → ItemRecord（self MVL 来自模板变种 aprx 值）
 * CardboardFurnitureRecord → FurnitureRecord（self MVL 来自模板变种，parts/loots 保留）
 *
 * 细化后 isMVLApproximate 根据 children 是否含 Cardboard 自动设置。
 */
export function applyRefineCardboardByTemplateTool(state: GameState, args: any): void {
  const objectUUID = typeof args?.object_uuid === "string" && args.object_uuid ? args.object_uuid : "";
  const templateId = typeof args?.template === "string" && args.template ? args.template : "";
  const variantId = typeof args?.varient === "string" && args.varient ? args.varient : "";
  if (!objectUUID || !templateId || !variantId) return;

  const found = findObjectByUUID(state, objectUUID);
  if (!found) return;

  const cardboard = found.object;

  // 查变种数据
  const variantCardboards = FURNITURE_VARIANT_CARDBOARDS[templateId];
  if (!variantCardboards) return;
  const variantData = variantCardboards[variantId];
  if (!variantData) return;

  let refined: GeneralContent;

  if ("parts" in cardboard && "loots" in cardboard) {
    // CardboardFurnitureRecord → FurnitureRecord
    refined = refineFurniture(cardboard as unknown as CardboardFurnitureRecord, variantData);
  } else {
    // CardboardItemRecord → ItemRecord
    refined = refineItem(cardboard as unknown as CardboardItemRecord, variantData);
  }

  // 同位置替换
  found.container[found.key] = refined as unknown as Record<string, unknown>[string];

  // MVL 重算：自身 + 向上
  if ("selfMass" in refined) {
    recalculateObjectMVL(refined as unknown as ObjectRecord);
  }
  if (found.parentChain.length > 0) {
    recalculateMVLChain(found.parentChain);
  }
}

//#endregion

//#region refine_cardboard_by_llm

/**
 * 应用创新细化 Cardboard 对象工具：由 LLM 指定的 MVL、材料、形状等参数将纸板对象转为精算对象。
 *
 * 与模板细化的区别：MVL/material/shape/parts 全部由 LLM 直接提供，不依赖预置模板数据。
 */
export function applyRefineCardboardByLLMTool(state: GameState, args: any): void {
  const objectUUID = typeof args?.object_uuid === "string" && args.object_uuid ? args.object_uuid : "";
  const mass = Number(args?.mass);
  const volume = Number(args?.volume);
  const length = Number(args?.length);
  if (!objectUUID || !Number.isFinite(mass) || !Number.isFinite(volume) || !Number.isFinite(length)) return;

  const material = typeof args?.material === "string" && args.material ? args.material : undefined;
  const shape = typeof args?.shape === "string" && args.shape ? args.shape : undefined;
  const isSoftContainer = typeof args?.is_soft_container === "boolean" ? args.is_soft_container : false;
  const partsArg = Array.isArray(args?.parts) ? args.parts : [];

  const found = findObjectByUUID(state, objectUUID);
  if (!found) return;

  const cardboard = found.object;

  // 构建 parts
  const parts: Record<string, PartRecord> = {};
  for (const p of partsArg) {
    if (typeof p?.name !== "string" || !p.name) continue;
    const desc = typeof p?.description === "string" ? p.description : "";
    parts[randomUUID()] = {
      uuid: randomUUID(),
      content: `${p.name}${desc ? " - " + desc : ""}`,
    };
  }

  // 构建精算对象
  const hasParts = "parts" in cardboard || partsArg.length > 0;
  const refined = hasParts
    ? ({
        uuid: cardboard.uuid,
        name: cardboard.name,
        mass,
        volume,
        length,
        selfMass: mass,
        selfVolume: volume,
        selfLength: length,
        description: cardboard.description,
        isSoftContainer,
        isMVLApproximate: false,
        parts,
        content: ("loots" in cardboard)
          ? convertLootsToContent((cardboard as unknown as CardboardFurnitureRecord).loots)
          : {},
      } as FurnitureRecord)
    : ({
        uuid: cardboard.uuid,
        name: cardboard.name,
        mass,
        volume,
        length,
        selfMass: mass,
        selfVolume: volume,
        selfLength: length,
        description: cardboard.description,
        isSoftContainer,
        isMVLApproximate: false,
        shape,
        material,
        parts: Object.keys(parts).length > 0 ? parts : {},
        content: {},
      } as ItemRecord);

  // 替换
  found.container[found.key] = refined as unknown as Record<string, unknown>[string];

  // MVL 重算
  recalculateObjectMVL(refined as unknown as ObjectRecord);
  if (found.parentChain.length > 0) {
    recalculateMVLChain(found.parentChain);
  }
}

//#endregion

//#region 内部函数

interface VariantCardboardData {
  aprxMass: number;
  aprxVolume: number;
  aprxLength: number;
  partDescriptions: string[];
}

/**
 * 将 CardboardItemRecord 转为 ItemRecord。
 */
function refineItem(cardboard: CardboardItemRecord, variantData: VariantCardboardData): ItemRecord {
  const item: ItemRecord = {
    uuid: cardboard.uuid,
    name: cardboard.name,
    mass: variantData.aprxMass,
    volume: variantData.aprxVolume,
    length: variantData.aprxLength,
    selfMass: variantData.aprxMass,
    selfVolume: variantData.aprxVolume,
    selfLength: variantData.aprxLength,
    description: cardboard.description,
    isSoftContainer: cardboard.isSoftContainer,
    isMVLApproximate: false,
    parts: {},
    content: {},
  };
  recalculateObjectMVL(item);
  return item;
}

/**
 * 将 CardboardFurnitureRecord 转为 FurnitureRecord。
 * parts 从变种 partDescriptions 构建，loots 转为 ContentRecord 包裹。
 */
function refineFurniture(cardboard: CardboardFurnitureRecord, variantData: VariantCardboardData): FurnitureRecord {
  // 构建 parts（初始 content 为字符串描述）
  const parts: Record<string, PartRecord> = {};
  for (const desc of variantData.partDescriptions) {
    const uuid = randomUUID();
    parts[uuid] = { uuid, content: desc };
  }

  // loots 转为 ContentRecord 包裹
  const content = convertLootsToContent(cardboard.loots);

  const furniture: FurnitureRecord = {
    uuid: cardboard.uuid,
    name: cardboard.name,
    mass: variantData.aprxMass,
    volume: variantData.aprxVolume,
    length: variantData.aprxLength,
    selfMass: variantData.aprxMass,
    selfVolume: variantData.aprxVolume,
    selfLength: variantData.aprxLength,
    description: cardboard.description,
    isSoftContainer: cardboard.isSoftContainer,
    isMVLApproximate: Object.keys(content).length > 0, // 有 loots children 则近似
    parts,
    content,
  };
  recalculateObjectMVL(furniture);
  return furniture;
}

/**
 * 将 CardboardFurnitureRecord.loots 转为 FurnitureRecord.content 所需的 ContentRecord 映射。
 */
function convertLootsToContent(
  loots: Record<string, CardboardLootsRecord | CardboardItemRecord>,
): Record<string, ContentRecord> {
  const content: Record<string, ContentRecord> = {};
  for (const [lootUUID, loot] of Object.entries(loots)) {
    const wrapperUUID = randomUUID();
    content[wrapperUUID] = {
      uuid: wrapperUUID,
      content: loot as CardboardLootsRecord | CardboardItemRecord | ItemRecord,
    };
  }
  return content;
}

//#endregion

import { randomUUID } from "node:crypto";
import type { GameState } from "./gameSessionStore.js";
import type { GeneralContent, ObjectRecord } from "../objectGeneration/objectGeneraterShared.js";
import type { CardboardFurnitureRecord, FurnitureRecord } from "../objectGeneration/furnitureTemplates.js";
import { FURNITURE_VARIANT_CARDBOARDS } from "../objectGeneration/furnitureTemplates.js";
import type { CardboardItemRecord, CardboardLootsRecord, ContentRecord, ItemRecord, PartRecord } from "../objectGeneration/itemTemplates.js";
import { findRoomInBuilding } from "../buildingGeneration/buildingRecord.js";
import { findObjectByUUID, recalculateObjectMVL, recalculateMVLChain, adjustCardboardMVL } from "./toolObjectUtils.js";

//#region create_object_by_template

/**
 * 应用模板创建精算对象工具：直接产出 ItemRecord 或 FurnitureRecord，跳过 Cardboard 阶段。
 *
 * 可选 source_loots_uuid 参数：若指定，从来源 Cardboard Loots 的 MVL 中扣除本次创建的 MVL
 * （相当于从 Loots 中"拿取"物品）。若 Loots 扣除后耗尽则删除。
 */
export function applyCreateObjectByTemplateTool(state: GameState, args: any): void {
  const templateId = typeof args?.template === "string" && args.template ? args.template : "";
  const variantId = typeof args?.varient === "string" && args.varient ? args.varient : "";
  const destination = typeof args?.destination === "string" && args.destination ? args.destination : "";
  if (!templateId || !variantId || !destination) return;

  const sourceLootsUUID = typeof args?.source_loots_uuid === "string" && args.source_loots_uuid
    ? args.source_loots_uuid : undefined;

  // 查变种数据
  const variantCardboards = FURNITURE_VARIANT_CARDBOARDS[templateId];
  if (!variantCardboards) return;
  const variantData = variantCardboards[variantId];
  if (!variantData) return;

  // 构建精算对象
  const uuid = randomUUID();
  const parts: Record<string, PartRecord> = {};
  for (const desc of variantData.partDescriptions) {
    const partUUID = randomUUID();
    parts[partUUID] = { uuid: partUUID, content: desc };
  }

  const hasParts = variantData.partDescriptions.length > 0;

  let created: GeneralContent;
  if (hasParts) {
    const furniture: FurnitureRecord = {
      uuid,
      name: variantData.name,
      mass: variantData.aprxMass,
      volume: variantData.aprxVolume,
      length: variantData.aprxLength,
      selfMass: variantData.aprxMass,
      selfVolume: variantData.aprxVolume,
      selfLength: variantData.aprxLength,
      description: variantId,
      isSoftContainer: false,
      isMVLApproximate: false,
      parts,
      content: {},
    };
    recalculateObjectMVL(furniture);
    created = furniture;
  } else {
    const item: ItemRecord = {
      uuid,
      name: variantData.name,
      mass: variantData.aprxMass,
      volume: variantData.aprxVolume,
      length: variantData.aprxLength,
      selfMass: variantData.aprxMass,
      selfVolume: variantData.aprxVolume,
      selfLength: variantData.aprxLength,
      description: variantId,
      isSoftContainer: false,
      isMVLApproximate: false,
      parts: {},
      content: {},
    };
    recalculateObjectMVL(item);
    created = item;
  }

  // 若指定来源 Loots：扣除 MVL
  if (sourceLootsUUID) {
    deductFromSourceLoots(state, sourceLootsUUID, variantData.aprxMass, variantData.aprxVolume, variantData.aprxLength);
  }

  // 放置
  placeCreatedObject(state, created, destination);
}

//#endregion

//#region create_object_by_llm

/**
 * 应用创新创建精算对象工具：由 LLM 直接指定 MVL、材料、形状、零件等，产出精算对象。
 *
 * 可选 source_loots_uuid 参数：同模板创建，从来源 Loots 扣除 MVL。
 */
export function applyCreateObjectByLLMTool(state: GameState, args: any): void {
  const name = typeof args?.name === "string" && args.name ? args.name : "";
  const description = typeof args?.description === "string" && args.description ? args.description : "";
  const mass = Number(args?.mass);
  const volume = Number(args?.volume);
  const length = Number(args?.length);
  const destination = typeof args?.destination === "string" && args.destination ? args.destination : "";
  if (!name || !description || !Number.isFinite(mass) || !Number.isFinite(volume) || !Number.isFinite(length) || !destination) return;

  const material = typeof args?.material === "string" && args.material ? args.material : undefined;
  const shape = typeof args?.shape === "string" && args.shape ? args.shape : undefined;
  const isSoftContainer = typeof args?.is_soft_container === "boolean" ? args.is_soft_container : false;
  const sourceLootsUUID = typeof args?.source_loots_uuid === "string" && args.source_loots_uuid
    ? args.source_loots_uuid : undefined;
  const partsArg = Array.isArray(args?.parts) ? args.parts : [];

  // 构建 parts
  const parts: Record<string, PartRecord> = {};
  for (const p of partsArg) {
    if (typeof p?.name !== "string" || !p.name) continue;
    const desc = typeof p?.description === "string" ? p.description : "";
    const partUUID = randomUUID();
    parts[partUUID] = { uuid: partUUID, content: `${p.name}${desc ? " - " + desc : ""}` };
  }

  const uuid = randomUUID();

  let created: GeneralContent;
  if (Object.keys(parts).length > 0) {
    const furniture: FurnitureRecord = {
      uuid,
      name,
      mass,
      volume,
      length,
      selfMass: mass,
      selfVolume: volume,
      selfLength: length,
      description,
      isSoftContainer,
      isMVLApproximate: false,
      parts,
      content: {},
    };
    recalculateObjectMVL(furniture);
    created = furniture;
  } else {
    const item: ItemRecord = {
      uuid,
      name,
      mass,
      volume,
      length,
      selfMass: mass,
      selfVolume: volume,
      selfLength: length,
      description,
      isSoftContainer,
      isMVLApproximate: false,
      material,
      shape,
      parts: {},
      content: {},
    };
    recalculateObjectMVL(item);
    created = item;
  }

  // 扣除来源 Loots MVL
  if (sourceLootsUUID) {
    deductFromSourceLoots(state, sourceLootsUUID, mass, volume, length);
  }

  // 放置
  placeCreatedObject(state, created, destination);
}

//#endregion

//#region 内部函数

/**
 * 从来源 Cardboard Loots 扣除指定 MVL。
 * 若扣除后 Loots 耗尽则删除并向上重算 MVL。
 */
function deductFromSourceLoots(
  state: GameState,
  lootsUUID: string,
  deltaMass: number,
  deltaVolume: number,
  deltaLength: number,
): void {
  const found = findObjectByUUID(state, lootsUUID);
  if (!found) return;

  const loots = found.object;
  if (!("aprxMass" in loots)) return;

  const depleted = adjustCardboardMVL(
    loots as unknown as CardboardLootsRecord,
    deltaMass,
    deltaVolume,
    deltaLength,
  );

  if (depleted) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete found.container[found.key];
  }

  if (found.parentChain.length > 0) {
    recalculateMVLChain(found.parentChain);
  }
}

/**
 * 将创建的精算物体放入目标位置。
 */
function placeCreatedObject(state: GameState, object: GeneralContent, destination: string): void {
  if (destination === "inventory") {
    state.playerInventory[object.uuid] = object;
    return;
  }

  if (destination === "ground") {
    placeInCurrentRoom(state, object);
    return;
  }

  // 容器 UUID
  const containerResult = findObjectByUUID(state, destination);
  if (!containerResult) {
    placeInCurrentRoom(state, object);
    return;
  }

  const container = containerResult.object;

  if ("content" in container) {
    const contentMap = (container as unknown as { content: Record<string, ContentRecord> }).content;
    const wrapper: ContentRecord = {
      uuid: randomUUID(),
      content: object as unknown as CardboardLootsRecord | CardboardItemRecord | ItemRecord,
    };
    contentMap[wrapper.uuid] = wrapper;
    recalculateMVLChain(containerResult.parentChain.concat([container]));
    return;
  }

  if ("loots" in container) {
    const loots = (container as CardboardFurnitureRecord).loots;
    loots[object.uuid] = object as unknown as CardboardLootsRecord | CardboardItemRecord;
    return;
  }

  placeInCurrentRoom(state, object);
}

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

//#endregion

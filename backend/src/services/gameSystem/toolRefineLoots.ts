import { randomUUID } from "node:crypto";
import type { GameState } from "./gameSessionStore.js";
import type { CardboardItemRecord } from "../objectGeneration/itemTemplates.js";
import type { CardboardLootsRecord } from "../objectGeneration/itemTemplates.js";
import { LOOTS_TEMPLATES } from "../objectGeneration/lootsTemplates.js";
import { findObjectByUUID, recalculateMVLChain } from "./toolObjectUtils.js";
import { findRoomInBuilding } from "../buildingGeneration/buildingRecord.js";

/**
 * 应用模板细化 Loots 工具：使用指定模板将 Cardboard Loots 细化为若干 CardboardItemRecord。
 *
 * 按模板物品列表顺序逐一生成，受 Loots 本身的 aprxMVL 预算限制：
 * - 若当前物品的 MVL 在剩余预算内 → 生成并扣除预算
 * - 若超出预算 → 跳过该项，继续尝试后续更轻的物品
 * - 当所有剩余物品均无法容纳时停止
 * - 生成完成后删除原 Loots
 */
export function applyRefineLootsTool(state: GameState, args: any): void {
  const lootsUUID = typeof args?.loots_uuid === "string" && args.loots_uuid ? args.loots_uuid : "";
  const templateId = typeof args?.template_id === "string" && args.template_id ? args.template_id : "";
  const destination = typeof args?.destination === "string" && args.destination ? args.destination : "";
  if (!lootsUUID || !templateId || !destination) return;

  // 查找 Loots
  const found = findObjectByUUID(state, lootsUUID);
  if (!found) return;

  const loots = found.object;
  if (!("aprxMass" in loots)) return; // 必须是 Cardboard 对象

  const lootsMVL = loots as unknown as CardboardLootsRecord;

  // 查模板
  const template = LOOTS_TEMPLATES.find((t) => t.id === templateId);
  if (!template) return;

  // 预算
  let budgetMass = lootsMVL.aprxMass;
  let budgetVolume = lootsMVL.aprxVolume;
  let budgetLength = lootsMVL.aprxLength;

  const generatedItems: CardboardItemRecord[] = [];

  // 按模板顺序尝试生成
  for (const itemEntry of template.items) {
    // 检查预算是否足够
    if (itemEntry.aprxMass > budgetMass || itemEntry.aprxVolume > budgetVolume) {
      // 跳过此项，继续尝试后续物品
      continue;
    }

    const item: CardboardItemRecord = {
      uuid: randomUUID(),
      name: itemEntry.name,
      aprxMass: itemEntry.aprxMass,
      aprxVolume: itemEntry.aprxVolume,
      aprxLength: itemEntry.aprxLength,
      description: itemEntry.description,
      note: "",
      isSoftContainer: itemEntry.isSoftContainer,
    };

    generatedItems.push(item);
    budgetMass -= itemEntry.aprxMass;
    budgetVolume -= itemEntry.aprxVolume;
    budgetLength -= itemEntry.aprxLength;

    // 预算耗尽则停止（无需继续，剩余物品都更重）
    if (budgetMass <= 0 || budgetVolume <= 0) break;
  }

  // 删除原 Loots
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  delete found.container[found.key];

  // 源端 MVL 重算
  if (found.parentChain.length > 0) {
    recalculateMVLChain(found.parentChain);
  }

  // 放置生成物品
  for (const item of generatedItems) {
    placeRefinedItem(state, item, destination);
  }
}

//#region 内部函数

/**
 * 将细化生成的物品放入目标位置。
 */
function placeRefinedItem(state: GameState, item: CardboardItemRecord, destination: string): void {
  if (destination === "inventory") {
    state.playerInventory[item.uuid] = item as CardboardItemRecord;
    return;
  }

  if (destination === "ground") {
    placeInCurrentRoom(state, item as CardboardItemRecord);
    return;
  }

  // 指定容器 UUID：尝试放入容器
  const containerResult = findObjectByUUID(state, destination);
  if (!containerResult) {
    placeInCurrentRoom(state, item as CardboardItemRecord);
    return;
  }

  const container = containerResult.object;

  // FurnitureRecord / ItemRecord content
  if ("content" in container) {
    const contentMap = (container as unknown as { content: Record<string, any> }).content;
    const wrapper = {
      uuid: randomUUID(),
      content: item,
    };
    contentMap[wrapper.uuid] = wrapper;
    recalculateMVLChain(containerResult.parentChain.concat([container]));
    return;
  }

  // CardboardFurnitureRecord loots
  if ("loots" in container) {
    const loots = (container as any).loots;
    loots[item.uuid] = item;
    return;
  }

  placeInCurrentRoom(state, item as CardboardItemRecord);
}

function placeInCurrentRoom(state: GameState, item: CardboardItemRecord): void {
  const location = state.playerIndoorLocation;
  if (!location) return;

  const record = state.buildingRecords[location.buildingId];
  if (!record) return;

  const room = findRoomInBuilding(record, location);
  if (!room) return;

  if (!room.content) {
    room.content = {};
  }
  room.content[item.uuid] = item as CardboardItemRecord;
}

//#endregion

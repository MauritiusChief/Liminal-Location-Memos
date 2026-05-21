import { randomUUID } from "node:crypto";
import { GameState } from "./gameSessionStore.js";
import { CARDBOARD_TEMPLATES, CardboardObjectTemplate } from "../objectGeneration/objectGeneraterShared.js";
import { CardboardFurnitureRecord, FURNITURE_VARIANT_CARDBOARDS } from "../objectGeneration/furnitureTemplates.js";
import { CardboardItemRecord, CardboardLootsRecord } from "../objectGeneration/itemTemplates.js";
import { findRoomInBuilding } from "../buildingGeneration/buildingRecord.js";

/**
 * 真实创建 Game State 中的物体
 * @param state 
 * @param args 
 */
export function applyCreateCardboardObject(state: GameState, args: any): void {
  const templateId = typeof args?.template === "string" && args.template ? args.template : "";
  if (!templateId) {
    return;
  }

  const template = CARDBOARD_TEMPLATES.find((t) => t.id === templateId);
  if (!template) {
    return;
  }

  let variantId = typeof args?.varient === "string" && args.varient ? args.varient : "";
  if (!variantId && template.varients.length > 0) {
    variantId = template.varients[0].id;
  }
  const variant = template.varients.find((v) => v.id === variantId);
  if (!variantId || !variant) {
    return;
  }

  const location = state.playerIndoorLocation;
  if (!location) {
    return;
  }

  const record = state.buildingRecords[location.buildingId];
  if (!record) {
    return;
  }

  const room = findRoomInBuilding(record, location);
  if (!room) {
    return;
  }

  const note = typeof args?.note === "string" ? args.note : "";
  const uuid = randomUUID();

  const cardboards = FURNITURE_VARIANT_CARDBOARDS[templateId];
  if (cardboards) {
    const variantCardboard = cardboards[variantId];
    if (!variantCardboard) {
      return;
    }

    const parts: Record<string, string> = {};
    for (const desc of variantCardboard.partDescriptions) {
      parts[randomUUID()] = desc;
    }

    const loots = buildLoots(template, args?.content);

    const furnitureRecord: CardboardFurnitureRecord = {
      uuid,
      name: variantCardboard.name,
      aprxMass: variantCardboard.aprxMass,
      aprxVolume: variantCardboard.aprxVolume,
      aprxLength: variantCardboard.aprxLength,
      description: variant.description,
      note,
      parts,
      loots,
    };

    if (!room.content) {
      room.content = {};
    }
    room.content[uuid] = furnitureRecord;
  // TODO 物品创建摘出去，不要依靠 FURNITURE_VARIANT_CARDBOARDS 是否存在模板来判断是否是物品
  } else {
    const itemRecord: CardboardItemRecord = {
      uuid,
      name: variant.description,
      aprxMass: 1,
      aprxVolume: 1,
      aprxLength: 10,
      description: variant.description,
      note,
    };

    if (!room.content) {
      room.content = {};
    }
    room.content[uuid] = itemRecord;
  }
}

function buildLoots(
  template: CardboardObjectTemplate,
  contentArg: unknown,
): Record<string, CardboardLootsRecord> {
  const result: Record<string, CardboardLootsRecord> = {};

  let contentIds: string[];
  if (Array.isArray(contentArg)) {
    contentIds = contentArg.filter((id): id is string => typeof id === "string");
  } else {
    return result;
  }

  for (const lootId of contentIds) {
    const lootDef = template.availableLootsId.find((l) => l.id === lootId);
    if (!lootDef) {
      continue;
    }

    const lootUuid = randomUUID();
    // TODO 根据家具来动态决定 Mass, Volume, Length，或者干脆删掉此处 M,V,L
    result[lootUuid] = {
      uuid: lootUuid,
      name: lootId,
      aprxMass: 1,
      aprxVolume: 1,
      aprxLength: 10,
      description: lootDef.description,
      note: "",
    };
  }

  return result;
}

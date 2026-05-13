import { randomUUID } from "node:crypto";
import { GameState } from "./gameSessionStore.js";
import { CARDBOARD_TEMPLATES, CardboardObjectTemplate } from "../objectGeneration/objectGeneraterShared.js";
import { CardboardFurnitureRecord } from "../objectGeneration/furnitureTemplates.js";
import { CardboardItemRecord, CardboardLootsRecord } from "../objectGeneration/itemTemplates.js";
import { findRoomInBuilding } from "../buildingGeneration/buildingRecord.js";

interface FurnitureVariantDefault {
  name: string;
  aprxMass: number;
  aprxVolume: number;
  aprxLength: number;
  partDescriptions: string[];
}

const FURNITURE_VARIANT_DEFAULTS: Record<string, Record<string, FurnitureVariantDefault>> = {
  home_refrigerator: {
    regular: {
      name: "家用冰箱",
      aprxMass: 75,
      aprxVolume: 500,
      aprxLength: 180,
      partDescriptions: [
        "冰箱外壳 - 构成冰箱外部轮廓的硬质外壳",
        "压缩机 - 将制冷剂压缩为高温高压气体的核心制冷部件",
        "制冷剂罐 - 储存制冷剂（如R600a）的压力容器",
        "冷凝管 - 将高温高压气态制冷剂散热冷凝为液态的管路",
        "温控器 - 调节冰箱内部温度的控制器",
        "冷藏层搁架(上) - 冷藏层上方的玻璃搁架",
        "冷藏层搁架(中) - 冷藏层中部的玻璃搁架",
        "冷藏层搁架(下) - 冷藏层底部的玻璃搁架",
        "冷冻层搁架 - 冷冻层内的搁架",
        "冷藏门 - 冷藏层的门，内侧可放置瓶罐",
        "冷冻门 - 冷冻层的门",
        "冷藏门搁架(上) - 冷藏门内侧上方的搁架，适合放瓶罐",
        "冷藏门搁架(下) - 冷藏门内侧下方的搁架，适合放瓶罐",
      ],
    },
    prime: {
      name: "豪华家用冰箱",
      aprxMass: 100,
      aprxVolume: 600,
      aprxLength: 180,
      partDescriptions: [
        "冰箱外壳 - 构成冰箱外部轮廓的硬质外壳",
        "压缩机 - 将制冷剂压缩为高温高压气体的核心制冷部件",
        "制冷剂罐 - 储存制冷剂（如R600a）的压力容器",
        "冷凝管 - 将高温高压气态制冷剂散热冷凝为液态的管路",
        "温控器 - 调节冰箱内部温度的控制器",
        "冷藏层搁架(上) - 冷藏层上方的玻璃搁架",
        "冷藏层搁架(中) - 冷藏层中部的玻璃搁架",
        "冷藏层搁架(下) - 冷藏层底部的玻璃搁架",
        "冷冻层搁架 - 冷冻层内的搁架",
        "冷藏门 - 冷藏层的门，内侧可放置瓶罐",
        "冷冻门 - 冷冻层的门",
        "冷藏门搁架(上) - 冷藏门内侧上方的搁架，适合放瓶罐",
        "冷藏门搁架(下) - 冷藏门内侧下方的搁架，适合放瓶罐",
        "制冰机 - 位于冷藏门上的自动制冰装置",
      ],
    },
    mini: {
      name: "迷你冰箱",
      aprxMass: 20,
      aprxVolume: 50,
      aprxLength: 50,
      partDescriptions: [
        "冰箱外壳 - 构成迷你冰箱外部轮廓的紧凑外壳",
        "压缩机 - 小型压缩机",
        "制冷剂罐 - 小型制冷剂储存容器",
        "冷凝管 - 小型冷凝管路",
        "温控器 - 温度控制器",
        "冷藏层搁架(上) - 冷藏层上方的搁架",
        "冷藏层搁架(下) - 冷藏层下方的搁架",
        "小型冷冻层 - 位于冷藏层内部上方的小型冷冻隔间",
        "单门 - 冷冻与冷藏共用的门",
        "门搁架 - 门内侧的搁架，适合放瓶罐",
      ],
    },
  },
};

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

  const defaults = FURNITURE_VARIANT_DEFAULTS[templateId];
  if (defaults) {
    const variantDefaults = defaults[variantId];
    if (!variantDefaults) {
      return;
    }

    const parts: Record<string, string> = {};
    for (const desc of variantDefaults.partDescriptions) {
      parts[randomUUID()] = desc;
    }

    const loots = buildLoots(template, args?.content);

    const furnitureRecord: CardboardFurnitureRecord = {
      uuid,
      name: variantDefaults.name,
      aprxMass: variantDefaults.aprxMass,
      aprxVolume: variantDefaults.aprxVolume,
      aprxLength: variantDefaults.aprxLength,
      description: variant.description,
      note,
      parts,
      loots,
    };

    if (!room.content) {
      room.content = {};
    }
    room.content[uuid] = furnitureRecord;
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

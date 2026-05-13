import { CardboardItemRecord, CardboardLootsRecord, ContentRecord, PartRecord } from "./itemTemplates.js";
import { CardboardObjectRecord, CardboardObjectTemplate, ObjectRecord } from "./objectGeneraterShared.js";

/**
 * 兼容尚未细化完的部分
 * 质量、体积（对于软性物品）、长度（对于可改装物品）会随着 parts 和 content 实时更新
 */
export interface FurnitureRecord extends ObjectRecord {
  parts: Record<string, PartRecord>; // 键为 uuid
  content: Record<string, ContentRecord>; // 键为 uuid 值
}

export interface CardboardFurnitureRecord extends CardboardObjectRecord {
  parts: Record<string, string>; // 键为 uuid, 值为功能物品描述
  loots: Record<string, CardboardLootsRecord | CardboardItemRecord>; // 键为 uuid 值
}

// /**
//  * 给 LLM 看的
//  */
// interface CardboardFurnitureTemplate extends CardboardObjectTemplate {}

export const CARDBOAD_FURNITURE_TEMPLATES: CardboardObjectTemplate[] = [
  {
    id: "home_refrigerator",
    keyword: "制冷家用冰箱家用电冰箱",
    description: "用低温延缓食物腐败的家具，也能单纯用来降低物体（如饮料）的温度，包含冷冻与冷藏层。",
    varients: [
      {id: "regular", description: "常规家用冰箱，冷冻与冷藏层有各自的门，冷藏层的门本身也能装东西"},
      {id: "prime", description: "豪华家用冰箱，除了冷冻与冷藏以外冰箱门上还有制冰机"},
      {id: "mini", description: "迷你冰箱，冷冻层较小且与冷藏共享一个门"},
    ],
    availableLootsId: [
      {id: "groceries", description: "常规家庭的日常饮食"},
      {id: "beers", description: "冰镇啤酒和其他快餐与速冻食品"},
    ],
  }
]

interface FurnitureVariantCardboard {
  name: string;
  aprxMass: number;
  aprxVolume: number;
  aprxLength: number;
  partDescriptions: string[];
}

export const FURNITURE_VARIANT_CARDBOARDS: Record<string, Record<string, FurnitureVariantCardboard>> = {
  home_refrigerator: {
    regular: {
      name: "家用冰箱",
      aprxMass: 75,
      aprxVolume: 500,
      aprxLength: 180,
      partDescriptions: [
        "冰箱外壳",
        "压缩机",
        "制冷剂罐",
        "冷凝管",
        "温控器",
        "冷藏层搁架",
        "冷冻层搁架",
        "冷藏门搁架",
      ],
    },
    prime: {
      name: "豪华家用冰箱",
      aprxMass: 100,
      aprxVolume: 600,
      aprxLength: 180,
      partDescriptions: [
        "冰箱外壳",
        "压缩机",
        "制冷剂罐",
        "冷凝管",
        "温控器",
        "冷藏层搁架",
        "冷冻层搁架",
        "冷藏门搁架",
        "制冰机",
      ],
    },
    mini: {
      name: "迷你冰箱",
      aprxMass: 20,
      aprxVolume: 50,
      aprxLength: 50,
      partDescriptions: [
        "冰箱外壳",
        "压缩机",
        "制冷剂罐",
        "冷凝管",
        "温控器",
        "冷藏层搁架",
        "单门搁架",
      ],
    },
  },
};
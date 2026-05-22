import { GeneralSource } from "../gameSystem/llmTypes.js";
import { CARDBOAD_FURNITURE_TEMPLATES, CardboardFurnitureRecord, FurnitureRecord } from "./furnitureTemplates.js";
import { CARDBOARD_ITEM_TEMPLATES, CardboardItemRecord, ItemRecord } from "./itemTemplates.js";

/**
 * 质量、体积（对于软性物品）、长度（对于可改装物品）会随着 parts 和 content 实时更新
 */
export interface ObjectRecord {
  uuid: string;
  name: string;
  mass: number; // 单位为 kg（= selfMass + children 的 mass，含 Cardboard children 的 aprxMass 在内）
  volume: number; // 单位为 L（软容器时含 children volume，刚性容器 = selfVolume）
  length: number; // 单位为 cm（不随内容物变化，恒 = selfLength）
  selfMass: number;
  selfVolume: number;
  selfLength: number;
  description: string;
  /** 软容器标记：true 时放入内容物会增加容器的 volume（如背包）；默认 false（如保险箱，仅 mass 增加） */
  isSoftContainer?: boolean;
  /** 显式标记：true 表示 total mass/volume/length 处于近似状态，因为仍有 child 为 Cardboard */
  isMVLApproximate?: boolean;
}

export interface CardboardObjectRecord {
  uuid: string;
  name: string;
  aprxMass: number; // 单位为 kg
  aprxVolume: number; // 单位为 L
  aprxLength: number; // 单位为 cm
  description: string;
  note: string;
  /** 软容器标记：纸板状态亦可标记（如已知是个麻袋） */
  isSoftContainer?: boolean;
}

/**
 * 给 LLM 看的
 */
export interface CardboardObjectTemplate extends GeneralSource {
  varients: {id: string, description: string}[];
  availableLootsId: {id: string, description: string}[]
}

export const CARDBOARD_TEMPLATES: CardboardObjectTemplate[] = [
  ...CARDBOARD_ITEM_TEMPLATES,
  ...CARDBOAD_FURNITURE_TEMPLATES,
]

export type GeneralContent = CardboardItemRecord | CardboardFurnitureRecord | ItemRecord | FurnitureRecord;
import { GeneralSource } from "../gameSystem/llmTypes.js";
import { CARDBOAD_FURNITURE_TEMPLATES, CardboardFurnitureRecord, FurnitureRecord } from "./furnitureTemplates.js";
import { CARDBOARD_ITEM_TEMPLATES, CardboardItemRecord, ItemRecord } from "./itemTemplates.js";

/**
 * 质量、体积（对于软性物品）、长度（对于可改装物品）会随着 parts 和 content 实时更新
 */
export interface ObjectRecord {
  uuid: string;
  name: string;
  mass: number; // 单位为 kg
  volume: number; // 单位为 L
  length: number; // 单位为 cm
  selfMass: number;
  selfVolume: number;
  selfLength: number;
  description: string;
}

export interface CardboardObjectRecord {
  uuid: string;
  name: string;
  aprxMass: number; // 单位为 kg
  aprxVolume: number; // 单位为 L
  aprxLength: number; // 单位为 cm
  description: string;
  note: string;
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
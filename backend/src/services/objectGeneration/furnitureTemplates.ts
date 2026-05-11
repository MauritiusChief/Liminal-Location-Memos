import { CardboardItemRecord, CardboardLootsRecord, ContentRecord, PartRecord } from "./itemTemplates.js";

/**
 * 兼容尚未细化完的部分
 * 质量、体积（对于软性物品）、长度（对于可改装物品）会随着 parts 和 content 实时更新
 */
export interface FurnitureRecord {
  uuid: string;
  name: string;
  mass: number; // 单位为 kg
  volume: number; // 单位为 L
  length: number; // 单位为 cm
  selfMass: number;
  selfVolume: number;
  selfLength: number;
  description: string;
  // Furniture 特有
  parts: Record<string, PartRecord>; // 键为 uuid
  content: Record<string, ContentRecord>; // 键为 uuid 值
}

export interface CardboardFurnitureRecord {
  uuid: string;
  name: string;
  aprxMass: number; // 单位为 kg
  aprxVolume: number; // 单位为 L
  aprxLength: number; // 单位为 cm
  description: string;
  note: string;
  // Furniture 特有
  parts: Record<string, string>; // 键为 uuid, 值为功能物品描述
  loots: Record<string, CardboardLootsRecord | CardboardItemRecord>; // 键为 uuid 值
}

/**
 * 给 LLM 看的
 */
interface CardboardFurnitureTemplate {
  id: string;
  keyword: string; // 用来给搜索引擎比对的
  description: string;
  varients: {id: string, description: string}[];
  availableLootsId: {id: string, description: string}[]
}
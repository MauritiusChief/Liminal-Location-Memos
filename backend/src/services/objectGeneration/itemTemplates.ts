

/**
 * 兼容尚未细化完的部分
 * 质量、体积（对于软性物品）、长度（对于可改装物品）会随着 parts 和 content 实时更新
 */
export interface ItemRecord {
  uuid: string;
  name: string;
  mass: number; // 单位为 kg
  volume: number; // 单位为 L
  length: number; // 单位为 cm
  selfMass: number;
  selfVolume: number;
  selfLength: number;
  description: string;
  // 物品特有
  parts: Record<string, PartRecord>; // 键为 uuid
  shape?: string;
  material?: string;
  content: Record<string, ContentRecord>; // 键为 uuid 值
}

export interface ContentRecord {
  uuid: string;
  method?: ContentInsertingMethod;
  content: CardboardLootsRecord | CardboardItemRecord | ItemRecord
}

export interface PartRecord {
  uuid: string;
  method?: PartAttachingMethod;
  content: string | CardboardItemRecord | ItemRecord;
}

/**
 * 可以为待填状态，以适应刚从 Cardboard 形式转化来的形态
 */
export interface PartAttachingMethod {

}

/**
 * 包含比方说罐装、瓶口密封、塑封等封口状态和灌注、加压灌注等真正的“注入”方法；
 * 可以为待填状态，以适应刚从 Cardboard 形式转化来的形态
 */
export interface ContentInsertingMethod {

}

export interface CardboardItemRecord {
  uuid: string;
  name: string;
  aprxMass: number; // 单位为 kg
  aprxVolume: number; // 单位为 L
  aprxLength: number; // 单位为 cm
  description: string;
  note: string;
}

/**
 * TODO 暂时做成和 Cardboard Item 一模一样
 */
export interface CardboardLootsRecord {
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
interface CardboardItemTemplate {
  id: string;
  keyword: string; // 用来给搜索引擎比对的
  description: string;
  varients: {id: string, description: string}[];
  availableLootsId: {id: string, description: string}[]
}
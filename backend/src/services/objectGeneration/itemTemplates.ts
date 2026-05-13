import { CardboardObjectRecord, CardboardObjectTemplate, ObjectRecord } from "./objectGeneraterShared.js";


/**
 * 兼容尚未细化完的部分
 * 质量、体积（对于软性物品）、长度（对于可改装物品）会随着 parts 和 content 实时更新
 */
export interface ItemRecord extends ObjectRecord {
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

// export interface CardboardItemRecord extends CardboardObjectRecord {}
export type CardboardItemRecord = CardboardObjectRecord

/**
 * TODO 暂时做成和 Cardboard Item 一模一样
 */
export type CardboardLootsRecord = CardboardObjectRecord
// export interface CardboardLootsRecord extends CardboardObjectRecord {}

// /**
//  * 给 LLM 看的
//  */
// interface CardboardItemTemplate extends CardboardObjectTemplate {}

export const CARDBOARD_ITEM_TEMPLATES: CardboardObjectTemplate[] = [
  {
    id: "fried_chips",
    keyword: "膨化食品油炸薯片",
    description: "包装好的薯片，好吃但没营养，通常意义上的垃圾食品。",
    varients: [
      {id: "plain", description: "只加了盐的原味薯片"},
      {id: "barbecue_flavored", description: "烧烤酱口味的薯片"},
    ],
    availableLootsId: [],
  }
]

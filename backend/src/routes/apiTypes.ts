import { NormalizedFeature } from "@/services/osmNormalization/osmNormalizer.js"

/**
 * 特制带有经纬度以及范围的数据
 */
export interface RangedPosition {
  lat: number;
  lon: number;
  radius: number;
}

//#region DEBUG API 使用

export interface debugSyncOverpassRespond {
  query: string
  features: NormalizedFeature[]
  counts: number
}
import { NormalizedFeature } from "@/services/osmNormalization/osmNormalizer.js"

export interface debugSyncOverpassRespond {
  query: string
  features: NormalizedFeature[]
  counts: number
}
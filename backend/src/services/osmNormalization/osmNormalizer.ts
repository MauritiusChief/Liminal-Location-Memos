import { Feature, FeatureCollection, Geometry } from "geojson";
import { OverpassJson } from "overpass-ts";

interface RelationReference {
  role: string;
  rel: number;
  reltags: Record<string, string>;
}

interface OutlineReference {
  osmType: string;
  osmId: number;
  tags: Record<string, string>;
  role: string;
  rel: number;
  reltags: Record<string, string>;
}

interface ContainedPoiReference {
  osmType: string;
  osmId: number;
  tags: Record<string, string>;
  meta: Record<string, string | number>;
  tainted: boolean;
  coordinate: [number, number];
  sourceFeatureId: string;
  relationReferences?: RelationReference[];
}

/**
 * 规整化后的 GeoJSON 所应携带的 property 数据。
 * 其中额外包含对应地物所属 relation、所属 relation 的 outline、所包含的 POI，这三项拼接数据。
 */
interface NormalizedFeatureProperties {
  osmType: string;
  osmId: number;
  tags: Record<string, string>;
  meta: Record<string, string | number>;
  tainted: boolean;
  containedPoiReferences?: ContainedPoiReference[];
  relationReferences?: RelationReference[];
  outlineReferencess?: OutlineReference[];
}

export type NormalizedFeature = Feature<Geometry, NormalizedFeatureProperties>;
export type NormalizedFeatureCollection = FeatureCollection<Geometry, NormalizedFeatureProperties>;

export function convertOverpassToNormalizedFeatures(raw: OverpassJson): NormalizedFeature[] {
  return []
}

// #region 帮助函数
import type { ContainedPoi, RelationReference } from './overpassNormalization.js';

export type DbFeatureCategory = 'building' | 'poi' | 'line' | 'area';

// 这是 DB-native 调试链路里最基础的要素索引。
// grid / polar / prompt 都只拿它需要的字段，不再依赖完整 GeoJSON feature。
export interface DbFeatureDetail {
  featureId: string;
  osmType: string;
  osmId: number;
  category: DbFeatureCategory;
  geometryType: string;
  tags: Record<string, string>;
  relations: RelationReference[];
  meta: Record<string, string | number>;
  tainted: boolean;
  containedPois?: ContainedPoi[];
}

// Micro grid 在 SQL 里已经完成了“这个格子命中了谁”的空间判断；
// TS 这里只负责把记录格式化成最终展示结构。
export interface DbMicroGridCellRecord {
  row: number;
  col: number;
  center: [number, number];
  baseKind: 'building' | 'area' | 'empty';
  baseFeatureId: string | null;
  poiFeatureIds: string[];
  roadFeatureIds: string[];
}

// Polar 记录保留“用于叙述的坐标样本”和一个中心候选点，
// bearing / widest span / 方向聚类仍在 TS 中完成。
export interface DbPolarFeatureRecord {
  featureId: string;
  osmType: string;
  osmId: number;
  category: DbFeatureCategory;
  geometryType: string;
  sampleCoordinates: [number, number][];
  centerCoordinate: [number, number] | null;
  // line 会额外带一条“按可见顺序排列”的路径，
  // 供前端 SVG 直接画折线，不再把线硬压成扇区。
  linePathCoordinates?: [number, number][];
  // line 顶点序列和 centerPoint 分离：
  // 后续 4 点抽样与回归都只从这组顶点里挑。
  lineVertexCoordinates?: [number, number][];
}

// diagnostics 也改成围绕 DB-native 投影结果，而不是 GeoJSON 统计。
export interface DbNormalizationDiagnostics {
  featureCountsByCategory: Record<DbFeatureCategory, number>;
  totalFeatures: number;
  populatedMicroGridCellCount: number;
  polarFeatureCount: number;
}

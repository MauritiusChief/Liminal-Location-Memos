export type SummaryPreviewMode = 'detailed_far_1000' | 'concise_far_1000' | 'concise_near_200';

export interface RelationReference {
  role: string;
  rel: number;
  reltags: Record<string, string>;
}

export interface ContainedPoi {
  osmType: string;
  osmId: number;
  tags: Record<string, string>;
  relations: RelationReference[];
  meta: Record<string, string | number>;
  tainted: boolean;
  coordinate: [number, number];
  sourceFeatureId: string;
}

export type MicroGridCellKind = 'building' | 'area' | 'empty';

export interface NormalizedMicroGridCell {
  row: number;
  col: number;
  center: [number, number];
  baseKind: MicroGridCellKind;
  baseLabel: string;
  poiLabels: string[];
  roadLabels: string[];
  label: string;
  sourceFeatureIds: string[];
}

export interface NormalizedMicroGrid {
  enabled: boolean;
  reason?: 'radius_too_small';
  center: {
    lat: number;
    lon: number;
  };
  extentMeters: 60;
  cellSizeMeters: 5;
  rows: 12;
  cols: 12;
  cells: NormalizedMicroGridCell[][];
}

export interface PolarCoordinateSample {
  coordinate: [number, number];
  distanceMeters: number;
  bearingDegrees: number;
}

export interface PolarAngularSpan {
  clockwiseEarlyPoint: PolarCoordinateSample;
  clockwiseLatePoint: PolarCoordinateSample;
  angleWidthDegrees: number;
}

export interface PolarDirectionCluster {
  clusterId: string;
  centerBearingDegrees: number;
  memberCount: number;
}

export type PolarFeatureCategory = 'building' | 'poi' | 'line' | 'area';

export interface PolarVisibleTag {
  key: string;
  value: string;
}

export interface NormalizedPolarFeatureSummary {
  featureId: string;
  osmType: string;
  osmId: number;
  geometryType: string;
  category: PolarFeatureCategory;
  baseLabel: string;
  clusterLabel: string;
  directionCluster: PolarDirectionCluster;
  displayLabel: string;
  visibleTags: PolarVisibleTag[];
  level: 1 | 2 | 3;
  nearestPoint: PolarCoordinateSample;
  farthestPoint: PolarCoordinateSample;
  centerPoint: PolarCoordinateSample;
  widestSpan: PolarAngularSpan;
  // 线类会额外暴露 4 个代表顶点；
  // 它们与 centerPoint 分离，供回归和 debug 展示使用。
  linePoints?: PolarCoordinateSample[];
  // 线类的 SVG 走完整可见路径，而不是把 centerPoint 混进路径里。
  linePath?: PolarCoordinateSample[];
  orientationDegrees?: number;
  lineLengthMeters?: number;
}

export interface NormalizedPolarLevel {
  level: 1 | 2 | 3;
  distanceRangeMeters: [number, number];
  features: NormalizedPolarFeatureSummary[];
}

export interface NormalizedPolarView {
  center: {
    lat: number;
    lon: number;
  };
  maxRadiusMeters: 1000;
  levels: NormalizedPolarLevel[];
}

export interface NormalizedFeatureProperties {
  osmType: string;
  osmId: number;
  tags: Record<string, string>;
  relations: RelationReference[];
  meta: Record<string, string | number>;
  tainted: boolean;
  containedPois?: ContainedPoi[];
}

export interface NormalizedFeature {
  type: 'Feature';
  id?: string;
  geometry: {
    type: string;
    coordinates?: unknown;
    geometries?: unknown;
  };
  properties: NormalizedFeatureProperties;
}

export interface NormalizedFeatureCollection {
  type: 'FeatureCollection';
  features: NormalizedFeature[];
}

export type DbFeatureCategory = 'building' | 'poi' | 'line' | 'area';

export interface DbNormalizationDiagnostics {
  featureCountsByCategory: Record<DbFeatureCategory, number>;
  totalFeatures: number;
  populatedMicroGridCellCount: number;
  polarFeatureCount: number;
}

export interface NormalizationDiagnostics {
  rawElementCounts: Record<string, number>;
  totalRawElements: number;
  totalConvertedFeatures: number;
  totalNormalizedFeatures: number;
  featureCountsByGeometryType: Record<string, number>;
  taintedFeatures: number;
  skippedFeaturesWithoutGeometry: number;
  filteredRelationOutlineFeatures: number;
  filteredRelationMemberLineFeatures: number;
}

export interface SceneQuery {
  lat: number;
  lon: number;
  radius: number;
  includeRaw?: boolean;
}

export interface NormalizedOverpassResponse {
  query: string;
  geojson: NormalizedFeatureCollection;
  diagnostics: NormalizationDiagnostics;
  microGrid?: NormalizedMicroGrid;
  polarView?: NormalizedPolarView;
  raw?: unknown;
}

export interface SceneSyncResponse {
  query: string;
  featureCount: number;
  counts: {
    buildings: number;
    pois: number;
    lines: number;
    areas: number;
  };
  coverageRecorded: boolean;
}

export interface DbFeatureSummary {
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

export interface SceneLoadResponse {
  query: string;
  diagnostics: DbNormalizationDiagnostics;
  featureSummary: DbFeatureSummary[];
  microGrid?: NormalizedMicroGrid;
  polarView?: NormalizedPolarView;
}

export interface SummaryPreviewRequest {
  lat: number;
  lon: number;
  summaryMode: SummaryPreviewMode;
}

export interface SummaryPreviewResponse {
  summaryMode: SummaryPreviewMode;
  summaryText: string;
}

export interface RawOverpassResponse {
  data: unknown;
}

// 下面这一组是首页“正式游戏会话”使用的类型。
export interface GamePosition {
  lat: number;
  lon: number;
}

export type GameMessage =
  | {
      role: 'user';
      content: string;
    }
  | {
      role: 'assistant';
      content: string;
    }
  | {
      role: 'tool';
      toolName: string;
      content: string;
    };

export interface MovePlayerToolResult {
  bearingDegrees: number;
  distanceMeters: number;
}

export interface LookFarToolResult {
  mode: 'large_summary';
}

export interface LargeDescriptionRecord {
  id: string;
  descriptionText: string;
}

export interface SmallDescriptionRecord {
  id: string;
  descriptionText: string;
  distanceMeters?: number;
}

export interface GameChatRequest {
  sessionId?: string;
  message: string;
  isOpeningPrompt?: boolean;
}

export interface GameChatResponse {
  sessionId: string;
  messages: GameMessage[];
  playerPosition: GamePosition;
  activeLargeDescription: LargeDescriptionRecord | null;
  nearbySmallDescriptions: SmallDescriptionRecord[];
}

export interface GameSessionSnapshotResponse {
  sessionId: string;
  hasStarted: boolean;
  messages: GameMessage[];
  playerPosition: GamePosition;
  activeLargeDescription: LargeDescriptionRecord | null;
  nearbySmallDescriptions: SmallDescriptionRecord[];
}

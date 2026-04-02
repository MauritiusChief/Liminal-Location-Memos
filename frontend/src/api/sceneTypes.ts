export type SummaryPreviewMode = 'detailed_far_1000' | 'concise_far_1000' | 'concise_near_200';

export interface RelationReference {
  role: string;
  rel: number;
  reltags: Record<string, string>;
}

export interface OutlineReference {
  osmType: string;
  osmId: number;
  tags: Record<string, string>;
  role: string;
  rel: number;
  reltags: Record<string, string>;
}

export interface ContainedPoiReference {
  osmType: string;
  osmId: number;
  tags: Record<string, string>;
  meta: Record<string, string | number>;
  tainted: boolean;
  coordinate: [number, number];
  sourceFeatureId: string;
  relationReferences?: RelationReference[];
}

export type MicroGridCellKind = 'building' | 'area' | 'empty';

export interface LabeledMicroGridCell {
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

export interface LabeledMicroGrid {
  center: {
    lat: number;
    lon: number;
  };
  extentMeters: 60;
  cellSizeMeters: 5;
  rows: 12;
  cols: 12;
  cells: LabeledMicroGridCell[][];
  detailEntries: string[];
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

export type PolarFeatureCategory = 'building' | 'poi' | 'line' | 'area';

export interface DbFeatureSummary {
  featureId: string;
  osmType?: string;
  osmId: number;
  category: PolarFeatureCategory;
  geometryType: string;
  tags: Record<string, string>;
  relations?: RelationReference[];
  outlineReferences?: OutlineReference[];
  meta?: Record<string, string | number>;
  tainted?: boolean;
  containedPois?: Array<{ tags: Record<string, string> } | ContainedPoiReference>;
}

export interface PolarViewFeature {
  featureId: string;
  osmId: number;
  category: PolarFeatureCategory;
  geometryType: string;
  osmType?: string;
  featureDetail: DbFeatureSummary;
  centerPoint: PolarCoordinateSample;
  widestSpan: PolarAngularSpan;
  nearestPoint: PolarCoordinateSample;
  farthestPoint: PolarCoordinateSample;
  linePoints?: PolarCoordinateSample[];
  linePath?: PolarCoordinateSample[];
  orientationDegrees?: number;
}

export interface MarkedPolarViewFeature extends PolarViewFeature {
  clusterMarker: string;
  levelMarker: 1 | 2 | 3;
  baseLabel: string;
}

export interface PolarViewCluster {
  clusterMarker: string;
  memberCount: number;
  centerBearingDegrees: number;
  features: MarkedPolarViewFeature[];
}

export interface PolarViewLevel {
  level: 1 | 2 | 3;
  distanceRangeMeters: [number, number];
  clusters: PolarViewCluster[];
}

export interface PolarView {
  center: {
    lat: number;
    lon: number;
  };
  maxRadiusMeters: number;
  levels: PolarViewLevel[];
}

export interface NormalizedFeatureProperties {
  osmType: string;
  osmId: number;
  tags: Record<string, string>;
  relationReferences: RelationReference[];
  outlineReferences: OutlineReference[];
  meta: Record<string, string | number>;
  tainted: boolean;
  containedPoiReferences?: ContainedPoiReference[];
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

export interface SceneQuery {
  lat: number;
  lon: number;
  radius: number;
  includeRaw?: boolean;
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

export interface SceneLoadResponse {
  query: string;
  diagnostics: DbNormalizationDiagnostics;
  featureSummary: DbFeatureSummary[];
  microGrid?: LabeledMicroGrid;
  polarView?: PolarView;
}

export interface RawOverpassResponse {
  data: unknown;
}

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

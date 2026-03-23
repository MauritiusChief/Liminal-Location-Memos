import { query } from "@/db/client.js";
import { loadServiceSql } from "@/db/sqlLoader.js";
import { RangedPosition } from "@/routes/apiTypes.js";

/**
 * 与 SQL 查询结果表一致的扁平类型
 */
type DbPolarViewFeatureTabelRow = {
  feature_id: string;
  osm_type: string;
  osm_id: number;
  category: "building" | "area" | "poi" | "line";
  geometry_type: string;
  sample_coordinates: Array<[number, number]> | null;
  center_coordinate: [number, number] | null;
  line_path_coordinates: Array<[number, number]> | null;
  line_vertex_coordinates: Array<[number, number]> | null;
};

/**
 * 采样过的用于 Polar View 的地物。
 * 此处采样指的是采集所有点的坐标、计算中心点坐标、查找线类地物的样本坐标
 */
export interface SampledPolarViewFeature {
  featureId: string;
  osmId: number;
  category: "building" | "area" | "poi" | "line";
  geometryType: string;
  osmType?: string;
  // 该地物所有的坐标点
  sampleCoordinates: [number, number][];
  // 该地物的中心坐标点
  centerCoordinate: [number, number] | null;
  // line 会额外带一条“按可见顺序排列”的路径，
  // 供前端 SVG 直接画折线，不再把线硬压成扇区。
  linePathCoordinates?: [number, number][];
  // line 顶点序列和 centerPoint 分离：
  // 后续 4 点抽样与回归都只从这组顶点里挑。
  lineVertexCoordinates?: [number, number][];
}

interface PolarCoordinateSample {
  coordinate: [number, number];
  distanceMeters: number;
  bearingDegrees: number;
}
interface PolarAngularSpan {
  clockwiseEarlyPoint: PolarCoordinateSample;
  clockwiseLatePoint: PolarCoordinateSample;
  angleWidthDegrees: number;
}

/**
 * 基于 SampledPolarViewFeature 计算的，理论上可直接用于 Polar View 的信息
 */
interface MetricedPolarViewFeature {
  featureId: string;
  osmId: number;
  category: "building" | "area" | "poi" | "line";
  geometryType: string;
  osmType?: string;
  centerPoint: PolarCoordinateSample;
  widestSpan: PolarAngularSpan;
  // 非线类地物
  nearestPoint?: PolarCoordinateSample;
  farthestPoint?: PolarCoordinateSample;
  // 线类地物
  linePoints?: PolarCoordinateSample[];
  linePath?: PolarCoordinateSample[];
  orientationDegrees?: number;
}

interface MarkedPolarViewFeature extends SampledPolarViewFeature {
  clusterMarker: string,
  levelMarker: 1 | 2 | 3
}

//#region 主函数

const fetchScenePolarFeaturesFromDbSqlPromise = loadServiceSql('osmRepository/fetchScenePolarFeaturesFromDb.sql');

/**
 * polar 的 DB 查询只做“取候选 + 裁剪几何 + 导出坐标样本”。
 * bearing、群聚、视野角宽这类叙述性压缩继续保留在 TS，便于调参和阅读。
 * @param request
 * @param _profile 暂时没用，未来可区分 debug 模式和常规模式的 SQL
 * @returns
 */
export async function fetchScenePolarFeaturesFromDb(
  request: RangedPosition,
  _profile: string = 'debug',
): Promise<SampledPolarViewFeature[]> {
  const radiusMeters = Math.min(request.radius, 1000);

  const sql = await fetchScenePolarFeaturesFromDbSqlPromise;
  const result = await query<DbPolarViewFeatureTabelRow>(
    sql,
    [request.lon, request.lat, radiusMeters],
  );

  return result.rows.map((row) => ({
    featureId: row.feature_id,
    osmType: row.osm_type || undefined,
    osmId: row.osm_id,
    category: row.category,
    geometryType: row.geometry_type,
    sampleCoordinates: (row.sample_coordinates || []).map((pair) => [Number(pair[0]), Number(pair[1])]),
    centerCoordinate: row.center_coordinate
      ? [Number(row.center_coordinate[0]), Number(row.center_coordinate[1])]
      : null,
    linePathCoordinates: row.line_path_coordinates
      ? row.line_path_coordinates.map((pair) => [Number(pair[0]), Number(pair[1])])
      : undefined,
    lineVertexCoordinates: row.line_vertex_coordinates
      ? row.line_vertex_coordinates.map((pair) => [Number(pair[0]), Number(pair[1])])
      : undefined,
  }));
}

function buildMatricedPolarViewFeature(polarViewFeature: SampledPolarViewFeature[]): MetricedPolarViewFeature[] {

}

function applyPolarViewFeatureMarkder(polarViewFeature: MetricedPolarViewFeature[]): MarkedPolarViewFeature[] {

}
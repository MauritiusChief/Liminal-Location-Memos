import type { PoolClient } from 'pg';
import { query, withTransaction } from '../db/client.js';
import { loadServiceSql } from '../db/sqlLoader.js';
import type {
  ContainedPoiReference,
  NormalizedFeature,
  OutlineReference,
  RelationReference,
} from '@/services/osmNormalization/osmNormalizer.js';
import type {
  DbFeatureCategory,
  SceneFeatureDetail,
  PolarFeatureRecord,
} from './sceneTypes.js';
import { getStructuredTagColumns, matchFeatureCategory } from '@/services/osmNormalization/osmFeatureConfig.js';
import type { AreaSummary, BuildingSummary, GamePosition, LineSummary } from '../types/game.js';
import { RangedPosition } from '@/routes/apiTypes.js';

type BuildingRow = {
  feature_id: string;
  osm_type: string;
  osm_id: number;
  geometry_type: string;
  tags: Record<string, string>;
  relations: RelationReference[];
  outline_references: OutlineReference[];
  meta: Record<string, string | number>;
  tainted: boolean;
  contained_pois: ContainedPoiReference[] | null;
};



type PolarFeatureRow = {
  feature_id: string;
  osm_type: string;
  osm_id: number;
  category: DbFeatureCategory;
  geometry_type: string;
  sample_coordinates: Array<[number, number]> | null;
  center_coordinate: [number, number] | null;
  line_path_coordinates: Array<[number, number]> | null;
  line_vertex_coordinates: Array<[number, number]> | null;
};

type BuildingAtPositionRow = {
  building_id: string;
  tags: Record<string, string>;
  area_square_meters: number;
  relations: RelationReference[] | null;
  contained_pois: ContainedPoiReference[] | null;
};

type AreaAtPositionRow = {
  area_id: string;
  tags: Record<string, string>;
  area_square_meters: number;
};

type LineNearPositionRow = {
  line_id: string;
  tags: Record<string, string>;
};

const fetchScenePolarFeaturesFromDbSqlPromise = loadServiceSql('osmRepository/fetchScenePolarFeaturesFromDb.sql');

const findBuildingsAtPositionSqlPromise = loadServiceSql('osmRepository/findBuildingAtPosition.sql');
const findAreasAtPositionSqlPromise = loadServiceSql('osmRepository/findAreasAtPosition.sql');
const findNearbyLinesAtPositionSqlPromise = loadServiceSql('osmRepository/findNearbyLinesAtPosition.sql');

export type SceneDataProfile = 'debug' | 'game';





/**
 * polar 的 DB 查询只做“取候选 + 裁剪几何 + 导出坐标样本”。
 * bearing、群聚、视野角宽这类叙述性压缩继续保留在 TS，便于调参和阅读。
 * @param request
 * @param _profile 暂时没用，未来可区分 debug 模式和常规模式的 SQL
 * @returns
 */
export async function fetchScenePolarFeaturesFromDb(
  request: RangedPosition,
  _profile: SceneDataProfile = 'debug',
): Promise<PolarFeatureRecord[]> {
  const radiusMeters = Math.min(request.radius, 1000);
  if (radiusMeters <= 30) {
    return [];
  }

  const sql = await fetchScenePolarFeaturesFromDbSqlPromise;
  const result = await query<PolarFeatureRow>(
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

export async function findNearestCoverageDistanceMeters(position: GamePosition): Promise<number | null> {
  const result = await query<{ distance_meters: number | null }>(
    `
    SELECT MIN(ST_DistanceSphere(center, ST_SetSRID(ST_MakePoint($1, $2), 4326))) AS distance_meters
    FROM osm_sync_coverage
    `,
    [position.lon, position.lat],
  );

  const value = result.rows[0]?.distance_meters;
  return value === null || value === undefined ? null : Number(value);
}

export async function findBuildingsAtPosition(position: GamePosition): Promise<BuildingSummary[]> {
  const sql = await findBuildingsAtPositionSqlPromise;
  const result = await query<BuildingAtPositionRow>(
    sql,
    [position.lon, position.lat],
  );

  return result.rows.map((row) => ({
    buildingId: row.building_id,
    tags: row.tags || {},
    areaSquareMeters: Number(row.area_square_meters),
    relations: row.relations || [],
    containedPois: row.contained_pois || [],
  }));
}

export async function findAreasAtPosition(position: GamePosition): Promise<AreaSummary[]> {
  const sql = await findAreasAtPositionSqlPromise;
  const result = await query<AreaAtPositionRow>(
    sql,
    [position.lon, position.lat],
  );

  return result.rows.map((row) => ({
    areaId: row.area_id,
    tags: row.tags || {},
    areaSquareMeters: Number(row.area_square_meters),
  }));
}

export async function findNearbyLinesAtPosition(position: GamePosition): Promise<LineSummary[]> {
  const sql = await findNearbyLinesAtPositionSqlPromise;
  const result = await query<LineNearPositionRow>(
    sql,
    [position.lon, position.lat],
  );

  return result.rows.map((row) => ({
    lineId: row.line_id,
    tags: row.tags || {},
  }));
}
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../db/client.js';
import { loadServiceSql } from '../db/sqlLoader.js';
import type {
  NormalizedFeature,
  NormalizedOverpassRequest,
  ContainedPoi,
  RelationReference,
} from './overpassNormalization.js';
import type {
  DbFeatureCategory,
  SceneFeatureDetail,
  PolarFeatureRecord,
  DbMicroGridCellRecord,
} from './scene/sceneTypes.js';
import { getStructuredTagColumns, matchFeatureCategory } from './osmFeatureConfig.js';
import type { GamePosition } from '../types/game.js';

type BuildingRow = {
  feature_id: string;
  osm_type: string;
  osm_id: number;
  geometry_type: string;
  tags: Record<string, string>;
  relations: RelationReference[];
  meta: Record<string, string | number>;
  tainted: boolean;
  contained_pois: ContainedPoi[] | null;
};

type FeatureDetailRow = {
  feature_id: string;
  osm_type: string;
  osm_id: number;
  category: DbFeatureCategory;
  geometry_type: string;
  tags: Record<string, string>;
  relations: RelationReference[];
  meta: Record<string, string | number>;
  tainted: boolean;
};

type MicroGridCellRow = {
  row: number;
  col: number;
  center_lon: number;
  center_lat: number;
  base_kind: 'building' | 'area' | 'empty';
  base_feature_id: string | null;
  poi_feature_ids: string[] | null;
  road_feature_ids: string[] | null;
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

const BUILDING_TAG_COLUMNS = getStructuredTagColumns('building');
const POI_TAG_COLUMNS = getStructuredTagColumns('poi');
const ROAD_TAG_COLUMNS = getStructuredTagColumns('line');
const AREA_TAG_COLUMNS = getStructuredTagColumns('area');
const fetchMicroGridFromDbSqlPromise = loadServiceSql('osmRepository/fetchMicroGridFromDb.sql');
const fetchScenePolarFeaturesFromDbSqlPromise = loadServiceSql('osmRepository/fetchScenePolarFeaturesFromDb.sql');
const fetchSceneBuildingDetailsSqlPromise = loadServiceSql('osmRepository/fetchSceneBuildingDetails.sql');
const fetchSceneNonBuildingDetailsSqlPromise = loadServiceSql('osmRepository/fetchSceneNonBuildingDetails.sql');
const upsertBuildingFeatureSqlPromise = loadServiceSql('osmRepository/upsertBuildingFeature.sql');
const upsertPoiFeatureSqlPromise = loadServiceSql('osmRepository/upsertPoiFeature.sql');
const upsertLineFeatureSqlPromise = loadServiceSql('osmRepository/upsertLineFeature.sql');
const upsertAreaFeatureSqlPromise = loadServiceSql('osmRepository/upsertAreaFeature.sql');

export type SceneDataProfile = 'debug' | 'game';

export async function syncNormalizedFeaturesToDb(
  features: NormalizedFeature[],
  coverage: { lat: number; lon: number; radius: number },
): Promise<{ buildings: number; pois: number; lines: number; areas: number }> {
  return withTransaction(async (client) => {
    let buildings = 0;
    let pois = 0;
    let lines = 0;
    let areas = 0;

    for (const feature of features) {
      const category = matchFeatureCategory(feature);
      switch (category) {
        case 'building':
          await upsertBuildingFeature(client, feature);
          buildings += 1;
          break;
        case 'poi':
          await upsertPoiFeature(client, feature);
          pois += 1;
          break;
        case 'line':
          await upsertLineFeature(client, feature);
          lines += 1;
          break;
        case 'area':
          await upsertAreaFeature(client, feature);
          areas += 1;
          break;
        default:
          break;
      }
    }

    await client.query(
      `
      INSERT INTO osm_sync_coverage (center, radius_m, source)
      VALUES (ST_SetSRID(ST_MakePoint($1, $2), 4326), $3, 'overpass')
      `,
      [coverage.lon, coverage.lat, coverage.radius],
    );

    return { buildings, pois, lines, areas };
  });
}

/**
 * 这个函数把“后续文案与调试真正会消费的要素字段”统一取回。
 * 建筑单独走一条查询，是为了顺手把 containedPois 一并在 SQL 里算好。
 * @param request
 * @param _profile 暂时没用，未来可区分 debug 模式和常规模式的 SQL
 * @returns
 */
export async function fetchSceneFeatureDetailsFromDb(
  request: NormalizedOverpassRequest,
  _profile: SceneDataProfile = 'debug',
): Promise<SceneFeatureDetail[]> {
  const [buildingRows, otherRows] = await Promise.all([
    fetchBuildingDetails(request),
    fetchNonBuildingDetails(request),
  ]);

  return [
    ...buildingRows.map((row) => ({
      featureId: row.feature_id,
      osmType: row.osm_type,
      osmId: row.osm_id,
      category: 'building' as const,
      geometryType: row.geometry_type,
      tags: row.tags || {},
      relations: row.relations || [],
      meta: row.meta || {},
      tainted: row.tainted ?? false,
      containedPois: row.contained_pois && row.contained_pois.length > 0 ? row.contained_pois : undefined,
    })),
    ...otherRows.map((row) => ({
      featureId: row.feature_id,
      osmType: row.osm_type,
      osmId: row.osm_id,
      category: row.category,
      geometryType: row.geometry_type,
      tags: row.tags || {},
      relations: row.relations || [],
      meta: row.meta || {},
      tainted: row.tainted ?? false,
    })),
  ];
}

/**
 * grid 的空间命中全部下沉到 PostGIS：
 * 1. 生成 12x12 固定网格
 * 2. 用 cell center 判定 building/area 基底
 * 3. 用 cell bbox 收集 poi / road 叠加层
 * @param request
 * @returns
 */
export async function fetchMicroGridFromDb(request: NormalizedOverpassRequest): Promise<DbMicroGridCellRecord[]> {
  if (request.radius <= 50) {
    return [];
  }

  const sql = await fetchMicroGridFromDbSqlPromise;
  const result = await query<MicroGridCellRow>(
    sql,
    [request.lon, request.lat],
  );

  return result.rows.map((row) => ({
    row: row.row,
    col: row.col,
    center: [row.center_lon, row.center_lat],
    baseKind: row.base_kind,
    baseFeatureId: row.base_feature_id,
    poiFeatureIds: row.poi_feature_ids || [],
    roadFeatureIds: row.road_feature_ids || [],
  }));
}

/**
 * polar 的 DB 查询只做“取候选 + 裁剪几何 + 导出坐标样本”。
 * bearing、群聚、视野角宽这类叙述性压缩继续保留在 TS，便于调参和阅读。
 * @param request
 * @param _profile 暂时没用，未来可区分 debug 模式和常规模式的 SQL
 * @returns
 */
export async function fetchScenePolarFeaturesFromDb(
  request: NormalizedOverpassRequest,
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

/**
 * 这里取的是“建筑详情 + 建筑内 POI”，供标签、grid 补充细节、prompt 共用。
 * 注：为了兼容 debug 模式，SQL 所取的信息是超量的。
 * @param request
 * @returns
 */
async function fetchBuildingDetails(request: NormalizedOverpassRequest): Promise<BuildingRow[]> {
  const sql = await fetchSceneBuildingDetailsSqlPromise;
  const result = await query<BuildingRow>(
    sql,
    [request.lon, request.lat, request.radius],
  );

  return result.rows;
}

/**
 *  非 building 的详情直接从调试视图取，避免在 TS 里重复拼 tags。
 * 注：为了兼容 debug 模式，SQL 所取的信息是超量的。
 * @param request
 * @returns
 */
async function fetchNonBuildingDetails(request: NormalizedOverpassRequest): Promise<FeatureDetailRow[]> {
  const sql = await fetchSceneNonBuildingDetailsSqlPromise;
  const result = await query<FeatureDetailRow>(
    sql,
    [request.lon, request.lat, request.radius],
  );

  return result.rows;
}

async function upsertBuildingFeature(client: PoolClient, feature: NormalizedFeature): Promise<void> {
  const tags = feature.properties.tags;
  const tagsExtra = omitKeys(tags, BUILDING_TAG_COLUMNS);
  const sql = await upsertBuildingFeatureSqlPromise;

  await client.query(
    sql,
    [
      feature.properties.osmType,
      feature.properties.osmId,
      JSON.stringify(feature.geometry),
      tags.name || null,
      tags.building || null,
      tags.man_made || null,
      tags.height || null,
      tags.level || null,
      tags['building:levels'] || null,
      JSON.stringify(tagsExtra),
      JSON.stringify(feature.properties.relations),
      JSON.stringify(feature.properties.meta),
      feature.properties.tainted,
    ],
  );
}

// sync 阶段仍然保留原来的“只把后续摘要会用到的对象落库”策略。
async function upsertPoiFeature(client: PoolClient, feature: NormalizedFeature): Promise<void> {
  const tags = feature.properties.tags;
  const tagsExtra = omitKeys(tags, POI_TAG_COLUMNS);
  const sql = await upsertPoiFeatureSqlPromise;

  await client.query(
    sql,
    [
      feature.properties.osmType,
      feature.properties.osmId,
      JSON.stringify(feature.geometry),
      tags.name || null,
      tags.brand || null,
      tags.shop || null,
      tags.amenity || null,
      tags.office || null,
      tags.tourism || null,
      tags.leisure || null,
      tags.craft || null,
      tags.healthcare || null,
      tags.natural || null,
      tags.man_made || null,
      JSON.stringify(tagsExtra),
      JSON.stringify(feature.properties.relations),
      JSON.stringify(feature.properties.meta),
      feature.properties.tainted,
    ],
  );
}

async function upsertLineFeature(client: PoolClient, feature: NormalizedFeature): Promise<void> {
  const tags = feature.properties.tags;
  const tagsExtra = omitKeys(tags, ROAD_TAG_COLUMNS);
  const sql = await upsertLineFeatureSqlPromise;

  await client.query(
    sql,
    [
      feature.properties.osmType,
      feature.properties.osmId,
      JSON.stringify(feature.geometry),
      tags.name || null,
      tags.highway || null,
      tags.railway || null,
      tags.waterway || null,
      tags.man_made || null,
      JSON.stringify(tagsExtra),
      JSON.stringify(feature.properties.relations),
      JSON.stringify(feature.properties.meta),
      feature.properties.tainted,
    ],
  );
}

async function upsertAreaFeature(client: PoolClient, feature: NormalizedFeature): Promise<void> {
  const tags = feature.properties.tags;
  const tagsExtra = omitKeys(tags, AREA_TAG_COLUMNS);
  const sql = await upsertAreaFeatureSqlPromise;

  await client.query(
    sql,
    [
      feature.properties.osmType,
      feature.properties.osmId,
      JSON.stringify(feature.geometry),
      tags.name || null,
      tags.landuse || null,
      tags.natural || null,
      tags.leisure || null,
      tags.amenity || null,
      JSON.stringify(tagsExtra),
      JSON.stringify(feature.properties.relations),
      JSON.stringify(feature.properties.meta),
      feature.properties.tainted,
    ],
  );
}

function omitKeys<T extends string>(source: Record<string, string>, keys: readonly T[]): Record<string, string> {
  // 结构化列已经单独存表字段，tags_extra 只保留剩余补充标签。
  const keySet = new Set<string>(keys);
  return Object.fromEntries(Object.entries(source).filter(([key]) => !keySet.has(key)));
}

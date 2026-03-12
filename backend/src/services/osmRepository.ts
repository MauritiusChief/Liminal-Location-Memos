import type { Geometry, Point, Polygon, MultiPolygon } from 'geojson';
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../db/client.js';
import type {
  NormalizedFeature,
  NormalizedOverpassRequest,
  ContainedPoi,
  RelationReference,
} from './overpassNormalization.js';
import type {
  DbFeatureDetail,
  DbFeatureCategory,
  DbMicroGridCellRecord,
  DbPolarFeatureRecord,
} from './dbSceneTypes.js';
import { AREA_TAG_KEYS, POI_TAG_KEYS, ROAD_TAG_KEYS } from './overpassLabels.js';

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
};

const BUILDING_TAG_COLUMNS = ['name', 'building', 'height', 'level', 'building_levels'] as const;
const POI_TAG_COLUMNS = ['name', 'brand', ...POI_TAG_KEYS] as const;
const ROAD_TAG_COLUMNS = ['name', ...ROAD_TAG_KEYS] as const;
const AREA_TAG_COLUMNS = ['name', ...AREA_TAG_KEYS] as const;

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
      if (isDbBuildingFeature(feature)) {
        await upsertBuildingFeature(client, feature);
        buildings += 1;
        continue;
      }

      if (isDbPoiFeature(feature)) {
        await upsertPoiFeature(client, feature);
        pois += 1;
        continue;
      }

      if (isDbLineFeature(feature)) {
        await upsertLineFeature(client, feature);
        lines += 1;
        continue;
      }

      if (isDbAreaFeature(feature)) {
        await upsertAreaFeature(client, feature);
        areas += 1;
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

// 这层把“后续文案与调试真正会消费的要素字段”统一取回。
// 建筑单独走一条查询，是为了顺手把 containedPois 一并在 SQL 里算好。
export async function fetchFeatureDetailsFromDb(request: NormalizedOverpassRequest): Promise<DbFeatureDetail[]> {
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
      tainted: row.tainted,
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
      tainted: row.tainted,
    })),
  ];
}

// grid 的空间命中全部下沉到 PostGIS：
// 1. 生成 12x12 固定网格
// 2. 用 cell center 判定 building/area 基底
// 3. 用 cell bbox 收集 poi / road 叠加层
export async function fetchMicroGridFromDb(request: NormalizedOverpassRequest): Promise<DbMicroGridCellRecord[]> {
  if (request.radius <= 50) {
    return [];
  }

  const result = await query<MicroGridCellRow>(
    `
    WITH params AS (
      SELECT
        $1::double precision AS lon,
        $2::double precision AS lat,
        -- 这里沿用旧 grid 的近似换算，只是把计算地点从 TS 挪到了 SQL。
        5.0 / 111320.0 AS lat_per_cell,
        5.0 / (111320.0 * GREATEST(ABS(COS(RADIANS($2))), 1e-10)) AS lon_per_cell,
        30.0 / 111320.0 AS lat_half_extent,
        30.0 / (111320.0 * GREATEST(ABS(COS(RADIANS($2))), 1e-10)) AS lon_half_extent
    ),
    grid_cells AS (
      SELECT
        row_index AS row,
        col_index AS col,
        ST_SetSRID(
          ST_MakeEnvelope(
            (p.lon - p.lon_half_extent) + col_index * p.lon_per_cell,
            (p.lat + p.lat_half_extent) - (row_index + 1) * p.lat_per_cell,
            (p.lon - p.lon_half_extent) + (col_index + 1) * p.lon_per_cell,
            (p.lat + p.lat_half_extent) - row_index * p.lat_per_cell,
            4326
          ),
          4326
        ) AS cell_bbox,
        ST_SetSRID(
          ST_MakePoint(
            (p.lon - p.lon_half_extent) + (col_index + 0.5) * p.lon_per_cell,
            (p.lat + p.lat_half_extent) - (row_index + 0.5) * p.lat_per_cell
          ),
          4326
        ) AS center_geom
      FROM params p
      CROSS JOIN generate_series(0, 11) AS row_index
      CROSS JOIN generate_series(0, 11) AS col_index
    )
    SELECT
      c.row,
      c.col,
      ST_X(c.center_geom) AS center_lon,
      ST_Y(c.center_geom) AS center_lat,
      CASE
        WHEN building_match.feature_id IS NOT NULL THEN 'building'
        WHEN area_match.feature_id IS NOT NULL THEN 'area'
        ELSE 'empty'
      END AS base_kind,
      -- building 优先级高于 area，这里保持旧 grid 的判定顺序。
      COALESCE(building_match.feature_id, area_match.feature_id) AS base_feature_id,
      poi_matches.feature_ids AS poi_feature_ids,
      road_matches.feature_ids AS road_feature_ids
    FROM grid_cells c
    LEFT JOIN LATERAL (
      SELECT b.osm_type || '/' || b.osm_id AS feature_id
      FROM osm_buildings b
      WHERE ST_Covers(b.geom, c.center_geom)
      -- 多个面同时命中时优先选择更小的面，尽量保留更具体的空间对象。
      ORDER BY ST_Area(b.geom::geography) ASC, b.osm_id ASC
      LIMIT 1
    ) AS building_match ON true
    LEFT JOIN LATERAL (
      SELECT f.osm_type || '/' || f.osm_id AS feature_id
      FROM osm_area_features f
      WHERE ST_Covers(f.geom, c.center_geom)
      ORDER BY ST_Area(f.geom::geography) ASC, f.osm_id ASC
      LIMIT 1
    ) AS area_match ON true
    LEFT JOIN LATERAL (
      SELECT ARRAY_AGG(p.osm_type || '/' || p.osm_id ORDER BY p.osm_id ASC) AS feature_ids
      FROM osm_pois p
      WHERE ST_Intersects(p.geom, c.cell_bbox)
    ) AS poi_matches ON true
    LEFT JOIN LATERAL (
      SELECT ARRAY_AGG(f.osm_type || '/' || f.osm_id ORDER BY f.osm_id ASC) AS feature_ids
      FROM osm_line_features f
      WHERE ST_Intersects(f.geom, c.cell_bbox)
    ) AS road_matches ON true
    ORDER BY c.row ASC, c.col ASC
    `,
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

// polar 的 DB 查询只做“取候选 + 裁剪几何 + 导出坐标样本”。
// bearing、群聚、视野角宽这类叙述性压缩继续保留在 TS，便于调参和阅读。
export async function fetchPolarFeaturesFromDb(request: NormalizedOverpassRequest): Promise<DbPolarFeatureRecord[]> {
  const radiusMeters = Math.min(request.radius, 1000);
  if (radiusMeters <= 30) {
    return [];
  }

  const result = await query<PolarFeatureRow>(
    `
    WITH query_circle AS (
      SELECT
        ST_Buffer(ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3)::geometry AS geom,
        ST_SetSRID(ST_MakePoint($1, $2), 4326) AS origin_geom
    ),
    candidates AS (
      SELECT
        v.feature_id,
        v.osm_type,
        v.osm_id,
        v.category,
        v.geometry_type,
        CASE
          -- 点要素不需要裁剪；线和面则先与查询圆求交，避免把远处拓扑一并带入 polar。
          WHEN GeometryType(v.geom) = 'POINT' THEN v.geom
          ELSE ST_Intersection(v.geom, qc.geom)
        END AS clipped_geom,
        CASE
          -- center_geom 只承担“大致朝向”的输入，不追求几何学质心。
          WHEN GeometryType(v.geom) = 'POINT' THEN v.geom
          ELSE ST_PointOnSurface(ST_Intersection(v.geom, qc.geom))
        END AS center_geom
      FROM osm_debug_feature_index_v v
      CROSS JOIN query_circle qc
      WHERE ST_Intersects(v.geom, qc.geom)
    ),
    dump_points AS (
      SELECT
        c.feature_id,
        c.osm_type,
        c.osm_id,
        c.category,
        c.geometry_type,
        c.center_geom,
        (dp).geom AS point_geom
      FROM candidates c
      CROSS JOIN LATERAL ST_DumpPoints(c.clipped_geom) AS dp
      WHERE NOT ST_IsEmpty(c.clipped_geom)
    )
    SELECT
      p.feature_id,
      p.osm_type,
      p.osm_id,
      p.category,
      p.geometry_type,
      -- 这里用 jsonb 聚合坐标，避免 pg 对多维数组的解析形状不稳定。
      jsonb_agg(jsonb_build_array(ST_X(p.point_geom), ST_Y(p.point_geom)) ORDER BY ST_X(p.point_geom), ST_Y(p.point_geom)) AS sample_coordinates,
      jsonb_build_array(MIN(ST_X(p.center_geom)), MIN(ST_Y(p.center_geom))) AS center_coordinate
    FROM dump_points p
    GROUP BY p.feature_id, p.osm_type, p.osm_id, p.category, p.geometry_type
    ORDER BY p.osm_id ASC
    `,
    [request.lon, request.lat, radiusMeters],
  );

  return result.rows.map((row) => ({
    featureId: row.feature_id,
    osmType: row.osm_type,
    osmId: row.osm_id,
    category: row.category,
    geometryType: row.geometry_type,
    sampleCoordinates: (row.sample_coordinates || []).map((pair) => [Number(pair[0]), Number(pair[1])]),
    centerCoordinate: row.center_coordinate
      ? [Number(row.center_coordinate[0]), Number(row.center_coordinate[1])]
      : null,
  }));
}

// 这里取的是“建筑详情 + 建筑内 POI”，供标签、grid 补充细节、prompt 共用。
async function fetchBuildingDetails(request: NormalizedOverpassRequest): Promise<BuildingRow[]> {
  const result = await query<BuildingRow>(
    `
    WITH query_circle AS (
      SELECT ST_Buffer(ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3)::geometry AS geom
    ),
    candidate_buildings AS (
      SELECT b.*
      FROM osm_buildings b
      CROSS JOIN query_circle qc
      WHERE ST_Intersects(b.geom, qc.geom)
    ),
    candidate_pois AS (
      SELECT p.*
      FROM osm_pois p
      CROSS JOIN query_circle qc
      WHERE ST_Intersects(p.geom, qc.geom)
    ),
    poi_best_building AS (
      SELECT
        p.osm_type AS poi_osm_type,
        p.osm_id AS poi_osm_id,
        b.osm_type AS building_osm_type,
        b.osm_id AS building_osm_id,
        ROW_NUMBER() OVER (
          PARTITION BY p.osm_type, p.osm_id
          ORDER BY ST_Area(b.geom::geography) ASC, b.osm_id ASC
        ) AS row_number
      FROM candidate_pois p
      -- 建筑包含 POI 的归属关系统一以 PostGIS 的 covers 为准。
      JOIN candidate_buildings b ON ST_Covers(b.geom, p.geom)
    ),
    assigned_pois AS (
      SELECT
        pbb.building_osm_type,
        pbb.building_osm_id,
        p.osm_type,
        p.osm_id,
        p.name,
        p.brand,
        p.shop,
        p.amenity,
        p.office,
        p.tourism,
        p.leisure,
        p.craft,
        p.healthcare,
        p.tags_extra,
        p.relations,
        p.meta,
        p.tainted,
        ST_X(p.geom) AS lon,
        ST_Y(p.geom) AS lat
      FROM poi_best_building pbb
      JOIN candidate_pois p
        ON p.osm_type = pbb.poi_osm_type
       AND p.osm_id = pbb.poi_osm_id
      WHERE pbb.row_number = 1
    )
    SELECT
      b.osm_type || '/' || b.osm_id AS feature_id,
      b.osm_type,
      b.osm_id,
      GeometryType(b.geom) AS geometry_type,
      jsonb_strip_nulls(
        jsonb_build_object(
          'name', b.name,
          'building', b.building,
          'height', b.height,
          'level', b.level,
          'building:levels', b.building_levels
        ) || b.tags_extra
      )::jsonb AS tags,
      b.relations,
      b.meta,
      b.tainted,
      COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'osmType', ap.osm_type,
            'osmId', ap.osm_id,
            'tags', jsonb_strip_nulls(
              jsonb_build_object(
                'name', ap.name,
                'brand', ap.brand,
                'shop', ap.shop,
                'amenity', ap.amenity,
                'office', ap.office,
                'tourism', ap.tourism,
                'leisure', ap.leisure,
                'craft', ap.craft,
                'healthcare', ap.healthcare
              ) || ap.tags_extra
            ),
            'relations', ap.relations,
            'meta', ap.meta,
            'tainted', ap.tainted,
            'coordinate', jsonb_build_array(ap.lon, ap.lat),
            'sourceFeatureId', ap.osm_type || '/' || ap.osm_id
          )
          ORDER BY ap.osm_id ASC
        ) FILTER (WHERE ap.osm_id IS NOT NULL),
        '[]'::jsonb
      ) AS contained_pois
    FROM candidate_buildings b
    LEFT JOIN assigned_pois ap
      ON ap.building_osm_type = b.osm_type
     AND ap.building_osm_id = b.osm_id
    GROUP BY
      b.osm_type,
      b.osm_id,
      b.geom,
      b.name,
      b.building,
      b.height,
      b.level,
      b.building_levels,
      b.tags_extra,
      b.relations,
      b.meta,
      b.tainted
    ORDER BY b.osm_id ASC
    `,
    [request.lon, request.lat, request.radius],
  );

  return result.rows;
}

// 非 building 的详情直接从调试视图取，避免在 TS 里重复拼 tags。
async function fetchNonBuildingDetails(request: NormalizedOverpassRequest): Promise<FeatureDetailRow[]> {
  const result = await query<FeatureDetailRow>(
    `
    WITH query_circle AS (
      SELECT ST_Buffer(ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3)::geometry AS geom
    )
    SELECT
      v.feature_id,
      v.osm_type,
      v.osm_id,
      v.category,
      v.geometry_type,
      v.tags,
      v.relations,
      v.meta,
      v.tainted
    FROM osm_debug_feature_index_v v
    CROSS JOIN query_circle qc
    WHERE v.category <> 'building'
      AND ST_Intersects(v.geom, qc.geom)
    ORDER BY v.osm_id ASC
    `,
    [request.lon, request.lat, request.radius],
  );

  return result.rows;
}

async function upsertBuildingFeature(client: PoolClient, feature: NormalizedFeature): Promise<void> {
  const tags = feature.properties.tags;
  const tagsExtra = omitKeys(tags, BUILDING_TAG_COLUMNS);

  await client.query(
    `
    INSERT INTO osm_buildings (
      osm_type, osm_id, geom, name, building, height, level, building_levels,
      tags_extra, relations, meta, tainted, last_synced_at
    )
    VALUES (
      $1, $2, ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($3), 4326)),
      $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12, now()
    )
    ON CONFLICT (osm_type, osm_id)
    DO UPDATE SET
      geom = EXCLUDED.geom,
      name = EXCLUDED.name,
      building = EXCLUDED.building,
      height = EXCLUDED.height,
      level = EXCLUDED.level,
      building_levels = EXCLUDED.building_levels,
      tags_extra = EXCLUDED.tags_extra,
      relations = EXCLUDED.relations,
      meta = EXCLUDED.meta,
      tainted = EXCLUDED.tainted,
      last_synced_at = now()
    `,
    [
      feature.properties.osmType,
      feature.properties.osmId,
      JSON.stringify(feature.geometry),
      tags.name || null,
      tags.building || null,
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

  await client.query(
    `
    INSERT INTO osm_pois (
      osm_type, osm_id, geom, name, brand, shop, amenity, office, tourism, leisure, craft, healthcare,
      tags_extra, relations, meta, tainted, last_synced_at
    )
    VALUES (
      $1, $2, ST_SetSRID(ST_GeomFromGeoJSON($3), 4326),
      $4, $5, $6, $7, $8, $9, $10, $11, $12,
      $13::jsonb, $14::jsonb, $15::jsonb, $16, now()
    )
    ON CONFLICT (osm_type, osm_id)
    DO UPDATE SET
      geom = EXCLUDED.geom,
      name = EXCLUDED.name,
      brand = EXCLUDED.brand,
      shop = EXCLUDED.shop,
      amenity = EXCLUDED.amenity,
      office = EXCLUDED.office,
      tourism = EXCLUDED.tourism,
      leisure = EXCLUDED.leisure,
      craft = EXCLUDED.craft,
      healthcare = EXCLUDED.healthcare,
      tags_extra = EXCLUDED.tags_extra,
      relations = EXCLUDED.relations,
      meta = EXCLUDED.meta,
      tainted = EXCLUDED.tainted,
      last_synced_at = now()
    `,
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

  await client.query(
    `
    INSERT INTO osm_line_features (
      osm_type, osm_id, geom, name, highway, railway, waterway, tags_extra, relations, meta, tainted, last_synced_at
    )
    VALUES (
      $1, $2, ST_SetSRID(ST_GeomFromGeoJSON($3), 4326),
      $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11, now()
    )
    ON CONFLICT (osm_type, osm_id)
    DO UPDATE SET
      geom = EXCLUDED.geom,
      name = EXCLUDED.name,
      highway = EXCLUDED.highway,
      railway = EXCLUDED.railway,
      waterway = EXCLUDED.waterway,
      tags_extra = EXCLUDED.tags_extra,
      relations = EXCLUDED.relations,
      meta = EXCLUDED.meta,
      tainted = EXCLUDED.tainted,
      last_synced_at = now()
    `,
    [
      feature.properties.osmType,
      feature.properties.osmId,
      JSON.stringify(feature.geometry),
      tags.name || null,
      tags.highway || null,
      tags.railway || null,
      tags.waterway || null,
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

  await client.query(
    `
    INSERT INTO osm_area_features (
      osm_type, osm_id, geom, name, landuse, "natural", leisure, amenity, tags_extra, relations, meta, tainted, last_synced_at
    )
    VALUES (
      $1, $2, ST_SetSRID(ST_GeomFromGeoJSON($3), 4326),
      $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12, now()
    )
    ON CONFLICT (osm_type, osm_id)
    DO UPDATE SET
      geom = EXCLUDED.geom,
      name = EXCLUDED.name,
      landuse = EXCLUDED.landuse,
      "natural" = EXCLUDED.natural,
      leisure = EXCLUDED.leisure,
      amenity = EXCLUDED.amenity,
      tags_extra = EXCLUDED.tags_extra,
      relations = EXCLUDED.relations,
      meta = EXCLUDED.meta,
      tainted = EXCLUDED.tainted,
      last_synced_at = now()
    `,
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

function isDbBuildingFeature(feature: NormalizedFeature): boolean {
  return isPolygonGeometry(feature.geometry) && typeof feature.properties.tags.building === 'string';
}

function isDbPoiFeature(feature: NormalizedFeature): boolean {
  // 点要素只保留明确可视为 POI 的功能点。
  return isPointGeometry(feature.geometry) && POI_TAG_KEYS.some((key) => typeof feature.properties.tags[key] === 'string');
}

function isDbLineFeature(feature: NormalizedFeature): boolean {
  return isLineGeometry(feature.geometry) && ROAD_TAG_KEYS.some((key) => typeof feature.properties.tags[key] === 'string');
}

function isDbAreaFeature(feature: NormalizedFeature): boolean {
  return isPolygonGeometry(feature.geometry) && AREA_TAG_KEYS.some((key) => typeof feature.properties.tags[key] === 'string');
}

function isPointGeometry(geometry: Geometry): geometry is Point {
  return geometry.type === 'Point';
}

function isLineGeometry(geometry: Geometry): boolean {
  return geometry.type === 'LineString' || geometry.type === 'MultiLineString';
}

function isPolygonGeometry(geometry: Geometry): geometry is Polygon | MultiPolygon {
  return geometry.type === 'Polygon' || geometry.type === 'MultiPolygon';
}

function omitKeys<T extends string>(source: Record<string, string>, keys: readonly T[]): Record<string, string> {
  // 结构化列已经单独存表字段，tags_extra 只保留剩余补充标签。
  const keySet = new Set<string>(keys);
  return Object.fromEntries(Object.entries(source).filter(([key]) => !keySet.has(key)));
}

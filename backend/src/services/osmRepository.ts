import type { PoolClient } from 'pg';
import { isPointGeometry, isPolygonalGeometry } from './overpassGeometry.js';
import { AREA_TAG_KEYS, POI_TAG_KEYS, ROAD_TAG_KEYS } from './overpassLabels.js';
import type {
  ContainedPoi,
  NormalizedFeature,
  NormalizedFeatureProperties,
  NormalizedOverpassRequest,
  RelationReference,
} from './overpassNormalization.js';
import { query, withTransaction } from '../db/client.js';

type BuildingRow = {
  osm_type: string;
  osm_id: number;
  geometry_geojson: string;
  tags: Record<string, string>;
  relations: RelationReference[];
  meta: Record<string, string | number>;
  tainted: boolean;
  contained_pois: ContainedPoi[] | null;
};

type FeatureRow = {
  osm_type: string;
  osm_id: number;
  geometry_geojson: string;
  tags: Record<string, string>;
  relations: RelationReference[];
  meta: Record<string, string | number>;
  tainted: boolean;
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

    // 这里故意不是把 normalize 后的所有 feature 原样落库，
    // 而是只保留“后续环境摘要真正会消费的几类对象”。
    // 因此 DB 路径天然会比直接 `/overpass/normalize` 少一批 feature：
    // 例如 highway=crossing 的点、行政区 label 点、route relation 线、boundary relation 面。
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

// #####################
// #region 数据库提取函数
// #####################

export async function fetchFeaturesFromDb(request: NormalizedOverpassRequest): Promise<NormalizedFeature[]> {
  // DB 调试链路只能读回“之前真的入过库的子集”。
  // 所以如果某类 feature 在 sync 阶段就被刻意忽略，这里不会再凭空恢复出来。
  const [buildingRows, poiRows, lineRows, areaRows] = await Promise.all([
    fetchBuildingsWithContainedPois(request),
    fetchPois(request),
    fetchLineFeatures(request),
    fetchAreaFeatures(request),
  ]);

  return [
    ...buildingRows.map((row) => toNormalizedBuildingFeature(row)),
    ...poiRows.map((row) => toNormalizedFeature(row)),
    ...lineRows.map((row) => toNormalizedFeature(row)),
    ...areaRows.map((row) => toNormalizedFeature(row)),
  ];
}

async function fetchBuildingsWithContainedPois(request: NormalizedOverpassRequest): Promise<BuildingRow[]> {
  const result = await query<BuildingRow>(
    `
    WITH query_circle AS (
      SELECT ST_Buffer(
        ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
        $3
      )::geometry AS geom
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
      JOIN candidate_buildings b
        ON ST_Covers(b.geom, p.geom)
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
      JOIN osm_pois p
        ON p.osm_type = pbb.poi_osm_type
       AND p.osm_id = pbb.poi_osm_id
      WHERE pbb.row_number = 1
    )
    SELECT
      b.osm_type,
      b.osm_id,
      ST_AsGeoJSON(b.geom) AS geometry_geojson,
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

async function fetchPois(request: NormalizedOverpassRequest): Promise<FeatureRow[]> {
  const result = await query<FeatureRow>(
    `
    WITH query_circle AS (
      SELECT ST_Buffer(
        ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
        $3
      )::geometry AS geom
    )
    SELECT
      p.osm_type,
      p.osm_id,
      ST_AsGeoJSON(p.geom) AS geometry_geojson,
      jsonb_strip_nulls(
        jsonb_build_object(
          'name', p.name,
          'brand', p.brand,
          'shop', p.shop,
          'amenity', p.amenity,
          'office', p.office,
          'tourism', p.tourism,
          'leisure', p.leisure,
          'craft', p.craft,
          'healthcare', p.healthcare
        ) || p.tags_extra
      )::jsonb AS tags,
      p.relations,
      p.meta,
      p.tainted
    FROM osm_pois p
    CROSS JOIN query_circle qc
    WHERE ST_Intersects(p.geom, qc.geom)
    ORDER BY p.osm_id ASC
    `,
    [request.lon, request.lat, request.radius],
  );

  return result.rows;
}

async function fetchLineFeatures(request: NormalizedOverpassRequest): Promise<FeatureRow[]> {
  const result = await query<FeatureRow>(
    `
    WITH query_circle AS (
      SELECT ST_Buffer(
        ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
        $3
      )::geometry AS geom
    )
    SELECT
      f.osm_type,
      f.osm_id,
      ST_AsGeoJSON(f.geom) AS geometry_geojson,
      jsonb_strip_nulls(
        jsonb_build_object(
          'name', f.name,
          'highway', f.highway,
          'railway', f.railway,
          'waterway', f.waterway
        ) || f.tags_extra
      )::jsonb AS tags,
      f.relations,
      f.meta,
      f.tainted
    FROM osm_line_features f
    CROSS JOIN query_circle qc
    WHERE ST_Intersects(f.geom, qc.geom)
    ORDER BY f.osm_id ASC
    `,
    [request.lon, request.lat, request.radius],
  );

  return result.rows;
}

async function fetchAreaFeatures(request: NormalizedOverpassRequest): Promise<FeatureRow[]> {
  const result = await query<FeatureRow>(
    `
    WITH query_circle AS (
      SELECT ST_Buffer(
        ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
        $3
      )::geometry AS geom
    )
    SELECT
      f.osm_type,
      f.osm_id,
      ST_AsGeoJSON(f.geom) AS geometry_geojson,
      jsonb_strip_nulls(
        jsonb_build_object(
          'name', f.name,
          'landuse', f.landuse,
          'natural', f.natural,
          'leisure', f.leisure,
          'amenity', f.amenity
        ) || f.tags_extra
      )::jsonb AS tags,
      f.relations,
      f.meta,
      f.tainted
    FROM osm_area_features f
    CROSS JOIN query_circle qc
    WHERE ST_Intersects(f.geom, qc.geom)
    ORDER BY f.osm_id ASC
    `,
    [request.lon, request.lat, request.radius],
  );

  return result.rows;
}

// #####################
// #region 插入数据库函数
// #####################

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

// ##################
// #region 规整化函数
// ##################

function toNormalizedBuildingFeature(row: BuildingRow): NormalizedFeature {
  return {
    type: 'Feature',
    id: `${row.osm_type}/${row.osm_id}`,
    geometry: JSON.parse(row.geometry_geojson) as NormalizedFeature['geometry'],
    properties: {
      osmType: row.osm_type,
      osmId: row.osm_id,
      tags: row.tags,
      relations: row.relations || [],
      meta: row.meta || {},
      tainted: row.tainted,
      containedPois: row.contained_pois && row.contained_pois.length > 0 ? row.contained_pois : undefined,
    },
  };
}

function toNormalizedFeature(row: FeatureRow): NormalizedFeature {
  return {
    type: 'Feature',
    id: `${row.osm_type}/${row.osm_id}`,
    geometry: JSON.parse(row.geometry_geojson) as NormalizedFeature['geometry'],
    properties: {
      osmType: row.osm_type,
      osmId: row.osm_id,
      tags: row.tags,
      relations: row.relations || [],
      meta: row.meta || {},
      tainted: row.tainted,
    },
  };
}

// ################
// #region 把关函数
// ################

function isDbBuildingFeature(feature: NormalizedFeature): boolean {
  return isPolygonalGeometry(feature.geometry) && typeof feature.properties.tags.building === 'string';
}

function isDbPoiFeature(feature: NormalizedFeature): boolean {
  // 点要素这里收得很窄，只把可视作 POI 的功能点入库。
  // 因而像 highway=crossing 这种道路附属点，或 relation 的 label node，
  // 即使在 `/overpass/normalize` 里存在，也不会进入 `osm_pois`。
  return isPointGeometry(feature.geometry) && POI_TAG_KEYS.some((key) => typeof feature.properties.tags[key] === 'string');
}

function isDbLineFeature(feature: NormalizedFeature): boolean {
  const geometryType = feature.geometry.type;
  const isLineGeometry = geometryType === 'LineString' || geometryType === 'MultiLineString';

  // 线要素只保留真正的 highway / railway / waterway。
  // 所以像 route=bicycle 这种 relation 汇总线，因为主分类键不在 ROAD_TAG_KEYS 中，会被有意略过。
  return isLineGeometry && ROAD_TAG_KEYS.some((key) => typeof feature.properties.tags[key] === 'string');
}

function isDbAreaFeature(feature: NormalizedFeature): boolean {
  // 面要素也不是“所有 Polygon 都入库”，只保留 landuse / natural / leisure / amenity 这几类环境面。
  // 行政区 boundary、admin_level 之类虽然在 API 结果里能看到，但不属于当前 DB 摘要模型，因此不会写入。
  return isPolygonalGeometry(feature.geometry) && AREA_TAG_KEYS.some((key) => typeof feature.properties.tags[key] === 'string');
}

function omitKeys<T extends string>(source: Record<string, string>, keys: readonly T[]): Record<string, string> {
  const keySet = new Set<string>(keys);
  return Object.fromEntries(Object.entries(source).filter(([key]) => !keySet.has(key)));
}

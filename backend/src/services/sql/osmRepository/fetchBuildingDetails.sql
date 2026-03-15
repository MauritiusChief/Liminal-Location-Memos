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
    p."natural",
    p.man_made,
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
      'man_made', b.man_made,
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
            'healthcare', ap.healthcare,
            'natural', ap."natural",
            'man_made', ap.man_made
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
  b.man_made,
  b.height,
  b.level,
  b.building_levels,
  b.tags_extra,
  b.relations,
  b.meta,
  b.tainted
ORDER BY b.osm_id ASC;

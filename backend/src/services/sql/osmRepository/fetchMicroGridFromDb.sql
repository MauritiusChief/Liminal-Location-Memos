WITH grid_geometries AS (
  SELECT
    c.row,
    c.col,
    ST_SetSRID(ST_MakePoint(c.center_lon, c.center_lat), 4326) AS center_geom,
    ST_GeomFromText(c.bbox_wkt, 4326) AS cell_bbox
  FROM jsonb_to_recordset($1::jsonb) AS c(
    row integer,
    col integer,
    center_lon double precision,
    center_lat double precision,
    bbox_wkt text
  )
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
FROM grid_geometries c
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
ORDER BY c.row ASC, c.col ASC;

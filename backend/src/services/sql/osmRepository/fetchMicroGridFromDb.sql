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
ORDER BY c.row ASC, c.col ASC;

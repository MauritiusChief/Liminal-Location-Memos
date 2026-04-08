WITH params AS (
  SELECT
    MOD(MOD($3::double precision, 360.0) + 360.0, 360.0) AS orientation_degrees,
    ST_SetSRID(ST_MakePoint($1::double precision, $2::double precision), 4326)::geography AS center_geog
),
grid_cells AS (
  SELECT
    row_index AS row,
    col_index AS col,
    -30.0 + col_index * 5.0 AS left_x_m,
    -30.0 + (col_index + 1) * 5.0 AS right_x_m,
    30.0 - row_index * 5.0 AS top_y_m,
    30.0 - (row_index + 1) * 5.0 AS bottom_y_m
  FROM generate_series(0, 11) AS row_index
  CROSS JOIN generate_series(0, 11) AS col_index
),
grid_geometries AS (
  SELECT
    c.row,
    c.col,
    ST_MakePolygon(
      ST_MakeLine(ARRAY[
        point_data.top_left_geom,
        point_data.top_right_geom,
        point_data.bottom_right_geom,
        point_data.bottom_left_geom,
        point_data.top_left_geom
      ])
    ) AS cell_bbox,
    point_data.center_geom
  FROM grid_cells c
  CROSS JOIN params p
  CROSS JOIN LATERAL (
    SELECT
      ST_Project(
        p.center_geog,
        SQRT(POWER(center_east_m, 2) + POWER(center_north_m, 2)),
        ATAN2(center_east_m, center_north_m)
      )::geometry AS center_geom,
      ST_Project(
        p.center_geog,
        SQRT(POWER(top_left_east_m, 2) + POWER(top_left_north_m, 2)),
        ATAN2(top_left_east_m, top_left_north_m)
      )::geometry AS top_left_geom,
      ST_Project(
        p.center_geog,
        SQRT(POWER(top_right_east_m, 2) + POWER(top_right_north_m, 2)),
        ATAN2(top_right_east_m, top_right_north_m)
      )::geometry AS top_right_geom,
      ST_Project(
        p.center_geog,
        SQRT(POWER(bottom_right_east_m, 2) + POWER(bottom_right_north_m, 2)),
        ATAN2(bottom_right_east_m, bottom_right_north_m)
      )::geometry AS bottom_right_geom,
      ST_Project(
        p.center_geog,
        SQRT(POWER(bottom_left_east_m, 2) + POWER(bottom_left_north_m, 2)),
        ATAN2(bottom_left_east_m, bottom_left_north_m)
      )::geometry AS bottom_left_geom
    FROM (
      SELECT
        ((c.left_x_m + c.right_x_m) / 2.0) * COS(RADIANS(p.orientation_degrees))
          + ((c.top_y_m + c.bottom_y_m) / 2.0) * SIN(RADIANS(p.orientation_degrees)) AS center_east_m,
        ((c.top_y_m + c.bottom_y_m) / 2.0) * COS(RADIANS(p.orientation_degrees))
          - ((c.left_x_m + c.right_x_m) / 2.0) * SIN(RADIANS(p.orientation_degrees)) AS center_north_m,
        c.left_x_m * COS(RADIANS(p.orientation_degrees)) + c.top_y_m * SIN(RADIANS(p.orientation_degrees)) AS top_left_east_m,
        c.top_y_m * COS(RADIANS(p.orientation_degrees)) - c.left_x_m * SIN(RADIANS(p.orientation_degrees)) AS top_left_north_m,
        c.right_x_m * COS(RADIANS(p.orientation_degrees)) + c.top_y_m * SIN(RADIANS(p.orientation_degrees)) AS top_right_east_m,
        c.top_y_m * COS(RADIANS(p.orientation_degrees)) - c.right_x_m * SIN(RADIANS(p.orientation_degrees)) AS top_right_north_m,
        c.right_x_m * COS(RADIANS(p.orientation_degrees)) + c.bottom_y_m * SIN(RADIANS(p.orientation_degrees)) AS bottom_right_east_m,
        c.bottom_y_m * COS(RADIANS(p.orientation_degrees)) - c.right_x_m * SIN(RADIANS(p.orientation_degrees)) AS bottom_right_north_m,
        c.left_x_m * COS(RADIANS(p.orientation_degrees)) + c.bottom_y_m * SIN(RADIANS(p.orientation_degrees)) AS bottom_left_east_m,
        c.bottom_y_m * COS(RADIANS(p.orientation_degrees)) - c.left_x_m * SIN(RADIANS(p.orientation_degrees)) AS bottom_left_north_m
    ) AS rotated_offsets
  ) AS point_data
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

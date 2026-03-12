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
ORDER BY p.osm_id ASC;

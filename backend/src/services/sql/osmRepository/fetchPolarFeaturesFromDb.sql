WITH query_circle AS (
  SELECT
    ST_Buffer(ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3)::geometry AS geom
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
      -- center_geom 继续作为“中心候选点”来源，
      -- line 后续仍沿用它做 centerPoint，但不会把它混进 line 的 4 顶点或 SVG 路径。
      WHEN GeometryType(v.geom) = 'POINT' THEN v.geom
      ELSE ST_PointOnSurface(ST_Intersection(v.geom, qc.geom))
    END AS center_geom
  FROM osm_combined_feature_index_v v
  CROSS JOIN query_circle qc
  WHERE ST_Intersects(v.geom, qc.geom)
),
line_parts AS (
  SELECT
    c.feature_id,
    c.osm_type,
    c.osm_id,
    c.category,
    c.geometry_type,
    c.center_geom,
    (part_dump).geom AS line_geom
  FROM candidates c
  CROSS JOIN LATERAL ST_Dump(ST_CollectionExtract(c.clipped_geom, 2)) AS part_dump
  WHERE c.category = 'line'
    AND NOT ST_IsEmpty(c.clipped_geom)
),
ranked_line_parts AS (
  SELECT
    lp.*,
    ROW_NUMBER() OVER (
      PARTITION BY lp.feature_id
      ORDER BY ST_Length(lp.line_geom::geography) DESC, ST_NPoints(lp.line_geom) DESC
    ) AS part_rank
  FROM line_parts lp
  WHERE GeometryType(lp.line_geom) = 'LINESTRING'
),
line_points AS (
  SELECT
    rlp.feature_id,
    rlp.osm_type,
    rlp.osm_id,
    rlp.category,
    rlp.geometry_type,
    rlp.center_geom,
    (dp).path AS point_path,
    (dp).geom AS point_geom
  FROM ranked_line_parts rlp
  CROSS JOIN LATERAL ST_DumpPoints(rlp.line_geom) AS dp
  WHERE rlp.part_rank = 1
),
line_features AS (
  SELECT
    lp.feature_id,
    lp.osm_type,
    lp.osm_id,
    lp.category,
    lp.geometry_type,
    jsonb_agg(jsonb_build_array(ST_X(lp.point_geom), ST_Y(lp.point_geom)) ORDER BY lp.point_path) AS sample_coordinates,
    jsonb_build_array(MIN(ST_X(lp.center_geom)), MIN(ST_Y(lp.center_geom))) AS center_coordinate,
    jsonb_agg(jsonb_build_array(ST_X(lp.point_geom), ST_Y(lp.point_geom)) ORDER BY lp.point_path) AS line_path_coordinates,
    jsonb_agg(jsonb_build_array(ST_X(lp.point_geom), ST_Y(lp.point_geom)) ORDER BY lp.point_path) AS line_vertex_coordinates
  FROM line_points lp
  GROUP BY lp.feature_id, lp.osm_type, lp.osm_id, lp.category, lp.geometry_type
),
non_line_points AS (
  SELECT
    c.feature_id,
    c.osm_type,
    c.osm_id,
    c.category,
    c.geometry_type,
    c.center_geom,
    (dp).path AS point_path,
    (dp).geom AS point_geom
  FROM candidates c
  CROSS JOIN LATERAL ST_DumpPoints(c.clipped_geom) AS dp
  WHERE c.category <> 'line'
    AND NOT ST_IsEmpty(c.clipped_geom)
),
non_line_features AS (
  SELECT
    p.feature_id,
    p.osm_type,
    p.osm_id,
    p.category,
    p.geometry_type,
    -- 非 line 仍然只需要一组样本点；
    -- 这里直接按拓扑顺序聚合，避免再额外引入坐标排序副作用。
    jsonb_agg(jsonb_build_array(ST_X(p.point_geom), ST_Y(p.point_geom)) ORDER BY p.point_path) AS sample_coordinates,
    jsonb_build_array(MIN(ST_X(p.center_geom)), MIN(ST_Y(p.center_geom))) AS center_coordinate,
    NULL::jsonb AS line_path_coordinates,
    NULL::jsonb AS line_vertex_coordinates
  FROM non_line_points p
  GROUP BY p.feature_id, p.osm_type, p.osm_id, p.category, p.geometry_type
)
SELECT *
FROM (
  SELECT * FROM line_features
  UNION ALL
  SELECT * FROM non_line_features
) AS all_features
ORDER BY osm_id ASC;

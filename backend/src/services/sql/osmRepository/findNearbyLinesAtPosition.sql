WITH query_point AS (
  SELECT ST_SetSRID(ST_MakePoint($1, $2), 4326) AS geom
),
query_circle AS (
  SELECT ST_Buffer(qp.geom::geography, 50)::geometry AS geom
  FROM query_point qp
)
SELECT
  f.osm_type || '/' || f.osm_id AS line_id,
  jsonb_strip_nulls(
    jsonb_build_object(
      'name', f.name,
      'highway', f.highway,
      'railway', f.railway,
      'waterway', f.waterway,
      'man_made', f.man_made
    ) || f.tags_extra
  )::jsonb AS tags
FROM osm_line_features f
CROSS JOIN query_point qp
CROSS JOIN query_circle qc
WHERE ST_Intersects(f.geom, qc.geom)
ORDER BY
  ST_Distance(f.geom::geography, qp.geom::geography) ASC,
  f.osm_id ASC;

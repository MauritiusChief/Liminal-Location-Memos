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
FROM osm_combined_feature_index_v v
CROSS JOIN query_circle qc
WHERE v.category <> 'building'
  AND ST_Intersects(v.geom, qc.geom)
ORDER BY v.osm_id ASC;

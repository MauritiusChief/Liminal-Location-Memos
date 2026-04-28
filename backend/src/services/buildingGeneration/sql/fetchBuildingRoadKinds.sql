WITH target_building AS (
  SELECT ST_Centroid(b.geom) AS center_geom
  FROM osm_buildings b
  WHERE b.osm_type = $1
    AND b.osm_id = $2
  LIMIT 1
)
SELECT COALESCE(
  ARRAY_AGG(DISTINCT 'highway:' || f.highway) FILTER (WHERE f.highway IS NOT NULL),
  ARRAY[]::text[]
) AS road_kinds
FROM target_building tb
LEFT JOIN osm_line_features f
  ON f.highway IS NOT NULL
 AND ST_DWithin(f.geom::geography, tb.center_geom::geography, $3);

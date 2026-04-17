WITH target_building AS (
  SELECT ST_Centroid(b.geom) AS center_geom
  FROM osm_buildings b
  WHERE b.osm_type = $1
    AND b.osm_id = $2
  LIMIT 1
)
SELECT COALESCE(
  ARRAY_AGG(DISTINCT area_label) FILTER (WHERE area_label IS NOT NULL),
  ARRAY[]::text[]
) AS covering_areas
FROM target_building tb
LEFT JOIN LATERAL (
  SELECT CASE
    WHEN f.landuse IS NOT NULL THEN 'landuse:' || f.landuse
    WHEN f."natural" IS NOT NULL THEN 'natural:' || f."natural"
    WHEN f.leisure IS NOT NULL THEN 'leisure:' || f.leisure
    WHEN f.amenity IS NOT NULL THEN 'amenity:' || f.amenity
    ELSE NULL
  END AS area_label
  FROM osm_area_features f
  WHERE ST_Covers(f.geom, tb.center_geom)
) AS area_match
  ON TRUE;

WITH player_point AS (
  SELECT ST_SetSRID(ST_MakePoint($1, $2), 4326) AS geom
)
SELECT
  a.osm_type || '/' || a.osm_id AS area_id,
  jsonb_strip_nulls(
    jsonb_build_object(
      'name', a.name,
      'landuse', a.landuse,
      'natural', a."natural",
      'leisure', a.leisure,
      'amenity', a.amenity
    ) || a.tags_extra
  )::jsonb AS tags,
  ST_Area(a.geom::geography) AS area_square_meters
FROM osm_area_features a
CROSS JOIN player_point pp
WHERE ST_Covers(a.geom, pp.geom)
ORDER BY ST_Area(a.geom::geography) ASC, a.osm_id ASC;

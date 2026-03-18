WITH player_point AS (
  SELECT ST_SetSRID(ST_MakePoint($1, $2), 4326) AS geom
)
SELECT
  b.osm_type || '/' || b.osm_id AS building_id,
  jsonb_strip_nulls(
    jsonb_build_object(
      'name', b.name,
      'building', b.building,
      'man_made', b.man_made,
      'height', b.height,
      'level', b.level,
      'building:levels', b.building_levels
    ) || b.tags_extra
  )::jsonb AS tags,
  ST_Area(b.geom::geography) AS area_square_meters
FROM osm_buildings b
CROSS JOIN player_point pp
WHERE ST_Covers(b.geom, pp.geom)
ORDER BY ST_Area(b.geom::geography) ASC, b.osm_id ASC
LIMIT 1;

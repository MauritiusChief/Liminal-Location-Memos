SELECT
  b.osm_type || '/' || b.osm_id AS feature_id,
  b.osm_type,
  b.osm_id,
  GeometryType(b.geom) AS geometry_type,
  ST_X(ST_Centroid(b.geom)) AS center_lon,
  ST_Y(ST_Centroid(b.geom)) AS center_lat,
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
  b.relations,
  b.outline_references,
  b.meta,
  b.tainted,
  '[]'::jsonb AS contained_pois
FROM osm_buildings b
WHERE ST_Covers(b.geom, ST_SetSRID(ST_MakePoint($1, $2), 4326))
LIMIT 1;
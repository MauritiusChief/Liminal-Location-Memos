CREATE OR REPLACE VIEW osm_combined_feature_index_v AS
SELECT
  'building'::text AS category,
  osm_type || '/' || osm_id AS feature_id,
  osm_type,
  osm_id,
  GeometryType(geom) AS geometry_type,
  jsonb_strip_nulls(
    jsonb_build_object(
      'name', name,
      'building', building,
      'man_made', man_made,
      'height', height,
      'level', level,
      'building:levels', building_levels
    ) || tags_extra
  )::jsonb AS tags,
  relations,
  meta,
  tainted,
  geom
FROM osm_buildings
UNION ALL
SELECT
  'poi'::text AS category,
  osm_type || '/' || osm_id AS feature_id,
  osm_type,
  osm_id,
  GeometryType(geom) AS geometry_type,
  jsonb_strip_nulls(
    jsonb_build_object(
      'name', name,
      'brand', brand,
      'shop', shop,
      'amenity', amenity,
      'office', office,
      'tourism', tourism,
      'leisure', leisure,
      'craft', craft,
      'healthcare', healthcare,
      'natural', "natural",
      'man_made', man_made
    ) || tags_extra
  )::jsonb AS tags,
  relations,
  meta,
  tainted,
  geom
FROM osm_pois
UNION ALL
SELECT
  'line'::text AS category,
  osm_type || '/' || osm_id AS feature_id,
  osm_type,
  osm_id,
  GeometryType(geom) AS geometry_type,
  jsonb_strip_nulls(
    jsonb_build_object(
      'name', name,
      'highway', highway,
      'railway', railway,
      'waterway', waterway,
      'man_made', man_made
    ) || tags_extra
  )::jsonb AS tags,
  relations,
  meta,
  tainted,
  geom
FROM osm_line_features
UNION ALL
SELECT
  'area'::text AS category,
  osm_type || '/' || osm_id AS feature_id,
  osm_type,
  osm_id,
  GeometryType(geom) AS geometry_type,
  jsonb_strip_nulls(
    jsonb_build_object(
      'name', name,
      'landuse', landuse,
      'natural', "natural",
      'leisure', leisure,
      'amenity', amenity
    ) || tags_extra
  )::jsonb AS tags,
  relations,
  meta,
  tainted,
  geom
FROM osm_area_features;

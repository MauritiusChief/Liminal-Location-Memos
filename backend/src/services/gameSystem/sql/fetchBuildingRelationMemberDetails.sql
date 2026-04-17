WITH target_relation AS (
  SELECT $1::bigint AS relation_id
),
candidate_buildings AS (
  SELECT b.*
  FROM osm_buildings b
  JOIN target_relation tr
    ON EXISTS (
      SELECT 1
      FROM jsonb_array_elements(b.relations) AS rel
      WHERE (rel->>'rel')::bigint = tr.relation_id
        AND rel->>'role' = 'part'
        AND COALESCE(rel->'reltags'->>'type', '') = 'building'
    )
),
candidate_pois AS (
  SELECT p.*
  FROM osm_pois p
  JOIN candidate_buildings cb
    ON ST_Covers(cb.geom, p.geom)
),
poi_best_building AS (
  SELECT
    p.osm_type AS poi_osm_type,
    p.osm_id AS poi_osm_id,
    cb.osm_type AS building_osm_type,
    cb.osm_id AS building_osm_id,
    ROW_NUMBER() OVER (
      PARTITION BY p.osm_type, p.osm_id
      ORDER BY ST_Area(cb.geom::geography) ASC, cb.osm_id ASC
    ) AS row_number
  FROM candidate_pois p
  JOIN candidate_buildings cb
    ON ST_Covers(cb.geom, p.geom)
),
assigned_pois AS (
  SELECT
    pbb.building_osm_type,
    pbb.building_osm_id,
    p.osm_type,
    p.osm_id,
    p.name,
    p.brand,
    p.shop,
    p.amenity,
    p.office,
    p.tourism,
    p.leisure,
    p.craft,
    p.healthcare,
    p."natural",
    p.man_made,
    p.tags_extra,
    p.relations,
    p.meta,
    p.tainted,
    ST_X(p.geom) AS lon,
    ST_Y(p.geom) AS lat
  FROM poi_best_building pbb
  JOIN candidate_pois p
    ON p.osm_type = pbb.poi_osm_type
   AND p.osm_id = pbb.poi_osm_id
  WHERE pbb.row_number = 1
)
SELECT
  cb.osm_type || '/' || cb.osm_id AS feature_id,
  cb.osm_type,
  cb.osm_id,
  GeometryType(cb.geom) AS geometry_type,
  jsonb_strip_nulls(
    jsonb_build_object(
      'name', cb.name,
      'building', cb.building,
      'man_made', cb.man_made,
      'height', cb.height,
      'level', cb.level,
      'building:levels', cb.building_levels
    ) || cb.tags_extra
  )::jsonb AS tags,
  cb.relations,
  cb.outline_references,
  cb.meta,
  cb.tainted,
  COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'osmType', ap.osm_type,
        'osmId', ap.osm_id,
        'tags', jsonb_strip_nulls(
          jsonb_build_object(
            'name', ap.name,
            'brand', ap.brand,
            'shop', ap.shop,
            'amenity', ap.amenity,
            'office', ap.office,
            'tourism', ap.tourism,
            'leisure', ap.leisure,
            'craft', ap.craft,
            'healthcare', ap.healthcare,
            'natural', ap."natural",
            'man_made', ap.man_made
          ) || ap.tags_extra
        ),
        'relations', ap.relations,
        'meta', ap.meta,
        'tainted', ap.tainted,
        'coordinate', jsonb_build_array(ap.lon, ap.lat),
        'sourceFeatureId', ap.osm_type || '/' || ap.osm_id
      )
      ORDER BY ap.osm_id ASC
    ) FILTER (WHERE ap.osm_id IS NOT NULL),
    '[]'::jsonb
  ) AS contained_pois,
  ST_Area(cb.geom::geography) AS area_sqm
FROM candidate_buildings cb
LEFT JOIN assigned_pois ap
  ON ap.building_osm_type = cb.osm_type
 AND ap.building_osm_id = cb.osm_id
GROUP BY
  cb.osm_type,
  cb.osm_id,
  cb.geom,
  cb.name,
  cb.building,
  cb.man_made,
  cb.height,
  cb.level,
  cb.building_levels,
  cb.tags_extra,
  cb.relations,
  cb.outline_references,
  cb.meta,
  cb.tainted
ORDER BY cb.osm_id ASC;

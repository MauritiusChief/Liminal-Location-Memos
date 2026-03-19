WITH player_point AS (
  SELECT ST_SetSRID(ST_MakePoint($1, $2), 4326) AS geom
),
root_building AS (
  SELECT b.*
  FROM osm_buildings b
  CROSS JOIN player_point pp
  WHERE ST_Covers(b.geom, pp.geom)
  ORDER BY ST_Area(b.geom::geography) ASC, b.osm_id ASC
  LIMIT 1
),
current_relation_ids AS (
  SELECT DISTINCT (relation_entry ->> 'rel')::bigint AS rel
  FROM root_building rb
  CROSS JOIN LATERAL jsonb_array_elements(rb.relations) AS relation_entry
  WHERE jsonb_typeof(relation_entry) = 'object'
    AND relation_entry ? 'rel'
    AND jsonb_typeof(relation_entry -> 'rel') = 'number'
),
target_buildings AS (
  SELECT
    rb.osm_type,
    rb.osm_id,
    rb.geom,
    rb.name,
    rb.building,
    rb.man_made,
    rb.height,
    rb.level,
    rb.building_levels,
    rb.tags_extra,
    rb.relations,
    0 AS sort_group
  FROM root_building rb

  UNION

  SELECT
    b.osm_type,
    b.osm_id,
    b.geom,
    b.name,
    b.building,
    b.man_made,
    b.height,
    b.level,
    b.building_levels,
    b.tags_extra,
    b.relations,
    1 AS sort_group
  FROM osm_buildings b
  CROSS JOIN root_building rb
  WHERE NOT (b.osm_type = rb.osm_type AND b.osm_id = rb.osm_id)
    AND EXISTS (
      SELECT 1
      FROM current_relation_ids cri
      CROSS JOIN LATERAL jsonb_array_elements(b.relations) AS relation_entry
      WHERE jsonb_typeof(relation_entry) = 'object'
        AND relation_entry ? 'rel'
        AND jsonb_typeof(relation_entry -> 'rel') = 'number'
        AND (relation_entry ->> 'rel')::bigint = cri.rel
    )
),
candidate_pois AS (
  SELECT p.*
  FROM osm_pois p
  CROSS JOIN target_buildings tb
  WHERE ST_Intersects(p.geom, tb.geom)
),
poi_best_building AS (
  SELECT
    p.osm_type AS poi_osm_type,
    p.osm_id AS poi_osm_id,
    b.osm_type AS building_osm_type,
    b.osm_id AS building_osm_id,
    ROW_NUMBER() OVER (
      PARTITION BY p.osm_type, p.osm_id
      ORDER BY ST_Area(b.geom::geography) ASC, b.osm_id ASC
    ) AS row_number
  FROM candidate_pois p
  JOIN osm_buildings b ON ST_Covers(b.geom, p.geom)
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
),
building_payloads AS (
  SELECT
    tb.osm_type || '/' || tb.osm_id AS building_id,
    jsonb_strip_nulls(
      jsonb_build_object(
        'name', tb.name,
        'building', tb.building,
        'man_made', tb.man_made,
        'height', tb.height,
        'level', tb.level,
        'building:levels', tb.building_levels
      ) || tb.tags_extra
    )::jsonb AS tags,
    ST_Area(tb.geom::geography) AS area_square_meters,
    tb.relations,
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
    tb.sort_group
  FROM target_buildings tb
  LEFT JOIN assigned_pois ap
    ON ap.building_osm_type = tb.osm_type
   AND ap.building_osm_id = tb.osm_id
  GROUP BY
    tb.osm_type,
    tb.osm_id,
    tb.geom,
    tb.name,
    tb.building,
    tb.man_made,
    tb.height,
    tb.level,
    tb.building_levels,
    tb.tags_extra,
    tb.relations,
    tb.sort_group
)
SELECT
  bp.building_id,
  bp.tags,
  bp.area_square_meters,
  bp.relations,
  bp.contained_pois
FROM building_payloads bp
ORDER BY bp.sort_group ASC, bp.area_square_meters ASC, bp.building_id ASC;

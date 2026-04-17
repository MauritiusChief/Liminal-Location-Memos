WITH target_building AS (
  SELECT b.*
  FROM osm_buildings b
  WHERE b.osm_type = $1
    AND b.osm_id = $2
  LIMIT 1
),
candidate_pois AS (
  SELECT p.*
  FROM osm_pois p
  JOIN target_building tb
    ON ST_Covers(tb.geom, p.geom)
)
SELECT
  tb.osm_type || '/' || tb.osm_id AS feature_id,
  tb.osm_type,
  tb.osm_id,
  GeometryType(tb.geom) AS geometry_type,
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
  tb.relations,
  tb.outline_references,
  tb.meta,
  tb.tainted,
  COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'osmType', p.osm_type,
        'osmId', p.osm_id,
        'tags', jsonb_strip_nulls(
          jsonb_build_object(
            'name', p.name,
            'brand', p.brand,
            'shop', p.shop,
            'amenity', p.amenity,
            'office', p.office,
            'tourism', p.tourism,
            'leisure', p.leisure,
            'craft', p.craft,
            'healthcare', p.healthcare,
            'natural', p."natural",
            'man_made', p.man_made
          ) || p.tags_extra
        ),
        'relations', p.relations,
        'meta', p.meta,
        'tainted', p.tainted,
        'coordinate', jsonb_build_array(ST_X(p.geom), ST_Y(p.geom)),
        'sourceFeatureId', p.osm_type || '/' || p.osm_id
      )
      ORDER BY p.osm_id ASC
    ) FILTER (WHERE p.osm_id IS NOT NULL),
    '[]'::jsonb
  ) AS contained_pois,
  ST_Area(tb.geom::geography) AS area_sqm
FROM target_building tb
LEFT JOIN candidate_pois p
  ON TRUE
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
  tb.outline_references,
  tb.meta,
  tb.tainted;

WITH target_building AS (
  SELECT
    b.osm_type,
    b.osm_id,
    b.geom,
    ST_Area(b.geom::geography) AS area_sqm,
    CASE
      WHEN GeometryType(b.geom) <> 'POLYGON' THEN FALSE
      WHEN ST_NumInteriorRings(b.geom) <> 0 THEN FALSE
      WHEN ST_NPoints(ST_ExteriorRing(b.geom)) <> 5 THEN FALSE
      ELSE TRUE
    END AS is_simple_rectangle
  FROM osm_buildings b
  WHERE b.osm_type = $1
    AND b.osm_id = $2
  LIMIT 1
),
neighbor_buildings AS (
  SELECT
    ST_Area(b.geom::geography) AS area_sqm
  FROM osm_buildings b
  JOIN target_building tb
    ON ST_DWithin(b.geom::geography, tb.geom::geography, $3)
  WHERE NOT (b.osm_type = tb.osm_type AND b.osm_id = tb.osm_id)
),
neighbor_stats AS (
  SELECT
    COUNT(*)::integer AS neighbor_sample_count,
    AVG(area_sqm) AS neighbor_average_area_sqm
  FROM neighbor_buildings
)
SELECT
  tb.area_sqm,
  ns.neighbor_sample_count,
  ns.neighbor_average_area_sqm,
  tb.is_simple_rectangle
FROM target_building tb
CROSS JOIN neighbor_stats ns;

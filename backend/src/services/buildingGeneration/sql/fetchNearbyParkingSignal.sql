WITH target_building AS (
  SELECT ST_Centroid(b.geom) AS center_geom
  FROM osm_buildings b
  WHERE b.osm_type = $1
    AND b.osm_id = $2
  LIMIT 1
)
SELECT EXISTS (
  SELECT 1
  FROM target_building tb
  WHERE EXISTS (
    SELECT 1
    FROM osm_area_features a
    WHERE a.amenity = 'parking'
      AND ST_DWithin(a.geom::geography, tb.center_geom::geography, $3)
  )
  OR EXISTS (
    SELECT 1
    FROM osm_pois p
    WHERE p.amenity = 'parking'
      AND ST_DWithin(p.geom::geography, tb.center_geom::geography, $3)
  )
) AS has_nearby_parking;

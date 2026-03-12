INSERT INTO osm_area_features (
  osm_type, osm_id, geom, name, landuse, "natural", leisure, amenity, tags_extra, relations, meta, tainted, last_synced_at
)
VALUES (
  $1, $2, ST_SetSRID(ST_GeomFromGeoJSON($3), 4326),
  $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12, now()
)
ON CONFLICT (osm_type, osm_id)
DO UPDATE SET
  geom = EXCLUDED.geom,
  name = EXCLUDED.name,
  landuse = EXCLUDED.landuse,
  "natural" = EXCLUDED.natural,
  leisure = EXCLUDED.leisure,
  amenity = EXCLUDED.amenity,
  tags_extra = EXCLUDED.tags_extra,
  relations = EXCLUDED.relations,
  meta = EXCLUDED.meta,
  tainted = EXCLUDED.tainted,
  last_synced_at = now();

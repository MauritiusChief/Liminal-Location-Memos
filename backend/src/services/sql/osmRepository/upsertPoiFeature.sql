INSERT INTO osm_pois (
  osm_type, osm_id, geom, name, brand, shop, amenity, office, tourism, leisure, craft, healthcare,
  tags_extra, relations, meta, tainted, last_synced_at
)
VALUES (
  $1, $2, ST_SetSRID(ST_GeomFromGeoJSON($3), 4326),
  $4, $5, $6, $7, $8, $9, $10, $11, $12,
  $13::jsonb, $14::jsonb, $15::jsonb, $16, now()
)
ON CONFLICT (osm_type, osm_id)
DO UPDATE SET
  geom = EXCLUDED.geom,
  name = EXCLUDED.name,
  brand = EXCLUDED.brand,
  shop = EXCLUDED.shop,
  amenity = EXCLUDED.amenity,
  office = EXCLUDED.office,
  tourism = EXCLUDED.tourism,
  leisure = EXCLUDED.leisure,
  craft = EXCLUDED.craft,
  healthcare = EXCLUDED.healthcare,
  tags_extra = EXCLUDED.tags_extra,
  relations = EXCLUDED.relations,
  meta = EXCLUDED.meta,
  tainted = EXCLUDED.tainted,
  last_synced_at = now();

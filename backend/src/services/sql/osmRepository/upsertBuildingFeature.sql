INSERT INTO osm_buildings (
  osm_type, osm_id, geom, name, building, man_made, height, level, building_levels,
  tags_extra, relations, meta, tainted, last_synced_at
)
VALUES (
  $1, $2, ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($3), 4326)),
  $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12::jsonb, $13, now()
)
ON CONFLICT (osm_type, osm_id)
DO UPDATE SET
  geom = EXCLUDED.geom,
  name = EXCLUDED.name,
  building = EXCLUDED.building,
  man_made = EXCLUDED.man_made,
  height = EXCLUDED.height,
  level = EXCLUDED.level,
  building_levels = EXCLUDED.building_levels,
  tags_extra = EXCLUDED.tags_extra,
  relations = EXCLUDED.relations,
  meta = EXCLUDED.meta,
  tainted = EXCLUDED.tainted,
  last_synced_at = now();

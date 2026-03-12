-- [手动操作]
-- 在目标数据库中依次执行：
-- 1. 001_init_postgis.sql
-- 2. 本文件

CREATE TABLE IF NOT EXISTS osm_buildings (
  osm_type text NOT NULL,
  osm_id bigint NOT NULL,
  geom geometry(MultiPolygon, 4326) NOT NULL,
  name text NULL,
  building text NULL,
  height text NULL,
  level text NULL,
  building_levels text NULL,
  tags_extra jsonb NOT NULL DEFAULT '{}'::jsonb,
  relations jsonb NOT NULL DEFAULT '[]'::jsonb,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  tainted boolean NOT NULL DEFAULT false,
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT osm_buildings_pk PRIMARY KEY (osm_type, osm_id)
);

CREATE TABLE IF NOT EXISTS osm_pois (
  osm_type text NOT NULL,
  osm_id bigint NOT NULL,
  geom geometry(Point, 4326) NOT NULL,
  name text NULL,
  brand text NULL,
  shop text NULL,
  amenity text NULL,
  office text NULL,
  tourism text NULL,
  leisure text NULL,
  craft text NULL,
  healthcare text NULL,
  tags_extra jsonb NOT NULL DEFAULT '{}'::jsonb,
  relations jsonb NOT NULL DEFAULT '[]'::jsonb,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  tainted boolean NOT NULL DEFAULT false,
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT osm_pois_pk PRIMARY KEY (osm_type, osm_id)
);

CREATE TABLE IF NOT EXISTS osm_line_features (
  osm_type text NOT NULL,
  osm_id bigint NOT NULL,
  geom geometry(Geometry, 4326) NOT NULL,
  name text NULL,
  highway text NULL,
  railway text NULL,
  waterway text NULL,
  tags_extra jsonb NOT NULL DEFAULT '{}'::jsonb,
  relations jsonb NOT NULL DEFAULT '[]'::jsonb,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  tainted boolean NOT NULL DEFAULT false,
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT osm_line_features_pk PRIMARY KEY (osm_type, osm_id)
);

CREATE TABLE IF NOT EXISTS osm_area_features (
  osm_type text NOT NULL,
  osm_id bigint NOT NULL,
  geom geometry(Geometry, 4326) NOT NULL,
  name text NULL,
  landuse text NULL,
  "natural" text NULL,
  leisure text NULL,
  amenity text NULL,
  tags_extra jsonb NOT NULL DEFAULT '{}'::jsonb,
  relations jsonb NOT NULL DEFAULT '[]'::jsonb,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  tainted boolean NOT NULL DEFAULT false,
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT osm_area_features_pk PRIMARY KEY (osm_type, osm_id)
);

CREATE TABLE IF NOT EXISTS osm_sync_coverage (
  id bigserial PRIMARY KEY,
  center geometry(Point, 4326) NOT NULL,
  radius_m integer NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL DEFAULT 'overpass'
);

CREATE INDEX IF NOT EXISTS osm_buildings_geom_gix ON osm_buildings USING GIST (geom);
CREATE INDEX IF NOT EXISTS osm_pois_geom_gix ON osm_pois USING GIST (geom);
CREATE INDEX IF NOT EXISTS osm_line_features_geom_gix ON osm_line_features USING GIST (geom);
CREATE INDEX IF NOT EXISTS osm_area_features_geom_gix ON osm_area_features USING GIST (geom);
CREATE INDEX IF NOT EXISTS osm_sync_coverage_center_gix ON osm_sync_coverage USING GIST (center);

CREATE INDEX IF NOT EXISTS osm_buildings_tags_extra_gin ON osm_buildings USING GIN (tags_extra);
CREATE INDEX IF NOT EXISTS osm_pois_tags_extra_gin ON osm_pois USING GIN (tags_extra);
CREATE INDEX IF NOT EXISTS osm_line_features_tags_extra_gin ON osm_line_features USING GIN (tags_extra);
CREATE INDEX IF NOT EXISTS osm_area_features_tags_extra_gin ON osm_area_features USING GIN (tags_extra);

import { NormalizedFeature } from "./osmNormalizer.js";
import { getStructuredTagColumns, matchFeatureCategory } from "./osmFeatureConfig.js";
import { withTransaction } from "@/db/client.js";
import { loadServiceSql } from "@/db/sqlLoader.js";
import { PoolClient } from "pg";
import { RangedPosition } from "@/routes/apiTypes.js";

const BUILDING_TAG_COLUMNS = getStructuredTagColumns('building');
const POI_TAG_COLUMNS = getStructuredTagColumns('poi');
const ROAD_TAG_COLUMNS = getStructuredTagColumns('line');
const AREA_TAG_COLUMNS = getStructuredTagColumns('area');

const upsertBuildingFeatureSqlPromise = loadServiceSql('osmNormalization/sql/upsertBuildingFeature.sql');
const upsertPoiFeatureSqlPromise = loadServiceSql('osmNormalization/sql/upsertPoiFeature.sql');
const upsertLineFeatureSqlPromise = loadServiceSql('osmNormalization/sql/upsertLineFeature.sql');
const upsertAreaFeatureSqlPromise = loadServiceSql('osmNormalization/sql/upsertAreaFeature.sql');

//#region 主函数

/**
 * 同步规整化后的地物到数据库
 * @param features 规整化后等待存储的地物
 * @param lat Overpass Query 中心经度
 * @param lon Overpass Query 中心维度
 * @param radius Overpass Query 半径
 * @returns debug 用的计数
 */
export async function syncNormalizedFeaturesToDb(
  features: NormalizedFeature[],
  para: RangedPosition,
): Promise<{ buildings: number; pois: number; lines: number; areas: number }> {
  return withTransaction(async (client) => {
    let buildings = 0;
    let pois = 0;
    let lines = 0;
    let areas = 0;

    for (const feature of features) {
      const category = matchFeatureCategory(feature);
      switch (category) {
        case 'building':
          await upsertBuildingFeature(client, feature);
          buildings += 1;
          break;
        case 'poi':
          await upsertPoiFeature(client, feature);
          pois += 1;
          break;
        case 'line':
          await upsertLineFeature(client, feature);
          lines += 1;
          break;
        case 'area':
          await upsertAreaFeature(client, feature);
          areas += 1;
          break;
        default:
          break;
      }
    }

    await client.query(
      `
      INSERT INTO osm_sync_coverage (center, radius_m, source)
      VALUES (ST_SetSRID(ST_MakePoint($1, $2), 4326), $3, 'overpass')
      `,
      [para.lon, para.lat, para.radius],
    );

    return { buildings, pois, lines, areas };
  });
}

//#region 入库函数

async function upsertBuildingFeature(client: PoolClient, feature: NormalizedFeature): Promise<void> {
  const tags = feature.properties.tags;
  const tagsExtra = omitKeys(tags, BUILDING_TAG_COLUMNS);
  const sql = await upsertBuildingFeatureSqlPromise;

  await client.query(
    sql,
    [
      feature.properties.osmType,
      feature.properties.osmId,
      JSON.stringify(feature.geometry),
      tags.name || null,
      tags.building || null,
      tags.man_made || null,
      tags.height || null,
      tags.level || null,
      tags['building:levels'] || null,
      JSON.stringify(tagsExtra),
      JSON.stringify(feature.properties.relationReferences),
      JSON.stringify(feature.properties.outlineReferences || []),
      JSON.stringify(feature.properties.meta),
      feature.properties.tainted,
    ],
  );
}

// sync 阶段仍然保留原来的“只把后续摘要会用到的对象落库”策略。
async function upsertPoiFeature(client: PoolClient, feature: NormalizedFeature): Promise<void> {
  const tags = feature.properties.tags;
  const tagsExtra = omitKeys(tags, POI_TAG_COLUMNS);
  const sql = await upsertPoiFeatureSqlPromise;

  await client.query(
    sql,
    [
      feature.properties.osmType,
      feature.properties.osmId,
      JSON.stringify(feature.geometry),
      tags.name || null,
      tags.brand || null,
      tags.shop || null,
      tags.amenity || null,
      tags.office || null,
      tags.tourism || null,
      tags.leisure || null,
      tags.craft || null,
      tags.healthcare || null,
      tags.natural || null,
      tags.man_made || null,
      JSON.stringify(tagsExtra),
      JSON.stringify(feature.properties.relationReferences),
      JSON.stringify(feature.properties.meta),
      feature.properties.tainted,
    ],
  );
}

async function upsertLineFeature(client: PoolClient, feature: NormalizedFeature): Promise<void> {
  const tags = feature.properties.tags;
  const tagsExtra = omitKeys(tags, ROAD_TAG_COLUMNS);
  const sql = await upsertLineFeatureSqlPromise;

  await client.query(
    sql,
    [
      feature.properties.osmType,
      feature.properties.osmId,
      JSON.stringify(feature.geometry),
      tags.name || null,
      tags.highway || null,
      tags.railway || null,
      tags.waterway || null,
      tags.man_made || null,
      JSON.stringify(tagsExtra),
      JSON.stringify(feature.properties.relationReferences),
      JSON.stringify(feature.properties.meta),
      feature.properties.tainted,
    ],
  );
}

async function upsertAreaFeature(client: PoolClient, feature: NormalizedFeature): Promise<void> {
  const tags = feature.properties.tags;
  const tagsExtra = omitKeys(tags, AREA_TAG_COLUMNS);
  const sql = await upsertAreaFeatureSqlPromise;

  await client.query(
    sql,
    [
      feature.properties.osmType,
      feature.properties.osmId,
      JSON.stringify(feature.geometry),
      tags.name || null,
      tags.landuse || null,
      tags.natural || null,
      tags.leisure || null,
      tags.amenity || null,
      JSON.stringify(tagsExtra),
      JSON.stringify(feature.properties.relationReferences),
      JSON.stringify(feature.properties.meta),
      feature.properties.tainted,
    ],
  );
}

/**
 *  结构化列已经单独存表字段，tags_extra 只保留剩余补充标签。
 * @param source
 * @param keys
 * @returns
 */
function omitKeys<T extends string>(source: Record<string, string>, keys: readonly T[]): Record<string, string> {
  const keySet = new Set<string>(keys);
  return Object.fromEntries(Object.entries(source).filter(([key]) => !keySet.has(key)));
}
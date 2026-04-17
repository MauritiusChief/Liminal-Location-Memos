import { query } from "@/db/client.js";
import { loadServiceSql } from "@/db/sqlLoader.js";
import { RangedPosition } from "@/routes/apiTypes.js";
import { ContainedPoiReference, OutlineReference, RelationReference } from "@/services/osmNormalization/osmNormalizer.js";

/**
 * 与 SQL 查询结果表一致的扁平类型
 */
interface DbFeatureDetailTableRow {
  feature_id: string;
  osm_type: string;
  osm_id: number;
  category: 'building' | 'poi' | 'line' | 'area';
  geometry_type: string;
  tags: Record<string, string>;
  relations: RelationReference[];
  meta: Record<string, string | number>;
  tainted: boolean;
};

interface DbBuildingDetailTableRow extends DbFeatureDetailTableRow {
  category: 'building';
  contained_pois: ContainedPoiReference[];
  outline_references: OutlineReference[];
}

/**
 * 以 featureId 为 index 记录地物细节数据，不包含几何形状数据（用与描绘 Scene、生成 Building Schema 等）
 */
export interface FeatureDetail {
  featureId: string;
  osmId: number;
  osmType?: string;
  category: 'building' | 'poi' | 'line' | 'area';
  geometryType: string;
  tags: Record<string, string>;
  meta?: Record<string, string | number>;
  tainted?: boolean;
  relationReferences?: RelationReference[];
  outlineReferences?: OutlineReference[];
  containedPoisReferences?: ContainedPoiReference[];
}

//#region 主函数

/**
 * 这个函数取回以 featureId 为指数的一列记录，包含所有细节。
 * 建筑单独走一条查询，是为了顺手把 containedPois 一并在 SQL 里算好。
 * @param request
 * @returns
 */
export async function fetchFeatureDetailsFromDb(request: RangedPosition): Promise<FeatureDetail[]> {
  const [buildingRows, otherRows] = await Promise.all([
    fetchBuildingDetails(request),
    fetchNonBuildingDetails(request),
  ]);

  return [
    ...buildingRows.map((row) => ({
      featureId: row.feature_id,
      osmType: row.osm_type,
      osmId: row.osm_id,
      category: 'building' as const,
      geometryType: row.geometry_type,
      tags: row.tags || {},
      relationReferences: row.relations || [],
      outlineReferences: row.outline_references || [],
      meta: row.meta || {},
      tainted: row.tainted ?? false,
      containedPoisReferences: row.contained_pois && row.contained_pois.length > 0 ? row.contained_pois : undefined,
    })),
    ...otherRows.map((row) => ({
      featureId: row.feature_id,
      osmType: row.osm_type,
      osmId: row.osm_id,
      category: row.category,
      geometryType: row.geometry_type,
      tags: row.tags || {},
      relationReferences: row.relations || [],
      meta: row.meta || {},
      tainted: row.tainted ?? false,
    })),
  ];
}

//#region 辅助函数

const fetchSceneBuildingDetailsSqlPromise = loadServiceSql('fetchSceneBuildingDetails.sql');
const fetchSceneNonBuildingDetailsSqlPromise = loadServiceSql('fetchSceneNonBuildingDetails.sql');

/**
 * 这里取的是“建筑详情 + 建筑内 POI”，供标签、grid 补充细节、prompt 共用。
 * 注：为了兼容 debug 模式，SQL 所取的信息是超量的。
 * @param request
 * @returns 直接返回与 DB 表格式一致的结果
 */
async function fetchBuildingDetails(request: RangedPosition): Promise<DbBuildingDetailTableRow[]> {
  const sql = await fetchSceneBuildingDetailsSqlPromise;
  const result = await query<DbBuildingDetailTableRow>(
    sql,
    [request.lon, request.lat, request.radius],
  );

  return result.rows;
}

/**
 *  非 building 的详情直接从调试视图取，避免在 TS 里重复拼 tags。
 * 注：为了兼容 debug 模式，SQL 所取的信息是超量的。
 * @param request
 * @returns 直接返回与 DB 表格式一致的结果
 */
async function fetchNonBuildingDetails(request: RangedPosition): Promise<DbFeatureDetailTableRow[]> {
  const sql = await fetchSceneNonBuildingDetailsSqlPromise;
  const result = await query<DbFeatureDetailTableRow>(
    sql,
    [request.lon, request.lat, request.radius],
  );

  return result.rows;
}

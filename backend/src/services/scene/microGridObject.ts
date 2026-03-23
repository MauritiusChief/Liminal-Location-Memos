import { query } from "@/db/client.js";
import { loadServiceSql } from "@/db/sqlLoader.js";
import { RangedPosition } from "@/routes/apiTypes.js";
import { SceneFeatureDetail } from "./sceneUtilFeatureDetail.js";

/**
 * 与 SQL 查询结果表一致的扁平类型
 */
type DbMicroGridCellTableRow = {
  row: number;
  col: number;
  center_lon: number;
  center_lat: number;
  base_kind: 'building' | 'area' | 'empty';
  base_feature_id: string | null;
  poi_feature_ids: string[] | null;
  road_feature_ids: string[] | null;
};

/**
 * Micro grid 在 SQL 里已经完成了“这个格子命中了谁”的空间判断；
 * 这里直接获取按格子安排好的信息。
 * 但是仅仅只包含归属关系等信息，所以只有指向别处的 id，真正靠 id 获取实际地物要靠别处
 */
export interface IdReferedMicroGridCell {
  row: number;
  col: number;
  center: [number, number];
  baseKind: 'building' | 'area' | 'empty';
  baseFeatureId: string | null;
  poiFeatureIds: string[];
  roadFeatureIds: string[];
}

/**
 * 正宗的 Micro Grid Object 里 cell 的格式（不含几何信息）
 */
export interface MicroGridCell {
  row: number;
  col: number;
  center: [number, number];
  baseKind: 'building' | 'area' | 'empty';
  baseFeatureDetail: SceneFeatureDetail | null,
  poiFeatureDetails: SceneFeatureDetail[];
  roadFeatureDetails: SceneFeatureDetail[];
}

/**
 * 正宗的 Micro Grid Object 格式（不含几何信息）
 */
export interface MicroGrid {
  center: {
    lat: number;
    lon: number;
  };
  extentMeters: 60;
  cellSizeMeters: 5;
  rows: 12;
  cols: 12;
  cells: MicroGridCell[][];
}

//#region 主函数

const fetchMicroGridFromDbSqlPromise = loadServiceSql('osmRepository/fetchMicroGridFromDb.sql');

/**
 * grid 的空间命中全部下沉到 PostGIS：
 * 1. 生成 12x12 固定网格
 * 2. 用 cell center 判定 building/area 基底
 * 3. 用 cell bbox 收集 poi / road 叠加层
 * @param request
 * @returns
 */
export async function fetchMicroGridFromDb(request: RangedPosition): Promise<IdReferedMicroGridCell[]> {
  if (request.radius <= 50) {
    return [];
  }

  const sql = await fetchMicroGridFromDbSqlPromise;
  const result = await query<DbMicroGridCellTableRow>(
    sql,
    [request.lon, request.lat],
  );

  return result.rows.map((row) => ({
    row: row.row,
    col: row.col,
    center: [row.center_lon, row.center_lat],
    baseKind: row.base_kind,
    baseFeatureId: row.base_feature_id,
    poiFeatureIds: row.poi_feature_ids || [],
    roadFeatureIds: row.road_feature_ids || [],
  }));
}

export function buildMicroGrid(
  request: { lat: number; lon: number; radius: number },
  cellRecords: IdReferedMicroGridCell[],
  featureDetails: ReadonlyMap<string, SceneFeatureDetail>,
): MicroGrid {

  const cells: MicroGridCell[][] = Array.from({ length: 12 }, (_, row) =>
    Array.from({ length: 12 }, (_, col) => {
      // SQL 理论上会返回完整 12x12；这里保留兜底，是为了避免单格缺失时直接炸掉整个调试结果。
      const record = cellRecords.find((entry) => entry.row === row && entry.col === col);

      if (!record) {
        return {
          row,
          col,
          center: [request.lon, request.lat],
          baseKind: 'empty',
          baseFeatureDetail: null,
          poiFeatureDetails: [],
          roadFeatureDetails: []
        } satisfies MicroGridCell;
      }

      return buildMicroGridCell(record, featureDetails);
    }),
  );

  return {
    center: { lat: request.lat, lon: request.lon },
    extentMeters: 60,
    cellSizeMeters: 5,
    rows: 12,
    cols: 12,
    cells: cells,
  };
}


function buildMicroGridCell(
  record: IdReferedMicroGridCell,
  featureDetails: ReadonlyMap<string, SceneFeatureDetail>,
): MicroGridCell {
  // 这一层只根据 feature id 回表拿标签，不再接触几何。
  const baseFeatureDetail = record.baseFeatureId ? featureDetails.get(record.baseFeatureId) || null : null;
  const poiFeatureDetails = record.poiFeatureIds.flatMap((featureId) => {
    const detail = featureDetails.get(featureId);
    return detail ? [detail] : [];
  });
  const roadFeatureDetails = record.roadFeatureIds.flatMap((featureId) => {
    const detail = featureDetails.get(featureId);
    return detail ? [detail] : [];
  });

  return {
    row: record.row,
    col: record.col,
    center: record.center,
    baseKind: record.baseKind,
    baseFeatureDetail,
    poiFeatureDetails,
    roadFeatureDetails
  };
}

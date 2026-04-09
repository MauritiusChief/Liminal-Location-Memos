import { query } from "@/db/client.js";
import { loadServiceSql } from "@/db/sqlLoader.js";
import { RangedPosition } from "@/routes/apiTypes.js";
import { FeatureDetail } from "../featureDetail.js";
import { Position } from "../gameSystem/gameSessionStore.js";
import { degreesToRadians, normalizeBearingDegrees, projectPositionByMeters } from "../geometry.js";

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

interface DbMicroGridCellQueryInput {
  row: number;
  col: number;
  center_lon: number;
  center_lat: number;
  bbox_wkt: string;
}

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
  baseFeatureDetail: FeatureDetail | null,
  poiFeatureDetails: FeatureDetail[];
  roadFeatureDetails: FeatureDetail[];
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

export interface ComputedMicroGridCellInput {
  row: number;
  col: number;
  center: [number, number];
  bbox: [[number, number], [number, number], [number, number], [number, number]];
}

//#region 主函数

const fetchMicroGridFromDbSqlPromise = loadServiceSql('scene/sql/fetchMicroGridFromDb.sql');
const MICRO_GRID_HALF_EXTENT_METERS = 30;
const MICRO_GRID_CELL_SIZE_METERS = 5;
const MICRO_GRID_DIMENSION = 12;

/**
 * 先在 TS 中生成 12x12 旋转网格，再把格子批量交给 PostGIS 做空间命中。
 * 1. 用 cell center 判定 building/area 基底
 * 2. 用 cell bbox 收集 poi / road 叠加层
 * @param request
 * @returns
 */
export async function fetchMicroGridFromDb(request: RangedPosition, playerOrientation: number = 0): Promise<IdReferedMicroGridCell[]> {
  if (request.radius <= 50) {
    return [];
  }

  const computedCells = buildComputedMicroGridCells(
    { lat: request.lat, lon: request.lon },
    playerOrientation,
  );
  const sql = await fetchMicroGridFromDbSqlPromise;
  const result = await query<DbMicroGridCellTableRow>(
    sql,
    [JSON.stringify(computedCells.map(toDbMicroGridCellQueryInput))],
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
  featureDetails: ReadonlyMap<string, FeatureDetail>,
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

export function buildComputedMicroGridCells(
  center: Position,
  playerOrientation: number = 0,
): ComputedMicroGridCellInput[] {
  const normalizedOrientation = normalizeBearingDegrees(playerOrientation);

  return Array.from({ length: MICRO_GRID_DIMENSION }, (_, row) =>
    Array.from({ length: MICRO_GRID_DIMENSION }, (_, col) => {
      const leftX = -MICRO_GRID_HALF_EXTENT_METERS + col * MICRO_GRID_CELL_SIZE_METERS;
      const rightX = leftX + MICRO_GRID_CELL_SIZE_METERS;
      const topY = MICRO_GRID_HALF_EXTENT_METERS - row * MICRO_GRID_CELL_SIZE_METERS;
      const bottomY = topY - MICRO_GRID_CELL_SIZE_METERS;

      const bbox = [
        projectLocalMetersToCoordinate(center, leftX, topY, normalizedOrientation),
        projectLocalMetersToCoordinate(center, rightX, topY, normalizedOrientation),
        projectLocalMetersToCoordinate(center, rightX, bottomY, normalizedOrientation),
        projectLocalMetersToCoordinate(center, leftX, bottomY, normalizedOrientation),
      ] as ComputedMicroGridCellInput["bbox"];

      return {
        row,
        col,
        center: projectLocalMetersToCoordinate(
          center,
          (leftX + rightX) / 2,
          (topY + bottomY) / 2,
          normalizedOrientation,
        ),
        bbox,
      } satisfies ComputedMicroGridCellInput;
    }),
  ).flat();
}


function buildMicroGridCell(
  record: IdReferedMicroGridCell,
  featureDetails: ReadonlyMap<string, FeatureDetail>,
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

function projectLocalMetersToCoordinate(
  origin: Position,
  localXRightMeters: number,
  localYForwardMeters: number,
  playerOrientation: number,
): [number, number] {
  const orientationRadians = degreesToRadians(playerOrientation);
  const eastMeters = localXRightMeters * Math.cos(orientationRadians) + localYForwardMeters * Math.sin(orientationRadians);
  const northMeters = localYForwardMeters * Math.cos(orientationRadians) - localXRightMeters * Math.sin(orientationRadians);
  const projected = projectPositionByMeters(origin, eastMeters, northMeters);
  return [projected.lon, projected.lat];
}

function toDbMicroGridCellQueryInput(cell: ComputedMicroGridCellInput): DbMicroGridCellQueryInput {
  return {
    row: cell.row,
    col: cell.col,
    center_lon: cell.center[0],
    center_lat: cell.center[1],
    bbox_wkt: toPolygonWkt(cell.bbox),
  };
}

function toPolygonWkt(points: ReadonlyArray<[number, number]>): string {
  const closed = [...points, points[0]!];
  return `POLYGON((${closed.map(([lon, lat]) => `${lon} ${lat}`).join(", ")}))`;
}

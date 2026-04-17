
import { query } from "@/db/client.js";
import { loadServiceSql } from "@/db/sqlLoader.js";

/**
 * 与 SQL 查询结果表一致的扁平类型
 */
interface DbStandaloneResidentialBuildingRow {
  area_sqm: number | string | null;
  neighbor_sample_count: number | string | null;
  neighbor_average_area_sqm: number | string | null;
  is_simple_rectangle: boolean | null;
}

export interface StandaloneResidentialCandidate {
  featureId: string;
  category: "building";
  tags: Record<string, string>;
}

//#region 常量

const TOP_LEVEL = ["top_level", "second_to_top_level", "third_to_top_level"]
const GROUND_LEVEL = ["ground_level", "second_level", "third_level"]
const ALL_LEVELS = ["all_levels"]

/**
 * 兼作分类结果（单独把 key 提取出来）和 Pattern 记录
 * 此表内容仅表示种类，不表示数量
 * - prefered：代表该功能应优先出现的楼层
 */
const RESIDENTIAL_CATEGORIES = {
  house: {desc: "住宅",
    patterns: {
      tiny: {desc: "仅卧室、客厅、浴室的布局",
        bedroom: {desc: "卧室", prefered: TOP_LEVEL[0]},
        living_room: {desc: "与餐厅、厨房相连的客厅", prefered: GROUND_LEVEL[0]},
        bath_room: {desc: "带厕所的浴室", prefered: TOP_LEVEL[0]},
      },
      small: {desc: "单间卧室且空间紧张的布局",
        bedroom: {desc: "卧室", prefered: TOP_LEVEL[0]},
        living_room: {desc: "客厅", prefered: GROUND_LEVEL[0]},
        kitchen: {desc: "带餐厅的厨房", prefered: GROUND_LEVEL[0]},
        bath_room: {desc: "带厕所的浴室", prefered: TOP_LEVEL[0]},
        // 概率房间
        laundry: {desc: "洗衣间", prefered: GROUND_LEVEL[0], chance: 0.2},
      },
      medium: {desc: "一到两间卧室的常规布局",
        bedroom: {desc: "卧室", prefered: TOP_LEVEL[0]},
        living_room: {desc: "客厅", prefered: GROUND_LEVEL[0]},
        kitchen: {desc: "带餐厅的厨房", prefered: GROUND_LEVEL[0]},
        bath_room: {desc: "带厕所的浴室", prefered: TOP_LEVEL[0]},
        // 概率房间
        closet: {desc: "储物间", chance: 0.5},
        office: {desc: "办公室", chance: 0.2},
        laundry: {desc: "洗衣间", prefered: GROUND_LEVEL[0], chance: 0.8},
        kids_bedroom: {desc: "儿童卧室", prefered: TOP_LEVEL[0], chance: 0.5},
        rest_room: {desc: "厕所", prefered: ALL_LEVELS[0], chance: 0.5},
      },
      large: {desc: "三到四间卧室的大房屋布局",
        bedroom: {desc: "卧室", prefered: TOP_LEVEL[0]},
        living_room: {desc: "客厅", prefered: GROUND_LEVEL[0]},
        kitchen: {desc: "厨房", prefered: GROUND_LEVEL[0]},
        bath_room: {desc: "带厕所的浴室", prefered: TOP_LEVEL[0]},
        dining_room: {desc: "餐厅", prefered: GROUND_LEVEL[0]},
        laundry: {desc: "洗衣间", prefered: GROUND_LEVEL[0]},
        closet: {desc: "储物间"},
        // 概率房间
        office: {desc: "办公室", chance: 0.5},
        kids_bedroom: {desc: "儿童卧室", prefered: TOP_LEVEL[0], chance: 0.8},
        rest_room: {desc: "厕所", prefered: ALL_LEVELS[0], chance: 0.9},
      }
    }
  },
  // 带车库的住宅通过应用复合型 Category “住宅 - 内含 车库” 表示
  // 就像 “图书馆 - 内含 咖啡厅”
  garage: {desc: "车库", base_schema: {self: {prefered: GROUND_LEVEL[0]}}},
  tool_shed: {desc: "工具屋", base_schema: {self: true}},
}

const STANDALONE_BUILDING_NEIGHBOR_RADIUS_METERS = 60
const STANDALONE_BUILDING_MAX_ACCESSORY_AREA_SQM = 45
const STANDALONE_BUILDING_RELATIVE_AREA_THRESHOLD = 0.7
const STANDALONE_BUILDING_MIN_NEIGHBOR_SAMPLE_COUNT = 3


//#region 主函数


/**
 * 独立车库与独栋住宅区分方式：
 * 1. 独立车库在周围范围内应当属于面积较小的
 * 2. 独立车库的形状较为规则，为矩形
 *
 * 方式不用非常细，大致区分即可。因为 大建筑+可选小建筑 情景下，下列内容都合理：
 * - 带车库住宅+工具房
 * - 住宅+车库
 * - 带车库住宅
 * - 住宅（车库靠街边停车）
 */
const classifyStandaloneResidentialBuildingSqlPromise = loadServiceSql(
  "gameSystem/sql/classifyStandaloneResidentialBuilding.sql",
);

/**
 * 判断一个已确定只可能是“独栋住宅”或“独立附属建筑（独立车库/工具屋）”的建筑，
 * 是否应按独栋住宅处理。
 *
 * 输入前提：
 * - 调用方必须已经把候选范围收窄到“独栋住宅”与“独立附属建筑”二选一
 * - `candidate.featureId` 必须使用现有 `osm_type/osm_id` 形式
 *
 * 输出语义：
 * - 返回 `true`：按独栋住宅处理
 * - 返回 `false`：更像独立附属建筑（独立车库/工具屋）
 *
 * 保守策略：
 * - 当目标建筑不存在、邻域样本不足、或关键几何证据不足时，一律按住宅处理
 *
 * @param candidate 已缩小到“独栋住宅/独立附属建筑”范围内的建筑候选
 * @returns 是否应按独栋住宅处理
 */
export async function isStandaloneResidentialBuilding(
  candidate: StandaloneResidentialCandidate,
): Promise<boolean> {
  const featureRef = parseBuildingFeatureId(candidate.featureId);
  if (!featureRef) {
    return true;
  }

  const sql = await classifyStandaloneResidentialBuildingSqlPromise;
  const result = await query<DbStandaloneResidentialBuildingRow>(
    sql,
    [featureRef.osmType, featureRef.osmId, STANDALONE_BUILDING_NEIGHBOR_RADIUS_METERS],
  );
  const row = result.rows[0];

  if (!row) {
    return true;
  }

  const areaSqm = toFiniteNumber(row.area_sqm);
  const neighborSampleCount = toFiniteNumber(row.neighbor_sample_count);
  const neighborAverageAreaSqm = toFiniteNumber(row.neighbor_average_area_sqm);

  if (
    areaSqm === null
    || neighborSampleCount === null
    || neighborSampleCount < STANDALONE_BUILDING_MIN_NEIGHBOR_SAMPLE_COUNT
    || neighborAverageAreaSqm === null
  ) {
    return true;
  }

  if (row.is_simple_rectangle !== true) {
    return true;
  }

  if (areaSqm > STANDALONE_BUILDING_MAX_ACCESSORY_AREA_SQM) {
    return true;
  }

  if (areaSqm >= neighborAverageAreaSqm * STANDALONE_BUILDING_RELATIVE_AREA_THRESHOLD) {
    return true;
  }

  return false;
}


// 根据详细的 osm tags 进行分类

//#region 帮助函数

function parseBuildingFeatureId(featureId: string): { osmType: string; osmId: number } | null {
  const [osmType, osmIdText] = featureId.split("/");
  if (!osmType || !osmIdText) {
    return null;
  }

  const osmId = Number.parseInt(osmIdText, 10);
  if (!Number.isFinite(osmId)) {
    return null;
  }

  return { osmType, osmId };
}

function toFiniteNumber(value: number | string | null): number | null {
  if (value === null || typeof value === "undefined") {
    return null;
  }

  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : null;
}

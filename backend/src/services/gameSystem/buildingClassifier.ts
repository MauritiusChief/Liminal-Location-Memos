
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
const STANDALONE_BUILDING_MIN_NEIGHBOR_SAMPLE_COUNT = 1


//#region 主函数


const classifyStandaloneResidentialBuildingSqlPromise = loadServiceSql("gameSystem/sql/classifyStandaloneResidentialBuilding.sql");

/**
 * 判断一个已确定只可能是“独栋住宅”或“独立附属建筑（独立车库/工具屋）”的建筑，
 * 是否应按独栋住宅处理。
 *
 * 输入前提：
 * - 调用方必须已经把候选范围收窄到“独栋住宅”与“独立附属建筑”二选一
 *
 * 输出语义：
 * - 返回 `true`：独栋住宅
 * - 返回 `false`：独立附属建筑（独立车库/工具屋）
 *
 * 保守策略：
 * - 当目标建筑邻域样本不足或关键几何证据不足时，一律按住宅处理
 *
 * @param candidate 已缩小到“独栋住宅/独立附属建筑”范围内的建筑候选
 * @returns 是否应按独栋住宅处理
 */
export async function isStandaloneResidentialBuilding(featureId: string): Promise<boolean> {
  // 获取数据库中的周遭建筑数据与建筑本身数据
  const featureRef = parseBuildingFeatureId(featureId);
  const sql = await classifyStandaloneResidentialBuildingSqlPromise;
  const result = await query<DbStandaloneResidentialBuildingRow>(
    sql,
    [featureRef.osmType, featureRef.osmId, STANDALONE_BUILDING_NEIGHBOR_RADIUS_METERS],
  );
  const row = result.rows[0];

  const areaSqm = toFiniteNumber(row.area_sqm);
  const neighborSampleCount = toFiniteNumber(row.neighbor_sample_count);
  const neighborAverageAreaSqm = toFiniteNumber(row.neighbor_average_area_sqm);

  // 进行判断

  if ( // 没有其他建筑
    areaSqm === null
    || neighborSampleCount === null
    || neighborSampleCount < STANDALONE_BUILDING_MIN_NEIGHBOR_SAMPLE_COUNT
    || neighborAverageAreaSqm === null
  ) {
    return true;
  }

  if ( // 确实就是独立住宅
    row.is_simple_rectangle !== true
    || areaSqm > STANDALONE_BUILDING_MAX_ACCESSORY_AREA_SQM
    || areaSqm >= neighborAverageAreaSqm * STANDALONE_BUILDING_RELATIVE_AREA_THRESHOLD) {
    return true;
  }

  return false;
}


// 根据详细的 osm tags 进行分类

//#region 帮助函数

function parseBuildingFeatureId(featureId: string): { osmType: string; osmId: number } {
  const [osmType, osmIdText] = featureId.split("/");
  const osmId = Number.parseInt(osmIdText, 10);
  return { osmType, osmId };
}

function toFiniteNumber(value: number | string | null): number | null {
  if (value === null || typeof value === "undefined") {
    return null;
  }

  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : null;
}

import { loadServiceSql } from "@/db/sqlLoader.js";
import { BuildingCandidate, BuildingSchema, fetchBuildingCoveringAreas, fetchBuildingRoadKinds, parseBuildingFeatureId, pickRandom, weightedBoolean } from "./buildingClassifier.js";
import { query } from "@/db/client.js";
import { distanceToPosition } from "../geometry.js";

export type ResidentialCategoryKey = "house" | "house&garage" | "garage" | "tool_shed";
export type ResidentialBuildingKind = "house" | "accessory";

/**
 * 与 SQL 查询结果表一致的扁平类型
 */
interface DbHouseDetermingRow {
  area_sqm: number;
  neighbor_sample_count: number;
  neighbor_average_area_sqm: number;
  is_simple_rectangle: boolean;
}

interface DbNearbyParkingSignalRow {
  has_nearby_parking: boolean | null;
}

//#region 常量

const TOP_LEVEL = ["top_level", "second_to_top_level", "third_to_top_level"];
const GROUND_LEVEL = ["ground_level", "second_level", "third_level"];
const ALL_LEVELS = ["all_levels"];

/**
 * 兼作分类结果（单独把 key 提取出来）和 Pattern 记录
 * 此表内容仅表示种类，不表示数量或与面积的关联
 * - prefered：代表该功能应优先出现的楼层
 */
const RESIDENTIAL_CATEGORIES = {
  house: {desc: "住宅",
    patterns: {
      studio: {desc: "仅卧室、客厅、浴室的简单布局",
        bedroom: {desc: "卧室", prefered: TOP_LEVEL[0]},
        living_room: {desc: "与餐厅、厨房相连的客厅", prefered: GROUND_LEVEL[0]},
        bath_room: {desc: "带厕所的浴室", prefered: TOP_LEVEL[0]},
      },
      standard: {desc: "单间卧室的常规布局",
        bedroom: {desc: "卧室", prefered: TOP_LEVEL[0]},
        living_room: {desc: "客厅", prefered: GROUND_LEVEL[0]},
        kitchen: {desc: "带餐厅的厨房", prefered: GROUND_LEVEL[0]},
        bath_room: {desc: "带厕所的浴室", prefered: TOP_LEVEL[0]},
        // 概率房间
        laundry: {desc: "洗衣间", prefered: GROUND_LEVEL[0], chance: 0.2},
      },
      duplex: {desc: "一到两间卧室的较复杂布局",
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
      elaborate: {desc: "三到四间卧室的复杂房屋布局",
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
} as const;

const RESIDENTIAL_DISTRICT_SCHEMA_RADIUS_METERS = 120;

const RESIDENTIAL_DISTRICT_AREA_WEIGHTS: Record<string, { residential: number; nonResidential: number }> = {
  "landuse:residential": { residential: 6, nonResidential: 0 },
  "landuse:commercial": { residential: 0, nonResidential: 5 },
  "landuse:industrial": { residential: 0, nonResidential: 6 },
  "amenity:school": { residential: 0, nonResidential: 4 },
  "amenity:university": { residential: 0, nonResidential: 5 },
};
const RESIDENTIAL_DISTRICT_ROAD_WEIGHTS: Record<string, { residential: number; nonResidential: number }> = {
  "highway:residential": { residential: 3, nonResidential: 0 },
  "highway:service": { residential: 1, nonResidential: 0 },
  "highway:primary": { residential: 0, nonResidential: 3 },
  "highway:trunk": { residential: 0, nonResidential: 4 },
  "highway:motorway": { residential: 0, nonResidential: 5 },
};
const RESIDENTIAL_DISTRICT_SCHEMA_HOUSE_WEIGHT = 4;

const HOUSE_DETERMING_NEIGHBOR_RADIUS_METERS = 60;
const HOUSE_DETERMING_RELATIVE_AREA_THRESHOLD = 0.5;
const HOUSE_DETERMING_MIN_NEIGHBOR_SAMPLE_COUNT = 1;
const RESIDENTIAL_ACCESSORY_CONTEXT_RADIUS_METERS = 25;

const SMALL_HOUSE_AREA_MAX_SQM = 90;
const MEDIUM_HOUSE_AREA_MAX_SQM = 220;

//#region Pattern 逻辑

/**
 * 根据已经确定的 category 选出 pattern。
 *
 * 简单附属建筑不单独扩 pattern 表，而是直接把 category 名作为唯一 pattern。
 *
 * @param candidate 已标准化的建筑候选
 * @param categoryKey 已确定的 category
 * @returns category 对应的 pattern key
 */
export function selectResidentialPatternKey(
  candidate: BuildingCandidate,
  categoryKey: string, // TODO 当前只支持住宅
): string {
  // 简单建筑直接返回 Category Key 作为 Pattern Key
  const simpleCategoryKeys = Object.entries(RESIDENTIAL_CATEGORIES)
    .filter(([key, cat]) => 'base_schema' in cat && cat.base_schema && 'self' in cat.base_schema)
    .map(([key]) => key);
  if (simpleCategoryKeys.includes(categoryKey)) return categoryKey;

  // 当前复合住宅类别仍复用住宅 pattern 池。
  const patternPool = determineHousePatternPool(candidate);
  return pickRandom(patternPool);
}

/**
 * 为住宅类选择一个“可抽样的 pattern 候选池”。
 *
 * 当前规则只使用面积与楼层数这两个稳定信号，保持实现简单且可解释。
 * 真正的随机发生在 pickRandom() 中。
 *
 * @param candidate 已确定为住宅的建筑候选
 * @returns 允许抽样的住宅 pattern 列表
 */
function determineHousePatternPool(candidate: BuildingCandidate): string[] {
  const { areaSqm, buildingLevels } = candidate;

  if (areaSqm === null && buildingLevels === null) {
    return ["studio", "standard", "duplex", "elaborate"];
  }

  if ((areaSqm === null || areaSqm <= SMALL_HOUSE_AREA_MAX_SQM) && (buildingLevels === null || buildingLevels <= 1)) {
    return ["studio", "standard"];
  }

  if ((areaSqm === null || areaSqm <= MEDIUM_HOUSE_AREA_MAX_SQM) && (buildingLevels === null || buildingLevels <= 2)) {
    return ["standard", "duplex"];
  }

  if ((areaSqm !== null && areaSqm > MEDIUM_HOUSE_AREA_MAX_SQM) || (buildingLevels !== null && buildingLevels >= 2)) {
    return ["duplex", "elaborate"];
  }

  return ["standard", "duplex"];
}

//#region Category 逻辑

/**
 * 在没有 explicit building tag 的情况下，
 * 结合覆盖区域、周边道路和已有 schema 判断当前建筑是否位于独栋住宅区。
 */
export async function ambiguousResidentialCategory(
  candidate: BuildingCandidate,
  existingSchemas: Record<string, BuildingSchema>,
): Promise<ResidentialCategoryKey | null> {
  const [coveringAreas, roadKinds] = await Promise.all([
    fetchBuildingCoveringAreas(candidate.detail.featureId),
    fetchBuildingRoadKinds(candidate.detail.featureId),
  ]);
  // console.log('覆盖区域: ',coveringAreas);
  // console.log('周边道路: ',roadKinds);

  const weights = computeResidentialDistrictWeights(candidate, existingSchemas, coveringAreas, roadKinds);
  // console.log('weights: ',weights);
  const isResidentialDistrict = weightedBoolean(weights.residential, weights.nonResidential);
  // console.log('isResidentialDistrict: ',isResidentialDistrict);
  if (!isResidentialDistrict) {
    // console.log('随机判定不是住宅区建筑');
    return null;
  }

  const [buildingKind, hasNearbyParking] = await Promise.all([
    determineResidentialBuildingKind(candidate.detail.featureId),
    fetchNearbyParkingSignal(candidate.detail.featureId),
  ]);
  const nearbySchemas = Object.values(existingSchemas).filter((schema) => {
    return distanceToPosition(schema.centerPosition, candidate.centerPosition) <= RESIDENTIAL_ACCESSORY_CONTEXT_RADIUS_METERS;
  });

  if (buildingKind === "house") { // 如果是住宅则根据是否有外置停车地点来判断本体需不需要车库
    const hasNearbyGarage = nearbySchemas.some((schema) => schema.category === "garage");
    if (hasNearbyParking || hasNearbyGarage) {
      return "house";
    }

    return weightedBoolean(9, 1)
      ? "house&garage"
      : "house";
  }

  const hasNearbyHouseGarage = nearbySchemas.some((schema) => schema.category === "house&garage");
  if (hasNearbyHouseGarage) { // 如果是附属建筑，首先根据是否有内置车库来判断，已有内置车库就不需要车库了
    return "tool_shed";
  }

  if (hasNearbyParking) { // 即使有外置停车地点，也可能需要独立车库
    return weightedBoolean(9, 1)
      ? "tool_shed"
      : "garage";
  }

  // 没有内置车库且没有外置停车地点，大概率是独立车库，但仍有小概率是街边停车+工具房
  return weightedBoolean(1, 9)
    ? "tool_shed"
    : "garage";
}

const fetchHouseDetermingFactorSqlPromise = loadServiceSql("gameSystem/sql/fetchHouseDetermingFactor.sql");
const fetchNearbyParkingSignalSqlPromise = loadServiceSql("gameSystem/sql/fetchNearbyParkingSignal.sql");

/**
 * 判断一个建筑是“独栋住宅”或“独立附属建筑（独立车库/工具屋）”。
 *
 * 输入前提：
 * - 默认调用方已经把候选范围收窄到“独栋住宅”与“独立附属建筑”二选一
 *
 * 输出语义：
 * - 返回 `true`：独栋住宅
 * - 返回 `false`：独立附属建筑（独立车库/工具屋）
 *
 * 保守策略：
 * - 当目标建筑邻域样本不足或关键几何证据不足时，一律按住宅处理
 *
 * @param featureId 已缩小到“独栋住宅/独立附属建筑”范围内的建筑候选
 * @returns 是否应按独栋住宅处理
 */
export async function determineResidentialBuildingKind(featureId: string): Promise<ResidentialBuildingKind> {
  // 获取数据库中的周遭建筑数据与建筑本身数据
  const featureRef = parseBuildingFeatureId(featureId);
  const sql = await fetchHouseDetermingFactorSqlPromise;
  const result = await query<DbHouseDetermingRow>(
    sql,
    [featureRef.osmType, featureRef.osmId, HOUSE_DETERMING_NEIGHBOR_RADIUS_METERS],
  );
  const row = result.rows[0];

  const areaSqm = row?.area_sqm ?? 0;
  // console.log(`${featureId}: 面积${areaSqm}`);
  const neighborSampleCount = row?.neighbor_sample_count ?? 0;
  // console.log(`周围建筑数${neighborSampleCount}`);
  const neighborAverageAreaSqm = row?.neighbor_average_area_sqm ?? 0;
  // console.log(`周围平均面积${neighborAverageAreaSqm}`);

  // 进行判断

  if ( // 没有其他建筑，按独栋住宅处理
    areaSqm === null
    || neighborSampleCount === null
    || neighborSampleCount < HOUSE_DETERMING_MIN_NEIGHBOR_SAMPLE_COUNT
    || neighborAverageAreaSqm === null
  ) {
    return "house";
  }

  // console.log(row?.is_simple_rectangle);

  if ( // 确定为独立附属建筑
    row?.is_simple_rectangle
    && areaSqm < neighborAverageAreaSqm * HOUSE_DETERMING_RELATIVE_AREA_THRESHOLD
  ) {
    return "accessory";
  }

  return "house";
}

export async function fetchNearbyParkingSignal(featureId: string): Promise<boolean> {
  const featureRef = parseBuildingFeatureId(featureId);
  const sql = await fetchNearbyParkingSignalSqlPromise;
  const result = await query<DbNearbyParkingSignalRow>(
    sql,
    [featureRef.osmType, featureRef.osmId, RESIDENTIAL_ACCESSORY_CONTEXT_RADIUS_METERS],
  );

  return result.rows[0]?.has_nearby_parking === true;
}

/**
 * 根据候选建筑所处区域与周边道路，加权随机决定是不是居住区建筑
 * @param candidate
 * @param existingSchemas
 * @param coveringAreas
 * @param roadKinds
 * @returns
 */
function computeResidentialDistrictWeights(
  candidate: BuildingCandidate,
  existingSchemas: Record<string, BuildingSchema>,
  coveringAreas: string[],
  roadKinds: string[],
): { residential: number; nonResidential: number } {
  let residential = 0;
  let nonResidential = 0;

  for (const area of coveringAreas) {
    const weights = RESIDENTIAL_DISTRICT_AREA_WEIGHTS[area];
    if (!weights) continue;
    residential += weights.residential;
    nonResidential += weights.nonResidential;
  }

  for (const roadKind of roadKinds) {
    const weights = RESIDENTIAL_DISTRICT_ROAD_WEIGHTS[roadKind];
    if (!weights) continue;
    residential += weights.residential;
    nonResidential += weights.nonResidential;
  }

  const nearbyHouseSchemas = Object.values(existingSchemas).filter((schema) => {
    return isHouseFamilyCategory(schema.category)
      && distanceToPosition(schema.centerPosition, candidate.centerPosition) <= RESIDENTIAL_DISTRICT_SCHEMA_RADIUS_METERS;
  });
  residential += nearbyHouseSchemas.length * RESIDENTIAL_DISTRICT_SCHEMA_HOUSE_WEIGHT;

  return { residential, nonResidential };
}

//#region 帮助函数

function isHouseFamilyCategory(category: string): boolean {
  return category === "house" || category === "house&garage";
}



import { query } from "@/db/client.js";
import { loadServiceSql } from "@/db/sqlLoader.js";
import type { BuildingCandidate, BuildingSchema, CategoryDefinition} from "./buildingSchema.js";
import { fetchBuildingCoveringAreas, fetchBuildingRoadKinds, parseBuildingFeatureId, weightedBoolean } from "./buildingSchema.js";
import { distanceToPosition } from "../geometry.js";

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

export interface HouseDetermingFactor {
  areaSqm: number | null;
  neighborSampleCount: number;
  neighborAverageAreaSqm: number;
  isSimpleRectangle: boolean;
}

//#region 常量

// 下列常量特指功能空间的位置，只会出现在 CategoryDefinition 中
export const TOP_LEVEL = ["top_level", "second_to_top_level", "third_to_top_level"];
export const GROUND_LEVEL = ["ground_level", "second_level", "third_level"];
export const ALL_LEVELS = ["all_levels"];
export const ROOF_LEVEL = "roof_level" // 目前共享“屋顶下的阁楼”与“平房的露天屋顶”含义
export const BASE_LEVEL = "base_level"

const RESIDENTIAL_DISTRICT_SCHEMA_RADIUS_METERS = 120;

const RESIDENTIAL_DISTRICT_AREA_WEIGHTS: Record<string, { residential: number; nonResidential: number }> = {
  // 正向促进
  "landuse:residential": { residential: 6, nonResidential: 0 },
  // 负向促进
  "landuse:commercial": { residential: 0, nonResidential: 5 },
  "landuse:industrial": { residential: 0, nonResidential: 6 },
  "amenity:school": { residential: 0, nonResidential: 4 },
  "amenity:university": { residential: 0, nonResidential: 5 },
};
const RESIDENTIAL_DISTRICT_ROAD_WEIGHTS: Record<string, { residential: number; nonResidential: number }> = {
  // 正向促进
  "highway:residential": { residential: 3, nonResidential: 0 },
  "highway:service": { residential: 1, nonResidential: 0 },
  // 负向促进
  "highway:primary": { residential: 0, nonResidential: 3 },
  "highway:trunk": { residential: 0, nonResidential: 4 },
  "highway:motorway": { residential: 0, nonResidential: 5 },
};
const RESIDENTIAL_DISTRICT_SCHEMA_HOUSE_WEIGHT = 4;

const HOUSE_DETERMING_NEIGHBOR_RADIUS_METERS = 60;
export const HOUSE_DETERMING_RELATIVE_AREA_THRESHOLD = 0.5;
export const HOUSE_DETERMING_MIN_NEIGHBOR_SAMPLE_COUNT = 1;
export const RESIDENTIAL_ACCESSORY_CONTEXT_RADIUS_METERS = 25;

export const TINY_RESIDENTIAL_BUILDING_AREA_MAX_SQM = 30;
export const APARTMENT_AREA_MIN_SQM = 220;
export const APARTMENT_LEVELS_MIN = 2;
export const APARTMENT_SUITE_AREA_SQM = 80;
export const APARTMENT_GROUND_ORDINARY_ROOM_AREA_SQM = 40;
export const SMALL_APARTMENT_PATTERN_AREA_MAX_SQM = 400;
export const SMALL_HOUSE_AREA_MAX_SQM = 90;
export const MEDIUM_HOUSE_AREA_MAX_SQM = 220;

export const RESIDENTIAL_CATEGORY_KEYS: string[] = [];
export const RESIDENTIAL_PATTERN_KEYS: string[] = [];

const residentialCategoryDefinitions: Record<string, CategoryDefinition> = {};

export function registerResidentialCategoryDefinitions(
  categories: Record<string, CategoryDefinition>,
): void {
  Object.keys(residentialCategoryDefinitions).forEach((key) => {
    delete residentialCategoryDefinitions[key];
  });
  Object.assign(residentialCategoryDefinitions, categories);

  RESIDENTIAL_CATEGORY_KEYS.splice(0, RESIDENTIAL_CATEGORY_KEYS.length, ...Object.keys(categories));
  RESIDENTIAL_PATTERN_KEYS.splice(
    0,
    RESIDENTIAL_PATTERN_KEYS.length,
    ...Object.entries(categories)
      .flatMap(([key, cat]) => {
        if ('base_schema' in cat && cat.base_schema && 'self' in cat.base_schema.rooms) return key // 简单类型返回 Category Key 本身作为 Pattern Key
        if ('patterns' in cat && cat.patterns) return Object.keys(cat.patterns)
      })
      .filter((key): key is string => key !== undefined),
  );
}

//#region 分类函数

export function isHouseDetermingFactorApartment(
  candidate: BuildingCandidate,
  factor: HouseDetermingFactor,
): boolean {
  return (
    factor.areaSqm !== null
    && factor.areaSqm >= APARTMENT_AREA_MIN_SQM
    && candidate.buildingLevels !== null
    && candidate.buildingLevels >= APARTMENT_LEVELS_MIN
  ) || (
    // 面积超大且处在居住区，那只能是公寓了
    factor.areaSqm !== null
    && factor.areaSqm >= APARTMENT_AREA_MIN_SQM * 5
  );
}

export function isHouseDetermingFactorAccessory(factor: HouseDetermingFactor): boolean {
  if (factor.areaSqm !== null && factor.areaSqm < TINY_RESIDENTIAL_BUILDING_AREA_MAX_SQM) {
    return true;
  }

  if ( // 没有其他建筑，按独栋住宅处理
    factor.areaSqm === null
    || factor.neighborSampleCount === null
    || factor.neighborSampleCount < HOUSE_DETERMING_MIN_NEIGHBOR_SAMPLE_COUNT
    || factor.neighborAverageAreaSqm === null
  ) {
    return false;
  }

  return factor.isSimpleRectangle
    && factor.areaSqm !== null
    && factor.areaSqm < factor.neighborAverageAreaSqm * HOUSE_DETERMING_RELATIVE_AREA_THRESHOLD;
}

//#region 帮助函数

export function getResidentialCategoryDefinition(categoryKey: string): CategoryDefinition | undefined {
  return residentialCategoryDefinitions[categoryKey];
}

/**
 * 在没有 explicit building tag 的情况下，
 * 结合覆盖区域、周边道路和已有 schema 判断当前建筑是否位于独栋住宅区。
 * @param candidate
 * @param existingSchemas
 * @returns 是否位于住宅区
 */
export async function isResidential(
  candidate: BuildingCandidate,
  existingSchemas: BuildingSchema[],
): Promise<boolean> {
  const [coveringAreas, roadKinds] = await Promise.all([
    // 只是查询周边状况，精度不用很高，整个 details list 随便选一个就能代表全体周边状况
    fetchBuildingCoveringAreas(candidate.details[0].featureId),
    fetchBuildingRoadKinds(candidate.details[0].featureId),
  ]);
  // console.log('覆盖区域: ',coveringAreas);
  // console.log('周边道路: ',roadKinds);

  const weights = computeResidentialDistrictWeights(candidate, existingSchemas, coveringAreas, roadKinds);
  // console.log('weights: ',weights);
  const isResidentialDistrict = weightedBoolean(weights.residential, weights.nonResidential);
  // console.log('isResidentialDistrict: ',isResidentialDistrict);
  if (!isResidentialDistrict) {
    // console.log('随机判定不是住宅区建筑');
    return false;
  }

  return true;
}

/**
 * 根据未知的候选建筑所处区域与周边道路，生成加权结果。
 * 该结果用于确定候选建筑是否是住宅区
 * @param candidate
 * @param existingSchemas
 * @param coveringAreas
 * @param roadKinds
 * @returns
 */
function computeResidentialDistrictWeights(
  candidate: BuildingCandidate,
  existingSchemas: BuildingSchema[],
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

  const nearbyHouseSchemas = existingSchemas.filter((schema) => {
    return isHouseFamilyCategory(schema.category)
      && distanceToPosition(schema.centerPosition, candidate.centerPosition) <= RESIDENTIAL_DISTRICT_SCHEMA_RADIUS_METERS;
  });
  residential += nearbyHouseSchemas.length * RESIDENTIAL_DISTRICT_SCHEMA_HOUSE_WEIGHT;

  return { residential, nonResidential };
}

const fetchHouseDetermingFactorSqlPromise = loadServiceSql("gameSystem/sql/fetchHouseDetermingFactor.sql");

/**
 * 获取判断住宅细分类型所需的周遭建筑数据与建筑本身数据。
 * @param candidate 已缩小到住宅区范围内的建筑候选
 * @returns HouseDetermingFactor
 */
export async function fetchHouseDetermingFactor(candidate: BuildingCandidate): Promise<HouseDetermingFactor> {
  const featureId = candidate.details[0].featureId;
  const featureRef = parseBuildingFeatureId(featureId);
  const sql = await fetchHouseDetermingFactorSqlPromise;
  const result = await query<DbHouseDetermingRow>(
    sql,
    [featureRef.osmType, featureRef.osmId, HOUSE_DETERMING_NEIGHBOR_RADIUS_METERS],
  );
  const row = result.rows[0];

  const areaSqm = row?.area_sqm ?? candidate.areaSqm;
  // console.log(`${featureId}: 面积${areaSqm}`);
  const neighborSampleCount = row?.neighbor_sample_count ?? 0;
  // console.log(`周围建筑数${neighborSampleCount}`);
  const neighborAverageAreaSqm = row?.neighbor_average_area_sqm ?? 0;
  // console.log(`周围平均面积${neighborAverageAreaSqm}`);

  return {
    areaSqm,
    neighborSampleCount,
    neighborAverageAreaSqm,
    isSimpleRectangle: row?.is_simple_rectangle === true,
  };
}

const fetchNearbyParkingSignalSqlPromise = loadServiceSql("gameSystem/sql/fetchNearbyParkingSignal.sql");

/**
 * 决定某一已确定是住宅区的地物周遭是否有停车场所
 * @param featureId
 * @returns
 */
export async function fetchNearbyParkingSignal(featureId: string): Promise<boolean> {
  const featureRef = parseBuildingFeatureId(featureId);
  const sql = await fetchNearbyParkingSignalSqlPromise;
  const result = await query<DbNearbyParkingSignalRow>(
    sql,
    [featureRef.osmType, featureRef.osmId, RESIDENTIAL_ACCESSORY_CONTEXT_RADIUS_METERS],
  );

  return result.rows[0]?.has_nearby_parking === true;
}

export function getNearbyResidentialSchemas(
  candidate: BuildingCandidate,
  existingSchemas: BuildingSchema[],
): BuildingSchema[] {
  return existingSchemas.filter((schema) => {
    return distanceToPosition(schema.centerPosition, candidate.centerPosition) <= RESIDENTIAL_ACCESSORY_CONTEXT_RADIUS_METERS;
  });
}

export function isHouseFamilyCategory(category: string): boolean {
  return category === "house" || category === "house&garage";
}

export function normalizeBuildingLevels(buildingLevels: number | null): number {
  return Math.max(1, buildingLevels ?? 1);
}

export function rangeNumbers(start: number, endInclusive: number): number[] {
  const result: number[] = []
  for (let i = start; i <= endInclusive; i++) {
    result.push(i);
  }
  return result;
}

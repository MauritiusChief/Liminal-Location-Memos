import { loadServiceSql } from "@/db/sqlLoader.js";
import { BuildingCandidate, BuildingSchema, CategoryDefinition, CategoryLevelSchema, CategoryRoomSchema, CategorySchema, fetchBuildingCoveringAreas, fetchBuildingRoadKinds, parseBuildingFeatureId, PatternDistribution, PatternRoomDefinition, pickRandom, RoomSchema, SectorDistributionSchem, SuiteSchema, weightedBoolean } from "./buildingClassifier.js";
import { query } from "@/db/client.js";
import { distanceToPosition } from "../geometry.js";
import { FeatureId } from "../featureDetail.js";

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

type ApartmentSuiteRoomDefinition = {
  desc: string;
  chance?: number;
  count?: number;
};
type ApartmentSuiteTemplate = Record<string, ApartmentSuiteRoomDefinition>;

//#region 常量

// 下列常量特指功能空间的位置，只会出现在 CategoryDefinition 中
const TOP_LEVEL = ["top_level", "second_to_top_level", "third_to_top_level"];
const GROUND_LEVEL = ["ground_level", "second_level", "third_level"];
const ALL_LEVELS = ["all_levels"];
const ROOF_LEVEL = "roof_level" // 目前共享“屋顶下的阁楼”与“平房的露天屋顶”含义
const BASE_LEVEL = "base_level"

// 下列常量特指功能空间的名字，只会出现在 C-Schema 以及后续 Schema 中
/**
 * House 仅可安放常规功能空间的三种楼层
 */
const HOUSE_FLOORS = ["ground_floor", "middle_floor", "top_floor"];
const APARTMENT_FLOORS = ["ground_floor", "residential_floor"];
const ACCESSORY_DEFAULT_FLOOR = "default_floor";
const ROOF_FLOOR = "roof";
const ATTIC_FLOOR = "attic"
const BASE_FLOOR = "basement";

/**
 * 兼作分类结果（单独把 key 提取出来）和 Pattern 记录
 * 此表内容仅表示种类，不表示数量或与面积的关联
 * - prefered：代表该功能应优先出现的楼层
 */
export const RESIDENTIAL_CATEGORIES: Record<string, CategoryDefinition> = {
  house: {desc: "住宅",
    base_schema: {rooms: {
      storage: {desc: "杂物存储空间", prefered: ROOF_LEVEL, chance: 0.5},
      hvac: {desc: "空调-通风-供暖(HVAC)系统", prefered: ROOF_LEVEL},
    }},
    patterns: {
      studio: {desc: "仅卧室、客厅、浴室的简单布局", rooms: {
        bedroom: {desc: "卧室", prefered: TOP_LEVEL[0]},
        living_room: {desc: "与餐厅、厨房相连的客厅", prefered: GROUND_LEVEL[0]},
        bath_room: {desc: "带厕所的浴室", prefered: TOP_LEVEL[0]},
      }},
      standard: {desc: "单间卧室的常规布局", rooms: {
        bedroom: {desc: "卧室", prefered: TOP_LEVEL[0]},
        living_room: {desc: "客厅", prefered: GROUND_LEVEL[0]},
        kitchen: {desc: "带餐厅的厨房", prefered: GROUND_LEVEL[0]},
        bath_room: {desc: "带厕所的浴室", prefered: TOP_LEVEL[0]},
        // 概率房间
        laundry: {desc: "洗衣间", prefered: GROUND_LEVEL[0], chance: 0.2},
      }},
      duplex: {desc: "一到两间卧室的较复杂布局", rooms: {
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
      }},
      elaborate: {desc: "三到四间卧室的复杂房屋布局", rooms: {
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
      }}
    }
  },
  // 带车库的住宅通过应用复合型 Category “住宅 - 内含 车库” 表示
  // 就像 “图书馆 - 内含 咖啡厅”
  garage: {desc: "车库", base_schema: {rooms: {self: {prefered: GROUND_LEVEL[0]}}}},
  tool_shed: {desc: "工具屋", base_schema: {rooms: {self: {prefered: GROUND_LEVEL[0]}}}},
  // 公寓
  apartment: {desc: "公寓楼",
    base_schema: {rooms: {
      janitor_room: {desc: "清洁间", prefered: GROUND_LEVEL[0]},
      trash_room: {desc: "垃圾站", prefered: GROUND_LEVEL[0]},
      electrical_room: {desc: "配电间", prefered: ALL_LEVELS[0]},
      storage_unit: {desc: "迷你自存仓", prefered: GROUND_LEVEL[0], chance: 0.2},
    }},
    patterns: {
      studio_apt: {desc: "以小型单间公寓为主的公寓楼", rooms: {
        studio_suite: {desc: "单间公寓套房", prefered: ALL_LEVELS[0]},
      }},
      standard_apt: {desc: "以标准公寓套房为主的公寓楼", rooms: {
        standard_suite: {desc: "标准公寓套房", prefered: ALL_LEVELS[0]},
        studio_suite: {desc: "单间公寓套房", prefered: ALL_LEVELS[0], chance: 0.2},
      }},
    },
  },
  apartment_utility: {desc: "公寓公共设施", base_schema: {rooms: {
    mail_room: {desc: "收发室", prefered: GROUND_LEVEL[0]},
    laundry_room: {desc: "公共洗衣房", prefered: GROUND_LEVEL[0]},
    gym: {desc: "健身房", prefered: GROUND_LEVEL[0]},
  }}},
} as const;
export const RESIDENTIAL_CATEGORY_KEYS = Object.keys(RESIDENTIAL_CATEGORIES)
export const RESIDENTIAL_PATTERN_KEYS = Object.entries(RESIDENTIAL_CATEGORIES)
  .flatMap(([key, cat]) => {
    if ('base_schema' in cat && cat.base_schema && 'self' in cat.base_schema.rooms) return key // 简单类型返回 Category Key 本身作为 Pattern Key
    if ('patterns' in cat && cat.patterns) return Object.keys(cat.patterns)
  }).filter(k => k !== undefined)

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
const HOUSE_DETERMING_RELATIVE_AREA_THRESHOLD = 0.5;
const HOUSE_DETERMING_MIN_NEIGHBOR_SAMPLE_COUNT = 1;
const RESIDENTIAL_ACCESSORY_CONTEXT_RADIUS_METERS = 25;

const TINY_RESIDENTIAL_BUILDING_AREA_MAX_SQM = 30;
const APARTMENT_AREA_MIN_SQM = 220;
const APARTMENT_LEVELS_MIN = 2;
const APARTMENT_SUITE_AREA_SQM = 80;
const APARTMENT_GROUND_ORDINARY_ROOM_AREA_SQM = 40;
const SMALL_APARTMENT_PATTERN_AREA_MAX_SQM = 400;
const SMALL_HOUSE_AREA_MAX_SQM = 90;
const MEDIUM_HOUSE_AREA_MAX_SQM = 220;

// 套房模板只描述套房内部有哪些子房间；具体数量在收尾阶段按套房数量折算。
const RESIDENTIAL_SUITE_TEMPLATES: Record<string, Record<string, ApartmentSuiteTemplate>> = {
  studio_suite: {
    studio: {
      living_room: { desc: "卧室、客厅、厨房一体空间" },
      bath_room: { desc: "带厕所浴室" },
    },
    seperate_bedroom: {
      bedroom_wild: { desc: "卧室类房间（可为卧室/儿童卧室/办公室）", count: 1 },
      living_room: { desc: "与厨房相连的客厅" },
      bath_room: { desc: "带厕所浴室" },
    },
  },
  standard_suite: {
    standard: {
      bedroom_wild: { desc: "卧室类房间（可为卧室/儿童卧室/办公室）", count: 2 },
      living_room: { desc: "客厅" },
      kitchen: { desc: "厨房" },
      bath_room: { desc: "带厕所浴室" },
      closet: { desc: "储物间", chance: 0.6 },
    },
    seperate_restroom: {
      bedroom_wild: { desc: "卧室类房间（可为卧室/儿童卧室/办公室）", count: 2 },
      living_room: { desc: "客厅" },
      kitchen: { desc: "带餐厅的厨房" },
      bath_room: { desc: "浴室" },
      rest_room: { desc: "厕所" },
      closet: { desc: "储物间", chance: 0.6 },
    },
  },
};
const RESIDENTIAL_SUITE_KEYS = Object.keys(RESIDENTIAL_SUITE_TEMPLATES)


//#####################
//#region Category 逻辑
//#####################


/**
 * 在没有 explicit building tag 的情况下，
 * 结合覆盖区域、周边道路和已有 schema 判断当前建筑是否位于独栋住宅区。
 * @param candidate
 * @param existingSchemas
 * @returns 已分类好的 Category，或者表示不位于独栋住宅区的的空 []
 */
export async function ambiguousResidentialCategory(
  candidate: BuildingCandidate,
  existingSchemas: BuildingSchema[],
): Promise<string[]> {
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
    return [];
  }

  const [buildingKind, hasNearbyParking] = await Promise.all([
    // 住宅细分需要同时读取数据库面积/邻居信息和 candidate 上已经解析出的楼层数。
    determineResidentialBuildingKind(candidate),
    determineNearbyParkingSignal(candidate.details[0].featureId),
  ]);
  const nearbySchemas = existingSchemas.filter((schema) => {
    return distanceToPosition(schema.centerPosition, candidate.centerPosition) <= RESIDENTIAL_ACCESSORY_CONTEXT_RADIUS_METERS;
  });

  if (buildingKind === "apartment") {
    return weightedBoolean(3, 7)
      ? ["apartment", "apartment_utility"]
      : ["apartment"];
  }

  // 如果是住宅则根据是否有外置停车地点来判断本体需不需要车库
  if (buildingKind === "house") {
    const hasNearbyGarage = nearbySchemas.some((schema) => schema.category === "garage");
    if (hasNearbyParking || hasNearbyGarage) {
      return ["house"];
    }

    return weightedBoolean(9, 1)
      ? ["house","garage"]
      : ["house"];
  }

  // 过小的住宅区建筑固定视作工具屋，避免把明显的储物/工具空间随机成车库。
  if (candidate.areaSqm !== null && candidate.areaSqm < TINY_RESIDENTIAL_BUILDING_AREA_MAX_SQM) {
    return ["tool_shed"];
  }

  // 如果是附属建筑，首先根据周围住宅是否有内置车库来判断，已有内置车库就不需要车库了
  const hasNearbyHouseGarage = nearbySchemas.some((schema) => schema.category === "house&garage");
  if (hasNearbyHouseGarage) {
    return ["tool_shed"];
  }

  if (hasNearbyParking) { // 即使有外置停车地点，也可能需要独立车库
    return weightedBoolean(9, 1)
      ? ["tool_shed"]
      : ["garage"];
  }

  // 没有内置车库且没有外置停车地点，大概率是独立车库，但仍有小概率是街边停车+工具房
  return weightedBoolean(1, 9)
    ? ["tool_shed"]
    : ["garage"];
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
const fetchNearbyParkingSignalSqlPromise = loadServiceSql("gameSystem/sql/fetchNearbyParkingSignal.sql");

/**
 * 判断一个建筑是“公寓楼”、“独栋住宅”或“独立附属建筑（独立车库/工具屋）”。
 *
 * 输入前提：
 * - 默认调用方已经确认候选属于住宅区
 *
 * 保守策略：
 * - 公寓只看稳定的面积与楼层信号；
 * - 过小建筑固定走附属建筑分支；
 * - 当目标建筑邻域样本不足或关键几何证据不足时，一律按住宅处理。
 *
 * @param candidate 已缩小到住宅区范围内的建筑候选
 * @returns 住宅区内的细分建筑种类
 */
async function determineResidentialBuildingKind(candidate: BuildingCandidate): Promise<"apartment" | "house" | "accessory"> {
  // 获取数据库中的周遭建筑数据与建筑本身数据
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

  // 进行判断
  if (areaSqm !== null && areaSqm < TINY_RESIDENTIAL_BUILDING_AREA_MAX_SQM) {
    return "accessory";
  }

  if (
    areaSqm !== null
    && areaSqm >= APARTMENT_AREA_MIN_SQM
    && candidate.buildingLevels !== null
    && candidate.buildingLevels >= APARTMENT_LEVELS_MIN
  ) {
    return "apartment";
  }

  if ( // 面积超大且处在居住区，那只能是公寓了
    areaSqm !== null
    && areaSqm >= APARTMENT_AREA_MIN_SQM * 5
  ) {
    return "apartment";
  }

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
    && areaSqm !== null
    && areaSqm < neighborAverageAreaSqm * HOUSE_DETERMING_RELATIVE_AREA_THRESHOLD
  ) {
    return "accessory";
  }

  return "house";
}

/**
 * 决定某一已确定是住宅区的地物周遭是否有停车场所
 * @param featureId
 * @returns
 */
async function determineNearbyParkingSignal(featureId: string): Promise<boolean> {
  const featureRef = parseBuildingFeatureId(featureId);
  const sql = await fetchNearbyParkingSignalSqlPromise;
  const result = await query<DbNearbyParkingSignalRow>(
    sql,
    [featureRef.osmType, featureRef.osmId, RESIDENTIAL_ACCESSORY_CONTEXT_RADIUS_METERS],
  );

  return result.rows[0]?.has_nearby_parking === true;
}


//####################
//#region Pattern 逻辑
//####################


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
  if (categoryKey === "apartment") {
    return pickRandom(determineApartmentPatternPool(candidate));
  }

  // 简单建筑直接返回 Category Key 作为 Pattern Key
  // console.log(RESIDENTIAL_PATTERN_KEYS);
  if (RESIDENTIAL_PATTERN_KEYS.includes(categoryKey)) return categoryKey

  const categoryPatterns = RESIDENTIAL_CATEGORIES[categoryKey]?.patterns;
  if (categoryPatterns) {
    return pickRandom(Object.keys(categoryPatterns));
  }
  if (RESIDENTIAL_CATEGORIES[categoryKey]) return categoryKey;

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

/**
 * 为公寓选择 Pattern 候选池。
 * 小体量或低楼层公寓允许出现单间公寓为主的布局；更大的公寓默认使用标准套房布局。
 * @param candidate 已确定为公寓的建筑候选
 * @returns 允许抽样的公寓 pattern 列表
 */
function determineApartmentPatternPool(candidate: BuildingCandidate): string[] {
  const { areaSqm, buildingLevels } = candidate;

  if ((areaSqm !== null && areaSqm <= SMALL_APARTMENT_PATTERN_AREA_MAX_SQM) || (buildingLevels !== null && buildingLevels <= 2)) {
    return ["studio_apt", "standard_apt"];
  }

  return ["standard_apt"];
}


//#####################
//#region C-Schema 逻辑
//#####################

/**
 * 因默认为 House 类，所以楼层数会控制为 1 到 3；
 * 从已应用 Pattern Distribution 的 Base Schema 中获取某住宅有哪些功能、有何种偏好，
 * 然后从 Candidate 中获取此住宅的楼层，最后根据偏好的楼层把功能安插到楼层中去。
 * （不涉及房间数量、出入口与通道、套房细节）
 * @param appliedBaseSchema
 * @param candidate
 * @returns 以 Feature ID 为键的 CategorySchema
 */
export function buildHouseCategorySchemaFromDistribution(
  appliedBaseSchema: PatternDistribution,
  candidate: BuildingCandidate,
): Record<FeatureId, CategorySchema> {
  if (!candidate.categoryRecord) return {} // 如果此时还没有 Category 结果，说明肯定是出问题了
  // 控制楼层数在 1 ~ 3 范围
  const buildingLevels = candidate.buildingLevels ? Math.min(3, candidate.buildingLevels) : 1 // 此处默认1层是合理的，因为 Pattern 本身就是被面积与楼层决定的，不会出现不够用的情况

  const result: Record<FeatureId, CategorySchema> = {}
  Object.entries(appliedBaseSchema).forEach(([featureId, roomDefs]) => {

    // 组装空的楼层
    const levels: Record<string, CategoryLevelSchema> = {}
    const concreteLevelKeys: string[] = []
    for (let i = 1; i <= buildingLevels; i++) {
      const levelKey = resolveHouseConcreteLevelKey(i, buildingLevels)
      concreteLevelKeys.push(levelKey)
      levels[levelKey] = {
        span: [i], // span 固定只有1层的范围
        rooms: {}, // 等待后续装填
      }
    }
    levels[ATTIC_FLOOR] = { // 添加阁楼
      span: [buildingLevels+1],
      rooms: {},
    }
    // TODO 添加地下室

    // 每个建筑所对应的功能房间都要决定一次装填到哪个楼层
    Object.entries(roomDefs).forEach(([roomKey, definition]) => {
      // 决定去哪个/哪些楼层，返回这些楼层的 key
      const levelKeys = resolveHouseCategorySchemaLevelKeys(definition.prefered, levels, concreteLevelKeys);
      for (const levelKey of levelKeys) {
        if (definition.chance && 1 - definition.chance > Math.random()) continue // 有概率直接跳过，不写入 levels
        levels[levelKey].rooms[roomKey] = {
          descrption: definition.desc ?? roomKey,
        };
      }
    });

    // TODO 如果各楼层的房间分布不均匀，则挪一挪

    result[featureId] = {
      levels
    }
  });

  return result
}

/**
 * 独立附属建筑(Accessory)的 C-Schema 逻辑
 * 默认楼层数限制为1，且只有1个房间
 * @param appliedBaseSchema
 * @param candidate
 * @returns
 */
export function buildResidentialAccessoryCategorySchemaFromDistribution(
  appliedBaseSchema: PatternDistribution,
  candidate: BuildingCandidate,
): Record<FeatureId, CategorySchema> {
  if (!candidate.categoryRecord) return {}

  const result: Record<FeatureId, CategorySchema> = {}
  Object.entries(appliedBaseSchema).forEach(([featureId, roomDefs]) => {
    const level: CategoryLevelSchema = {
      span: [1],
      rooms: {},
    };

    // 独立附属建筑按单一功能空间建模，避免复用住宅的楼层命名和通道规则。
    Object.entries(roomDefs).forEach(([roomKey, definition]) => {
      if (definition.chance && 1 - definition.chance > Math.random()) return
      level.rooms[roomKey] = {
        descrption: definition.desc ?? roomKey,
      };
    });

    result[featureId] = {
      levels: {
        [ACCESSORY_DEFAULT_FLOOR]: level,
      },
    }
  });

  return result
}

/**
 * 公寓楼的 C-Schema 逻辑
 * 只保留 ground_floor 与 residential_floor 两种楼层语义：
 * - ground_floor 表示入口层和整栋公寓共享的公共/设备空间；
 * - residential_floor 表示二层及以上所有可居住楼层。
 * @param appliedBaseSchema
 * @param candidate
 * @returns
 */
export function buildApartmentCategorySchemaFromDistribution(
  appliedBaseSchema: PatternDistribution,
  candidate: BuildingCandidate,
): Record<FeatureId, CategorySchema> {
  if (!candidate.categoryRecord) return {}
  // 公寓缺少楼层信息时保守按2层处理，保证存在 residential_floor。
  const buildingLevels = Math.max(APARTMENT_LEVELS_MIN, candidate.buildingLevels ?? APARTMENT_LEVELS_MIN);

  const result: Record<FeatureId, CategorySchema> = {}
  Object.entries(appliedBaseSchema).forEach(([featureId, roomDefs]) => {
    const levels: Record<string, CategoryLevelSchema> = {
      [APARTMENT_FLOORS[0]]: {
        span: [1],
        rooms: {},
      },
      [APARTMENT_FLOORS[1]]: {
        span: rangeNumbers(2, buildingLevels),
        rooms: {},
      },
    };

    Object.entries(roomDefs).forEach(([roomKey, definition]) => {
      if (definition.chance && 1 - definition.chance > Math.random()) return
      const levelKeys = resolveApartmentCategorySchemaLevelKeys(roomKey, definition.prefered);
      levelKeys.forEach((levelKey) => {
        levels[levelKey].rooms[roomKey] = {
          descrption: definition.desc ?? roomKey,
        };
      });
    });

    result[featureId] = {
      levels,
    }
  });

  return result
}

/**
 * 根据 House 的建筑总楼层和当前楼层，返回当前这个楼层应该叫什么名字
 * @param levelNumber
 * @param buildingLevels
 * @returns
 */
function resolveHouseConcreteLevelKey(levelNumber: number, buildingLevels: number): string {
  if (buildingLevels === 1) return HOUSE_FLOORS[0];
  if (levelNumber === 1) return HOUSE_FLOORS[0];
  if (levelNumber === buildingLevels) return HOUSE_FLOORS[2];
  return HOUSE_FLOORS[1];
}

/**
 * 通过各种条件，选出 House 当中最适合填入某个建筑的楼层 key。
 * 相当于把位置 key 转化为具体楼层名字。
 * @param prefered
 * @param levels
 * @param concreteLevelKeys 可被填的所有楼层
 * @returns 需要填充的楼层的 key
 */
function resolveHouseCategorySchemaLevelKeys(
  prefered: string | undefined,
  levels: Record<string, CategoryLevelSchema>,
  concreteLevelKeys: string[],
): string[] {
  if (prefered === ALL_LEVELS[0]) return concreteLevelKeys;

  if (!prefered) return [pickRandom(concreteLevelKeys)];

  if (TOP_LEVEL.includes(prefered)) return [concreteLevelKeys[concreteLevelKeys.length - 1]];

  if (GROUND_LEVEL.includes(prefered)) return [concreteLevelKeys[0]];

  if (prefered === ROOF_LEVEL) return [ATTIC_FLOOR]

  if (prefered === BASE_LEVEL) return [BASE_FLOOR]

  if (levels[prefered]) return [prefered]; // 保底用，直接返回位置 key 碰碰运气

  return [pickRandom(concreteLevelKeys)];
}

/**
 * 把公寓 Category 中的抽象位置收束到 ground_floor / residential_floor。
 * 所有 *_suite 固定进入居住层，同时复制到地面层作为候选；
 * 其他公共设施和设备房默认进入地面层。
 * @param roomKey
 * @param prefered
 * @returns 需要填充的公寓楼层 key
 */
function resolveApartmentCategorySchemaLevelKeys(
  roomKey: string,
  prefered: string | undefined,
): string[] {
  if (RESIDENTIAL_SUITE_KEYS.includes(roomKey)) return APARTMENT_FLOORS;
  if (prefered === ALL_LEVELS[0]) return [APARTMENT_FLOORS[1]];
  if (TOP_LEVEL.includes(prefered ?? "")) return [APARTMENT_FLOORS[1]];
  return [APARTMENT_FLOORS[0]];
}


//################
//#region 收尾逻辑
//################

/**
 * 住宅(House)的收尾逻辑
 * @param schemas
 * @param candidate
 * @returns
 */
export function finishHouseBuildingSchema(
  schemas: Record<FeatureId, SectorDistributionSchem>,
  candidate: BuildingCandidate,
): Record<FeatureId, BuildingSchema>  {
  const result: Record<FeatureId, BuildingSchema> = {}
  const categoryKey = candidate.categoryRecord?.join('&') || '出错';
  Object.entries(schemas).forEach(([featureId, schema]) => {
    // 装填楼层中缺失的信息
    const levels: BuildingSchema["levels"] = Object.fromEntries(
      Object.entries(schema.levels).map(([levelKey, level]) => {
        const sectors = Object.fromEntries(
          Object.entries(level.sectors).map(([sectorKey, sector]) => {
            const rooms = resolveResidentialSectorRooms(sector.rooms);

            // 住宅主体收尾负责补齐卧室组、入口和垂直通道；独立附属建筑由单独 finalizer 处理。
            applyHouseSharedRoomCounts(candidate, rooms);

            // 收尾阶段补齐进入建筑和楼层间移动所需的通道房间。
            // 门厅只属于地面层；楼梯间需要在每个实际楼层都能被引用。
            applyHouseAccessRooms(candidate, levelKey, rooms);

            return [sectorKey, {
              area: sector.area,
              centerPosition: sector.centerPosition,
              rooms,
            }];
          }),
        );

        return [levelKey, {
          span: level.span,
          sectors,
        }];
      }),
    );

    result[featureId] = {
      featureId,
      category: categoryKey, // 输出到 Building Schema 后，因为不再用到 category 了，就直接组合为单一字符串了
      centerPosition: candidate.centerPosition,
      levels,
    };
  })
  return result
}

/**
 * 独立附属建筑 (Accessory) 的收尾逻辑
 * @param schemas
 * @param candidate
 * @returns
 */
export function finishResidentialAccessoryBuildingSchema(
  schemas: Record<FeatureId, SectorDistributionSchem>,
  candidate: BuildingCandidate,
): Record<FeatureId, BuildingSchema>  {
  const result: Record<FeatureId, BuildingSchema> = {}
  const categoryKey = candidate.categoryRecord?.join('&') || '出错';
  Object.entries(schemas).forEach(([featureId, schema]) => {
    const levels: BuildingSchema["levels"] = Object.fromEntries(
      Object.entries(schema.levels).map(([levelKey, level]) => {
        const sectors = Object.fromEntries(
          Object.entries(level.sectors).map(([sectorKey, sector]) => {
            const roomsEntries = Object.entries(resolveResidentialSectorRooms(sector.rooms));
            // 独立附属建筑肯定只有1个房间，所以全部加上 access entrance
            // 出问题了再说吧
            const rooms: Record<string, RoomSchema> = Object.fromEntries(roomsEntries.map(([k, v]) => [k, {...v, access: "entrance"}]))
            return [sectorKey, {
              area: sector.area,
              centerPosition: sector.centerPosition,
              rooms,
            }];
          }),
        );

        return [levelKey, {
          span: level.span,
          sectors,
        }];
      }),
    );

    result[featureId] = {
      featureId,
      category: categoryKey,
      centerPosition: candidate.centerPosition,
      levels,
    };
  })
  return result
}

/**
 * 公寓楼(Apartment)的收尾逻辑
 * 普通公共房间继续输出 RoomSchema，*_suite 会在此阶段转为 SuiteSchema。
 * @param schemas
 * @param candidate
 * @returns
 */
export function finishApartmentBuildingSchema(
  schemas: Record<FeatureId, SectorDistributionSchem>,
  candidate: BuildingCandidate,
): Record<FeatureId, BuildingSchema>  {
  const result: Record<FeatureId, BuildingSchema> = {}
  const categoryKey = candidate.categoryRecord?.join('&') || '出错';
  Object.entries(schemas).forEach(([featureId, schema]) => {
    const levels: BuildingSchema["levels"] = Object.fromEntries(
      Object.entries(schema.levels).map(([levelKey, level]) => {
        const sectors = Object.fromEntries(
          Object.entries(level.sectors).map(([sectorKey, sector]) => {
            const rooms = resolveApartmentSectorRooms(sector.rooms);

            // 公寓入口与垂直交通是整栋建筑级能力，不属于任何单个套房。
            applyApartmentAccessRooms(candidate, levelKey, rooms);
            applyApartmentSuiteCapacity(candidate, levelKey, sector.area, rooms);

            return [sectorKey, {
              area: sector.area,
              centerPosition: sector.centerPosition,
              rooms,
            }];
          }),
        );

        return [levelKey, {
          span: level.span,
          sectors,
        }];
      }),
    );

    result[featureId] = {
      featureId,
      category: categoryKey,
      centerPosition: candidate.centerPosition,
      levels,
    };
  })
  return result
}

/**
 * House 使用的卧室数量生成函数
 * @param candidate
 * @returns
 */
function determineSharedBedroomLimit(candidate: BuildingCandidate): number {
  const { areaSqm, buildingLevels } = candidate;

  if ((areaSqm === null || areaSqm <= SMALL_HOUSE_AREA_MAX_SQM) && (buildingLevels === null || buildingLevels <= 1)) {
    return weightedBoolean(3, 1) ? 1 : 2;
  }

  if ((areaSqm === null || areaSqm <= MEDIUM_HOUSE_AREA_MAX_SQM) && (buildingLevels === null || buildingLevels <= 2)) {
    return pickRandom([2, 3]);
  }

  return pickRandom([3, 4]);
}


//#region 帮助函数

function isHouseFamilyCategory(category: string): boolean {
  return category === "house" || category === "house&garage";
}

/**
 * 把 CategoryRoomSchema 转为最终 RoomSchema。
 *
 * Category 阶段只表达“有什么功能”，不表达数量；这里先给每个房间默认 1，
 * 后续 helper 再按住宅规则调整共享卧室组、入口和楼梯间。
 * @param rooms Sector Distribution 中的房间定义
 * @returns 可写入 BuildingSchema 的房间定义
 */
function resolveResidentialSectorRooms(
  rooms: Record<string, CategoryRoomSchema>,
): Record<string, RoomSchema> {
  return Object.fromEntries(
    Object.entries(rooms).map(([roomKey, room]) => [roomKey, {
      descrption: room.descrption,
      count: 1,
      ...(room.access ? { access: room.access } : {}),
    }]),
  );
}

/**
 * 将公寓的 CategoryRoomSchema 转为最终房间结构。
 * *_suite 在此处膨胀为 SuiteSchema 候选；具体数量和是否保留在容量校验阶段处理。
 * @param rooms
 * @returns
 */
function resolveApartmentSectorRooms(
  rooms: Record<string, CategoryRoomSchema>,
): Record<string, RoomSchema | SuiteSchema> {
  const result: Record<string, RoomSchema | SuiteSchema> = {}

  Object.entries(rooms).forEach(([roomKey, room]) => {
    if (RESIDENTIAL_SUITE_KEYS.includes(roomKey)) {
      const suite = buildApartmentSuiteSchema(roomKey);
      result[roomKey] = {
        count: suite.count,
        subRooms: suite.subRooms,
      };
      return
    }

    if (roomKey === "storage_unit") {
      result[roomKey] = {
        descrption: room.descrption,
        count: Math.ceil(4 + Math.random() * 8), // 迷你自存仓一般有多个
        ...(room.access ? { access: room.access } : {}),
      };
      return
    }

    result[roomKey] = {
      descrption: room.descrption,
      count: 1,
      ...(room.access ? { access: room.access } : {}),
    };
  });

  return result;
}

/**
 * 从指定套房类型的模板池中抽样，把模板中的 desc/chance 转成最终子房间。
 * @param suiteKey suite 房间 key
 * @returns 可写入 BuildingSchema 的 SuiteSchema
 */
function buildApartmentSuiteSchema(
  suiteKey: string,
): SuiteSchema {
  const templates = RESIDENTIAL_SUITE_TEMPLATES[suiteKey] ?? RESIDENTIAL_SUITE_TEMPLATES[RESIDENTIAL_SUITE_KEYS[0]];
  const templateKey = pickRandom(Object.keys(templates));
  const template = templates[templateKey];
  const subRooms = buildApartmentSuiteSubRooms(template);

  return { count: 1, subRooms };
}

function buildApartmentSuiteSubRooms(
  template: ApartmentSuiteTemplate,
): SuiteSchema["subRooms"] {
  const subRooms: SuiteSchema["subRooms"] = {};
  Object.entries(template).forEach(([roomKey, definition]) => {
    if (definition.chance && 1 - definition.chance > Math.random()) return;
    subRooms[roomKey] = {
      descrption: definition.desc ?? roomKey,
      count: definition.count ?? 1,
    };
  });

  return subRooms;
}

/**
 * 用单层面积与楼层粗略估算当前 level/sector 可容纳的“套房总数”。
 *
 * 一楼需要先按普通房间数量预留公共/设备/通道空间；如果剩余面积不足一套，
 * 收尾阶段会移除 Category Schema 中提前放入的一楼套房候选。
 *
 * 注意：返回值不是每一种套房各自的数量，而是该楼层该 sector 的总套房容量。
 * 多种套房之间的数量分配由 applyApartmentSuiteCapacity 继续处理。
 *
 * @param candidate 建筑候选，用于在 sector 面积缺失时回退到建筑面积
 * @param levelKey 当前楼层语义 key
 * @param sectorArea 当前 sector 的面积
 * @param rooms 当前 sector 已转换出的房间/套房候选
 * @returns 当前 level/sector 可分配给所有套房类型的总套数
 */
function determineApartmentSuiteCount(
  candidate: BuildingCandidate,
  levelKey: string,
  sectorArea: number,
  rooms: Record<string, RoomSchema | SuiteSchema>,
): number {
  if (levelKey === APARTMENT_FLOORS[0]) {
    const ordinaryRoomCount = countApartmentOrdinaryRooms(rooms);
    // 一楼通常有公共和设备空间，因此先给面积加随机浮动，再扣掉普通房间预算。
    const floorArea = (sectorArea || candidate.areaSqm || 0) * (1 - Math.random() * 0.4); // 添加浮动的面积，在 100% ~ 60% 浮动
    const suiteArea = floorArea - ordinaryRoomCount * APARTMENT_GROUND_ORDINARY_ROOM_AREA_SQM;
    return Math.max(0, Math.floor(suiteArea / APARTMENT_SUITE_AREA_SQM));
  }

  // 居住层缺少面积信息时使用 4 套公寓的面积作为保守回退，并至少保留 1 套。
  const floorArea = (sectorArea || candidate.areaSqm || APARTMENT_SUITE_AREA_SQM*4) * (1 - Math.random() * 0.4); // 添加浮动的面积，在 100% ~ 60% 浮动
  return Math.max(1, Math.floor(floorArea / APARTMENT_SUITE_AREA_SQM));
}

/**
 * 将套房候选按当前 level/sector 的容量落成最终数量。
 *
 * Category Schema 阶段只表达“这个楼层可能有这些套房类型”；
 * 收尾阶段才按面积计算总容量，并在多种套房类型之间随机拆分。
 * 分到 0 的套房类型会被删除，避免输出 count 为 0 的 SuiteSchema。
 *
 * @param candidate 建筑候选，用于面积回退
 * @param levelKey 当前楼层语义 key
 * @param sectorArea 当前 sector 面积
 * @param rooms 当前 sector 的最终房间表，会被原地更新
 */
function applyApartmentSuiteCapacity(
  candidate: BuildingCandidate,
  levelKey: string,
  sectorArea: number,
  rooms: Record<string, RoomSchema | SuiteSchema>,
): void {
  const suiteKeys = Object.keys(rooms).filter(isApartmentSuiteRoomKey);
  if (suiteKeys.length === 0) return;

  // suiteCount 是当前楼层/sector 的总容量，不是每个 suite key 的独立容量。
  const suiteCount = determineApartmentSuiteCount(candidate, levelKey, sectorArea, rooms);
  const suiteCounts = distributeApartmentSuiteCounts(suiteCount, suiteKeys);
  suiteKeys.forEach((suiteKey) => {
    const count = suiteCounts[suiteKey] ?? 0;
    if (count <= 0) {
      // 允许随机分配后某一类套房完全不出现；删除比保留 count: 0 更干净。
      delete rooms[suiteKey];
      return;
    }
    rooms[suiteKey].count = count;
  });
}

/**
 * 将套房总容量随机拆分到多个套房类型上。
 *
 * 算法分两步：
 * 1. 为每个套房类型生成随机权重，按比例取 floor 得到基础分配；
 * 2. 把 floor 后遗漏的余数按随机顺序补回，保证最终总和严格等于 totalCount。
 *
 * 这里刻意不设置每类最小值，因此某些套房类型可以被分到 0。
 *
 * @param totalCount 当前 level/sector 的套房总容量
 * @param suiteKeys 当前 level/sector 中存在的套房类型 key
 * @returns 每个套房类型对应的最终套数
 */
function distributeApartmentSuiteCounts(
  totalCount: number,
  suiteKeys: string[],
): Record<string, number> {
  if (totalCount <= 0 || suiteKeys.length === 0) return {};
  if (suiteKeys.length === 1) return { [suiteKeys[0]]: totalCount };

  // Math.random() 理论上可能为 0；用极小值避免 totalWeight 被 0 除。
  const weights = suiteKeys.map((suiteKey) => ({
    suiteKey,
    weight: Math.random() || Number.EPSILON,
  }));
  const totalWeight = weights.reduce((sum, item) => sum + item.weight, 0);
  // 先按权重比例分配整数部分，此时总和可能小于 totalCount。
  const result = Object.fromEntries(
    weights.map(({ suiteKey, weight }) => [suiteKey, Math.floor(totalCount * weight / totalWeight)]),
  );
  let assignedCount = Object.values(result).reduce((sum, count) => sum + count, 0);
  // floor 剩下的余数按随机顺序补，避免固定偏向第一个 suite key。
  const remainderOrder = [...suiteKeys].sort(() => Math.random() - 0.5);

  for (let i = 0; assignedCount < totalCount; i += 1) {
    const suiteKey = remainderOrder[i % remainderOrder.length];
    result[suiteKey] += 1;
    assignedCount += 1;
  }

  return result;
}

/**
 * 统计公寓公共/设备/通道等普通房间数量，用于估算一楼非套房空间占用。
 *
 * @param rooms 当前 sector 的房间表
 * @returns 非套房房间的 count 总和
 */
function countApartmentOrdinaryRooms(
  rooms: Record<string, RoomSchema | SuiteSchema>,
): number {
  return Object.entries(rooms).reduce((count, [roomKey, room]) => {
    if (isApartmentSuiteRoomKey(roomKey)) return count;
    return count + room.count;
  }, 0);
}

/**
 * 判断某个 room key 是否是公寓套房类型。
 * @param roomKey 房间或套房 key
 * @returns 是否属于 RESIDENTIAL_SUITE_TEMPLATES 中登记的套房类型
 */
function isApartmentSuiteRoomKey(roomKey: string): boolean {
  return RESIDENTIAL_SUITE_KEYS.includes(roomKey);
}

/**
 * 根据卧室数量上限，分配卧室预算给卧室、儿童卧室、办公室
 * @param candidate
 * @param rooms
 * @returns
 */
function applyHouseSharedRoomCounts(
  candidate: BuildingCandidate,
  rooms: Record<string, RoomSchema>,
): void {
  if (!rooms.bedroom) return;

  const limit = determineSharedBedroomLimit(candidate);
  const hasKidsBedroom = Boolean(rooms.kids_bedroom);
  const hasOffice = Boolean(rooms.office);

  const desiredKidsBedroomCount = hasKidsBedroom ? pickRandom([1, 2]) : 0;
  let remaining = Math.max(0, limit - 1);
  let kidsBedroomCount = Math.min(desiredKidsBedroomCount, remaining);
  remaining -= kidsBedroomCount;
  let officeCount = hasOffice && remaining > 0 ? 1 : 0;
  remaining -= officeCount;
  const bedroomCount = 1 + remaining;

  rooms.bedroom.count = bedroomCount;
  if (rooms.kids_bedroom) {
    if (kidsBedroomCount <= 0) {
      delete rooms.kids_bedroom;
    } else {
      rooms.kids_bedroom.count = kidsBedroomCount;
    }
  }
  if (rooms.office) {
    if (officeCount <= 0) {
      delete rooms.office;
    } else {
      rooms.office.count = officeCount;
    }
  }
}

/**
 * TODO 楼梯间有时会被替换为“带楼梯的走廊”，但必须整个 House 统一
 * @param candidate
 * @param levelKey
 * @param rooms
 */
function applyHouseAccessRooms(
  candidate: BuildingCandidate,
  levelKey: string,
  rooms: Record<string, RoomSchema>,
): void {
  const buildingLevels = normalizeBuildingLevels(candidate.buildingLevels);
  const isSmallSingleLevel = (candidate.areaSqm === null || candidate.areaSqm <= SMALL_HOUSE_AREA_MAX_SQM) && buildingLevels == 1;
  const isGroundLevel = levelKey === "ground_floor";
  const isTopLevel = levelKey === "top_floor";

  if (isGroundLevel && isSmallSingleLevel && rooms.living_room) {
    rooms.living_room.access = "entrance";
  } else if (isGroundLevel) {
    rooms.hall = {
      descrption: "门厅",
      count: 1,
      access: "entrance",
    };
  }

  if (((buildingLevels == 1 && isGroundLevel) || isTopLevel) && rooms.bedroom) {
    rooms.bedroom.access = "vertical"
  }
  if (levelKey === ATTIC_FLOOR && rooms.hvac) rooms.hvac.access = "vertical"

  if (buildingLevels > 1) {
    rooms.stairwell = {
      descrption: "带楼梯的走廊",
      count: 1,
      access: "vertical",
    };
  }
}

/**
 * 为公寓补齐入口大厅和垂直交通。
 * @param levelKey
 * @param rooms
 */
function applyApartmentAccessRooms(
  candidate: BuildingCandidate,
  levelKey: string,
  rooms: Record<string, RoomSchema | SuiteSchema>,
): void {
  if (levelKey === APARTMENT_FLOORS[0]) {
    rooms.lobby = {
      descrption: "公寓大厅",
      count: 1,
      access: "entrance",
    };
  }

  if (levelKey === APARTMENT_FLOORS[1]) {
    rooms.hall = {
      descrption: "走廊",
      count: 1,
    };
  }

  rooms.stairwell = {
    descrption: "楼梯间",
    count: 1,
    access: "vertical",
  };
  rooms.elevator = {
    descrption: "电梯",
    count: 1,
    access: "vertical",
  };
}

function normalizeBuildingLevels(buildingLevels: number | null): number {
  return Math.max(1, buildingLevels ?? 1);
}

function rangeNumbers(start: number, endInclusive: number): number[] {
  const result: number[] = []
  for (let i = start; i <= endInclusive; i++) {
    result.push(i);
  }
  return result;
}

import { loadServiceSql } from "@/db/sqlLoader.js";
import { AnyCategoryKey, BuildingCandidate, BuildingSchema, CategoryDefinition, CategoryLevelSchema, CategorySchema, FeatureIdRoomDefinition, fetchBuildingCoveringAreas, fetchBuildingRoadKinds, parseBuildingFeatureId, PatternDistribution, PatternRoomDefinition, pickRandom, RoomSchema, weightedBoolean } from "./buildingClassifier.js";
import { query } from "@/db/client.js";
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

//#region 常量

const TOP_LEVEL = ["top_level", "second_to_top_level", "third_to_top_level"];
const GROUND_LEVEL = ["ground_level", "second_level", "third_level"];
const ALL_LEVELS = ["all_levels"];

/**
 * 兼作分类结果（单独把 key 提取出来）和 Pattern 记录
 * 此表内容仅表示种类，不表示数量或与面积的关联
 * - prefered：代表该功能应优先出现的楼层
 */
export const RESIDENTIAL_CATEGORIES: Record<string, CategoryDefinition> = {
  house: {desc: "住宅",
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
  tool_shed: {desc: "工具屋", base_schema: {rooms: {self: true}}},
} as const;
export const RESIDENTIAL_CATEGORY_KEYS = Object.keys(RESIDENTIAL_CATEGORIES)
export const RESIDENTIAL_PATTERN_KEYS = Object.entries(RESIDENTIAL_CATEGORIES)
  .flatMap(([key, cat]) => {
    if ('base_schema' in cat && cat.base_schema && 'self' in cat.base_schema) return key // 简单类型返回 Category Key 本身作为 Pattern Key
    if ('patterns' in cat && cat.patterns) return Object.keys(cat.patterns)
  }).filter(k => k !== undefined)

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


//#####################
//#region Category 逻辑
//#####################


/**
 * 在没有 explicit building tag 的情况下，
 * 结合覆盖区域、周边道路和已有 schema 判断当前建筑是否位于独栋住宅区。
 * @param candidate
 * @param existingSchemas
 * @returns 已分类好的 Category，或者表示不位于独栋住宅区的的 null
 */
export async function ambiguousResidentialCategory(
  candidate: BuildingCandidate,
  existingSchemas: Record<string, BuildingSchema>,
): Promise<string[]> {
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
    return [];
  }

  const [buildingKind, hasNearbyParking] = await Promise.all([
    determineResidentialBuildingKind(candidate.detail.featureId),
    determineNearbyParkingSignal(candidate.detail.featureId),
  ]);
  const nearbySchemas = Object.values(existingSchemas).filter((schema) => {
    return distanceToPosition(schema.centerPosition, candidate.centerPosition) <= RESIDENTIAL_ACCESSORY_CONTEXT_RADIUS_METERS;
  });

  if (buildingKind === "house") { // 如果是住宅则根据是否有外置停车地点来判断本体需不需要车库
    const hasNearbyGarage = nearbySchemas.some((schema) => schema.category === "garage");
    if (hasNearbyParking || hasNearbyGarage) {
      return ["house"];
    }

    return weightedBoolean(9, 1)
      ? ["house","garage"]
      : ["house"];
  }

  const hasNearbyHouseGarage = nearbySchemas.some((schema) => schema.category === "house&garage");
  if (hasNearbyHouseGarage) { // 如果是附属建筑，首先根据是否有内置车库来判断，已有内置车库就不需要车库了
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

const fetchHouseDetermingFactorSqlPromise = loadServiceSql("gameSystem/sql/fetchHouseDetermingFactor.sql");
const fetchNearbyParkingSignalSqlPromise = loadServiceSql("gameSystem/sql/fetchNearbyParkingSignal.sql");

/**
 * 判断一个建筑是“独栋住宅”或“独立附属建筑（独立车库/工具屋）”。
 *
 * 输入前提：
 * - 默认调用方已经确认候选属于住宅区
 *
 * 保守策略：
 * - 当目标建筑邻域样本不足或关键几何证据不足时，一律按住宅处理
 *
 * @param featureId 已缩小到“独栋住宅/独立附属建筑”范围内的建筑候选
 * @returns 是否应按独栋住宅处理
 */
async function determineResidentialBuildingKind(featureId: string): Promise<string> {
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
  // 简单建筑直接返回 Category Key 作为 Pattern Key
  if (RESIDENTIAL_PATTERN_KEYS.includes(categoryKey)) return categoryKey

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


//#####################
//#region C-Schema 逻辑
//#####################

/**
 * TODO 默认仅 1 个地物，楼层数会控制为 1 到 3
 * 从已应用 Pattern Distribution 的 Base Schema 中获取某住宅有哪些功能、有何种偏好，
 * 然后从 Candidate 中获取此住宅的楼层，最后根据偏好的楼层把功能安插到楼层中去。
 * （不涉及房间数量、出入口与通道、套房细节）
 * @param appliedBaseSchema 仅 1 个地物
 * @param candidate
 */
export function buildHouseCategorySchemaFromDistribution(
  appliedBaseSchema: FeatureIdRoomDefinition,
  candidate: BuildingCandidate,
): CategorySchema {
  const [PatternRoomDefinitions] = Object.values(appliedBaseSchema)
  // 控制楼层数在 1 ~ 3 范围
  const buildingLevels = candidate.buildingLevels ? Math.min(3, candidate.buildingLevels) : 1 // 此处默认1层是合理的，因为 Pattern 本身就是被面积与楼层决定的，不会出现不够用的情况
  const levelEntries: (string|CategoryLevelSchema)[][] = []
  for (let i = 1; i <= buildingLevels; i++) {
    const levelKey = i === 1 ? "ground_level" : i === buildingLevels ? "top_level" : "middle_level"
    levelEntries.push([levelKey, {
      theme: "普通的住宅楼层",
      span: [i],
      rooms: {}, // 等待后续装填
    }])
  }
  // 初步装填功能
  PatternRoomDefinitions.forEach( def => {
    if (def.prefered && def.prefered === TOP_LEVEL[0]) {
      const rooms = levelEntries[buildingLevels-1][1] as CategoryLevelSchema

    }
  })
  return {
    theme: "普通的住宅",
    levels: Object.fromEntries(levelEntries)
  }
}


//################
//#region 收尾逻辑
//################


/**
 * 把 residential C-Schema 和占位 Sector Distribution 转为最终 Building Schema levels。
 *
 * @param candidate 已标准化的建筑候选
 * @param categorySchema 已合成的 C-Schema
 * @param sectorDistribution 当前楼层到 sector 的占位分配
 * @returns Building Schema 的 levels 字段
 */
function buildResidentialLevelsFromCategorySchema(
  candidate: BuildingCandidate,
  categorySchema: CategorySchema,
  sectorDistribution: ResidentialSectorDistribution,
): BuildingSchema["levels"] {
  return Object.fromEntries(
    Object.entries(categorySchema.levels).map(([levelKey, levelSchema]) => {
      const sectorKeys = sectorDistribution[levelKey] || ["main"];
      return [levelKey, {
        theme: levelSchema.theme,
        span: levelSchema.span,
        sectors: Object.fromEntries(
          sectorKeys.map((sectorKey) => [sectorKey, {
            area: candidate.areaSqm ?? 0,
            centerPosition: candidate.centerPosition,
            rooms: levelSchema.rooms,
          }]),
        ),
      }];
    }),
  );
}


//#region 帮助函数

function isHouseFamilyCategory(category: string): boolean {
  return category === "house" || category === "house&garage";
}

function applyHouseSharedRoomCounts(
  candidate: BuildingCandidate,
  rooms: Record<string, ResidentialResolvedRoom>,
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

function applyHouseAccessRooms(
  candidate: BuildingCandidate,
  rooms: Record<string, ResidentialResolvedRoom>,
): void {
  const buildingLevels = normalizeBuildingLevels(candidate.buildingLevels);
  const isSmallSingleLevel = (candidate.areaSqm === null || candidate.areaSqm <= SMALL_HOUSE_AREA_MAX_SQM) && buildingLevels <= 1;

  if (isSmallSingleLevel && rooms.living_room) {
    rooms.living_room.access = "entrance";
  } else {
    rooms.hall = {
      desc: "门厅",
      prefered: GROUND_LEVEL[0],
      count: 1,
      access: "entrance",
    };
  }

  if (buildingLevels > 1) {
    rooms.stairwell = {
      desc: "楼梯间",
      prefered: ALL_LEVELS[0],
      count: 1,
      access: "vertical",
    };
  }
}

function buildCategorySchemaFromResidentialRooms(
  candidate: BuildingCandidate,
  rooms: Record<string, ResidentialResolvedRoom>,
): CategorySchema {
  const categorySchema: CategorySchema = {
    theme: "default",
    levels: {},
  };
  const levelOptions = buildResidentialLevelOptions(candidate);

  for (const [roomKey, room] of Object.entries(rooms)) {
    const targetLevelKeys = resolveResidentialTargetLevelKeys(room.prefered, levelOptions);
    for (const levelKey of targetLevelKeys) {
      const levelOption = levelOptions[levelKey];
      if (!levelOption) continue;

      categorySchema.levels[levelKey] ??= {
        theme: "default",
        span: levelOption.span,
        rooms: {},
      };
      categorySchema.levels[levelKey].rooms[roomKey] = toCategoryRoomSchema(room);
    }
  }

  return categorySchema;
}

function toCategoryRoomSchema(room: ResidentialResolvedRoom): RoomSchema {
  return {
    descrption: room.desc,
    count: room.count,
    ...(room.access ? { access: room.access } : {}),
  };
}

function buildResidentialLevelOptions(candidate: BuildingCandidate): Record<string, { span: number[] }> {
  const buildingLevels = normalizeBuildingLevels(candidate.buildingLevels);
  const options: Record<string, { span: number[] }> = {
    ground_level: { span: [1] },
    all_levels: { span: buildFloorSpan(buildingLevels) },
  };

  if (buildingLevels > 1) {
    options.top_level = { span: [buildingLevels] };
    options.second_level = { span: [2] };
  }
  if (buildingLevels > 2) {
    options.second_to_top_level = { span: [buildingLevels - 1] };
  }
  if (buildingLevels > 3) {
    options.third_level = { span: [3] };
    options.third_to_top_level = { span: [buildingLevels - 2] };
  }

  return options;
}

function resolveResidentialTargetLevelKeys(
  prefered: string | undefined,
  levelOptions: Record<string, { span: number[] }>,
): string[] {
  const levelKeys = Object.keys(levelOptions);
  const concreteLevelKeys = levelKeys.filter((levelKey) => levelKey !== ALL_LEVELS[0]);
  if (prefered === ALL_LEVELS[0]) {
    return ["all_levels"];
  }
  if (!prefered) {
    return [pickRandom(concreteLevelKeys.length > 0 ? concreteLevelKeys : levelKeys)];
  }
  if (prefered in levelOptions) {
    return [prefered];
  }
  if (TOP_LEVEL.includes(prefered)) {
    return [levelOptions.top_level ? "top_level" : "ground_level"];
  }
  if (GROUND_LEVEL.includes(prefered)) {
    return [levelOptions.ground_level ? "ground_level" : pickRandom(levelKeys)];
  }

  return [pickRandom(concreteLevelKeys.length > 0 ? concreteLevelKeys : levelKeys)];
}

function normalizeBuildingLevels(buildingLevels: number | null): number {
  return Math.max(1, buildingLevels ?? 1);
}

function buildFloorSpan(buildingLevels: number): number[] {
  return Array.from({ length: buildingLevels }, (_, index) => index + 1);
}




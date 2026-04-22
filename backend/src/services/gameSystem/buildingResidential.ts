import { loadServiceSql } from "@/db/sqlLoader.js";
import { BuildingCandidate, BuildingSchema, CategoryDefinition, CategoryLevelSchema, CategoryRoomSchema, CategorySchema, fetchBuildingCoveringAreas, fetchBuildingRoadKinds, parseBuildingFeatureId, PatternDistribution, PatternRoomDefinition, pickRandom, RoomSchema, SectorDistributionSchem, weightedBoolean } from "./buildingClassifier.js";
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

//#region 常量

const TOP_LEVEL = ["top_level", "second_to_top_level", "third_to_top_level"];
const GROUND_LEVEL = ["ground_level", "second_level", "third_level"];
const ALL_LEVELS = ["all_levels"];

/**
 * House 仅可出现的三种楼层
 */
const HOUSE_LEVELS = ["ground_floor", "middle_floor", "top_floor"]
const ACCESSORY_DEFAULT_LEVEL = "default_floor";

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
  tool_shed: {desc: "工具屋", base_schema: {rooms: {self: {prefered: GROUND_LEVEL[0]}}}},
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

const SMALL_HOUSE_AREA_MAX_SQM = 90;
const MEDIUM_HOUSE_AREA_MAX_SQM = 220;
const RESIDENTIAL_THEME_MUTATION_CHANCE = 0.05;

const RESIDENTIAL_DEFAULT_CATEGORY_THEMES: Record<string, string> = {
  house: "普通的住宅",
  garage: "普通的车库",
  tool_shed: "普通的工具屋",
};

const RESIDENTIAL_CATEGORY_EVENT_THEMES: Record<string, string[]> = {
  house: [],
  garage: [],
  tool_shed: [],
};

const RESIDENTIAL_LEVEL_EVENT_THEMES: Record<string, Record<string, string[]>> = {
  house: {
    ground_floor: [],
    middle_floor: [],
    top_floor: [],
  },
  garage: {default_floor: []},
  tool_shed: {default_floor: []},
};
const RESIDENTIAL_FALLBACK_THEME = "普通的建筑";


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
    // 只是查询周边状况，精度不用很高，整个 details list 随便选一个就能代表全体周边状况
    determineResidentialBuildingKind(candidate.details[0].featureId),
    determineNearbyParkingSignal(candidate.details[0].featureId),
  ]);
  const nearbySchemas = existingSchemas.filter((schema) => {
    return distanceToPosition(schema.centerPosition, candidate.centerPosition) <= RESIDENTIAL_ACCESSORY_CONTEXT_RADIUS_METERS;
  });

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
  // console.log(RESIDENTIAL_PATTERN_KEYS);
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
  const mainCategory = candidate.categoryRecord[0]
  // Category 的默认主题
  const baseTheme = pickResidentialCategoryTheme(mainCategory);
  const schemaTheme = pickResidentialCategoryEventTheme(mainCategory) ?? baseTheme;
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
        theme: pickResidentialLevelEventTheme(mainCategory, levelKey) ?? schemaTheme,
        span: [i], // span 固定只有1层的范围
        rooms: {}, // 等待后续装填
      }
    }

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
      theme: schemaTheme,
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
  const mainCategory = candidate.categoryRecord[0]
  const baseTheme = pickResidentialCategoryTheme(mainCategory);
  const schemaTheme = pickResidentialCategoryEventTheme(mainCategory) ?? baseTheme;

  const result: Record<FeatureId, CategorySchema> = {}
  Object.entries(appliedBaseSchema).forEach(([featureId, roomDefs]) => {
    const level: CategoryLevelSchema = {
      theme: pickResidentialLevelEventTheme(mainCategory, ACCESSORY_DEFAULT_LEVEL) ?? schemaTheme,
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
      theme: schemaTheme,
      levels: {
        [ACCESSORY_DEFAULT_LEVEL]: level,
      },
    }
  });

  return result
}

function pickResidentialCategoryTheme(mainCategory: string): string {
  return RESIDENTIAL_DEFAULT_CATEGORY_THEMES[mainCategory];
}

function pickResidentialCategoryEventTheme(mainCategory: string): string | null {
  return pickResidentialEventTheme(RESIDENTIAL_CATEGORY_EVENT_THEMES[mainCategory]);
}

function pickResidentialLevelEventTheme(mainCategory: string, levelKey: string): string | null {
  return pickResidentialEventTheme(RESIDENTIAL_LEVEL_EVENT_THEMES[mainCategory]?.[levelKey]);
}

function pickResidentialEventTheme(
  eventThemes: string[] | undefined,
): string | null {
  if (Math.random() >= RESIDENTIAL_THEME_MUTATION_CHANCE) {
    return null;
  }

  if (!eventThemes || eventThemes.length === 0) {
    return null;
  }

  return pickRandom(eventThemes);
}

function resolveHouseConcreteLevelKey(levelNumber: number, buildingLevels: number): string {
  if (buildingLevels === 1) return HOUSE_LEVELS[0];
  if (levelNumber === 1) return HOUSE_LEVELS[0];
  if (levelNumber === buildingLevels) return HOUSE_LEVELS[2];
  return HOUSE_LEVELS[1];
}

/**
 * 通过各种条件，选出 House 当中最适合填入某个建筑的楼层 key。
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
  if (prefered === ALL_LEVELS[0]) {
    return concreteLevelKeys;
  }

  if (prefered && TOP_LEVEL.includes(prefered)) {
    return [concreteLevelKeys[concreteLevelKeys.length - 1]];
  }

  if (prefered && GROUND_LEVEL.includes(prefered)) {
    return [concreteLevelKeys[0]];
  }

  if (prefered && levels[prefered]) {
    return [prefered];
  }

  return [pickRandom(concreteLevelKeys)];
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
          theme: level.theme,
          span: level.span,
          sectors,
        }];
      }),
    );

    result[featureId] = {
      featureId,
      category: categoryKey, // 输出到 Building Schema 后，因为不再用到 category 了，就直接组合为单一字符串了
      centerPosition: candidate.centerPosition,
      theme: schema.theme || RESIDENTIAL_FALLBACK_THEME,
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
          theme: level.theme,
          span: level.span,
          sectors,
        }];
      }),
    );

    result[featureId] = {
      featureId,
      category: categoryKey,
      centerPosition: candidate.centerPosition,
      theme: schema.theme || RESIDENTIAL_FALLBACK_THEME,
      levels,
    };
  })
  return result
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

function applyHouseAccessRooms(
  candidate: BuildingCandidate,
  levelKey: string,
  rooms: Record<string, RoomSchema>,
): void {
  const buildingLevels = normalizeBuildingLevels(candidate.buildingLevels);
  const isSmallSingleLevel = (candidate.areaSqm === null || candidate.areaSqm <= SMALL_HOUSE_AREA_MAX_SQM) && buildingLevels <= 1;
  const isGroundLevel = levelKey === "ground_floor";

  if (isGroundLevel && isSmallSingleLevel && rooms.living_room) {
    rooms.living_room.access = "entrance";
  } else if (isGroundLevel) {
    rooms.hall = {
      descrption: "门厅",
      count: 1,
      access: "entrance",
    };
  }

  if (buildingLevels > 1) {
    rooms.stairwell = {
      descrption: "楼梯间",
      count: 1,
      access: "vertical",
    };
  }
}

function normalizeBuildingLevels(buildingLevels: number | null): number {
  return Math.max(1, buildingLevels ?? 1);
}

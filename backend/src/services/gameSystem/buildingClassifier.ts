import { query } from "@/db/client.js";
import { loadServiceSql } from "@/db/sqlLoader.js";
import { FeatureDetail } from "@/services/featureDetail.js";
import { ContainedPoiReference, dedupeOutlineReferences, OutlineReference, RelationReference } from "@/services/osmNormalization/osmNormalizer.js";
import { distanceToPosition } from "@/services/geometry.js";
import { Position } from "./gameSessionStore.js";

/**
 * 与 SQL 查询结果表一致的扁平类型
 */
interface DbStandaloneResidentialBuildingRow {
  area_sqm: number | string | null;
  neighbor_sample_count: number | string | null;
  neighbor_average_area_sqm: number | string | null;
  is_simple_rectangle: boolean | null;
}

interface DbBuildingDetailRow {
  feature_id: string;
  osm_type: string;
  osm_id: number;
  geometry_type: string;
  tags: Record<string, string>;
  relations: RelationReference[];
  outline_references: OutlineReference[];
  meta: Record<string, string | number>;
  tainted: boolean;
  contained_pois: ContainedPoiReference[];
  area_sqm: number | string | null;
  center_lon: number | string;
  center_lat: number | string;
}

interface DbRoadKindsRow {
  road_kinds: string[] | null;
}

interface DbCoveringAreasRow {
  covering_areas: string[] | null;
}

export interface BuildingSchema {
  featureId: string;
  category: string;
  centerPosition: Position;
  theme: string;
  levels: Record<string, LevelSchema>; // key 为楼层种类名
}

interface LevelSchema {
  theme: string;
  span: number[]; // 使用该 Schema 的楼层
  sectors: Record<string, SectorSchema>; // key 为该 Sector 的名字
}

interface SectorSchema {
  area: number;
  centerPosition: Position;
  rooms: Record<string, RoomSchema | SuiteSchema>; // key 为该房间/套房的种类名
}

interface RoomSchema {
  descrption: string;
  count: number;
  access?: "entrance" | "vertical" | "internal";
}

/**
 * 特意无 access
 */
interface SuiteSchema {
  theme: string;
  subRooms: SubRoomSchema[];
}

/**
 * 特意无 access
 */
interface SubRoomSchema {
  descrption: string;
  count: number;
}

type ResidentialCategoryKey = keyof typeof RESIDENTIAL_CATEGORIES;
/**
 * 单体建筑还是复合建筑
 */
type ScopeType = "single" | "building_relation";

/**
 * 根据 featureId 获取的候选地物，包含所有分类所需的信息
 */
interface BuildingCandidate {
  scope: ScopeType;
  detail: FeatureDetail;
  memberDetails?: FeatureDetail[];
  areaSqm: number | null;
  centerPosition: Position;
  buildingLevels: number | null;
  heightMeters: number | null;
  buildingValue: string | null;
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

const STANDALONE_BUILDING_NEIGHBOR_RADIUS_METERS = 60;
const STANDALONE_BUILDING_MAX_ACCESSORY_AREA_SQM = 45;
const STANDALONE_BUILDING_RELATIVE_AREA_THRESHOLD = 0.7;
const STANDALONE_BUILDING_MIN_NEIGHBOR_SAMPLE_COUNT = 1;

const SMALL_HOUSE_AREA_MAX_SQM = 90;
const MEDIUM_HOUSE_AREA_MAX_SQM = 220;
const EXPLICIT_HOUSE_BUILDING_VALUES = new Set(["house", "detached", "residential"]);
const EXPLICIT_GARAGE_BUILDING_VALUES = new Set(["garage", "garages", "carport"]);
const EXPLICIT_TOOL_SHED_BUILDING_VALUES = new Set(["shed"]);

// 住宅区判定参数
const RESIDENTIAL_DISTRICT_SCHEMA_RADIUS_METERS = 120;
const RESIDENTIAL_DISTRICT_ROAD_RADIUS_METERS = 90;
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

//#region 出口函数

/**
 * 输入 featureId, 自行从数据库获取相关数据后进行分类等操作，返回现成的 Building Schema
 * TODO: 添加最终 Building Schema 的组装逻辑。目前只做到 category/pattern 选择。
 * @param featureId 支持传入单体 building 或 relation/part
 * @param existingSchemas 作为参考的来自 Game State 的 Building Schema
 * @param skipComplex 是否跳过太复杂需要 LLM 参与的步骤
 * @returns 现成的 Building Schema，或者表示被跳过的 undefined
 */
export async function generateBuildingSchema(
  featureId: string,
  existingSchemas: Record<string, BuildingSchema>,
  skipComplex: boolean = true
): Promise<BuildingSchema | undefined> {
  // 先找到候选建筑
  const candidate = await fetchBuildingCandidate(featureId);
  if (!candidate) {
    return undefined;
  }

  // 看看能不能直接分类出来
  const explicitCategory = resolveExplicitCategory(candidate);
  if (explicitCategory) {
    return buildBuildingSchema(
      candidate.detail.featureId,
      explicitCategory,
      candidate.centerPosition,
      selectPatternKey(candidate, explicitCategory),
    );
  }

  // 不能直接分出来就进入模糊分类模式
  const ambiguousCategory = await resolveAmbiguousCategory(candidate, existingSchemas)
  if (ambiguousCategory) {
    return buildBuildingSchema(
      candidate.detail.featureId,
      ambiguousCategory,
      candidate.centerPosition,
      selectPatternKey(candidate, ambiguousCategory),
    );
  }

  if (skipComplex) {
    return undefined;
  }

  console.log('TODO: LLM 分支');
  return undefined; // TODO 进入 LLM 分支
}

//#region 主逻辑函数

const classifyStandaloneResidentialBuildingSqlPromise = loadServiceSql("gameSystem/sql/classifyStandaloneResidentialBuilding.sql");
const fetchBuildingFeatureDetailByIdSqlPromise = loadServiceSql("gameSystem/sql/fetchBuildingFeatureDetailById.sql");
const fetchBuildingRelationMemberDetailsSqlPromise = loadServiceSql("gameSystem/sql/fetchBuildingRelationMemberDetails.sql");
const fetchBuildingRoadKindsSqlPromise = loadServiceSql("gameSystem/sql/fetchBuildingRoadKinds.sql");
const fetchBuildingCoveringAreasSqlPromise = loadServiceSql("gameSystem/sql/fetchBuildingCoveringAreas.sql");

/**
 * 把任意传入的 building feature id 填充为后续分类所用的“有效候选”。
 *
 * 若传入的是 building relation 的一部分，则自动提升到 relation 级建筑，
 * 并把各个 member 建筑一并取回，供后续补足 tags / contained POI / 层数推断。
 *
 * @param featureId 原始输入的 building feature id
 * @returns 可供分类的候选；若数据库中查不到对应建筑则返回 null
 */
async function fetchBuildingCandidate(featureId: string): Promise<BuildingCandidate | null> {
  const feature = await fetchBuildingFeatureDetailById(featureId);
  if (!feature) {
    return null;
  }

  const relationReference = feature.detail.relationReferences?.find((relation) => {
    return relation.reltags.type === "building";
  });

  // 只有多体建筑的子建筑需要自动提升到 relation；直接传 relation 本体则维持原样。
  const shouldPromoteToRelation = feature.detail.osmType === "way" && relationReference;
  if (!shouldPromoteToRelation) {
    return toResolvedCandidate("single", feature.detail, undefined, feature.areaSqm, feature.centerPosition);
  }

  const relationFeatureId = `relation/${relationReference.rel}`;
  const relationSnapshot = await fetchBuildingFeatureDetailById(relationFeatureId);
  const relationMemberSnapshots = await fetchBuildingRelationMemberSnapshots(relationReference.rel);

  if (!relationSnapshot && relationMemberSnapshots.length === 0) {
    return toResolvedCandidate("single", feature.detail, undefined, feature.areaSqm, feature.centerPosition);
  }

  // 寻找 relation 并获取其信息的分支
  const memberDetails = relationMemberSnapshots.map((snapshot) => snapshot.detail);
  const relationDetail = relationSnapshot?.detail ?? synthesizeRelationDetail(relationFeatureId, memberDetails);
  const relationAreaSqm = relationSnapshot?.areaSqm ?? sumAreas(relationMemberSnapshots.map((snapshot) => snapshot.areaSqm));
  const relationCenterPosition = relationSnapshot?.centerPosition ?? computeMeanCenterPosition(
    relationMemberSnapshots.map((snapshot) => snapshot.centerPosition),
  );

  return toResolvedCandidate(
    "building_relation",
    relationDetail,
    memberDetails,
    relationAreaSqm,
    relationCenterPosition || feature.centerPosition,
  );
}

/**
 * 用强定向 tags / contained POI 直接判定当前候选是否属于已支持的简单类别。
 *
 * 当前顺序刻意偏保守：// TODO 当前只支持住宅
 * - 先看是否有明确 garage / shed 信号；
 * - 再看是否是住宅；
 * - 对住宅候选继续调用“独栋住宅 vs 独立附属建筑”专门规则做二次收窄。
 *
 * @param candidate 已标准化的建筑候选
 * @param existingSchemas 作为参考的来自 Game State 的 Building Schema
 * @returns 已支持的 category；若当前阶段仍无法稳定判断则返回 null
 */
function resolveExplicitCategory(candidate: BuildingCandidate): ResidentialCategoryKey | null {
  if (isExplicitGarage(candidate.detail.tags) || hasContainedPoiTag(candidate, "amenity", ["parking"])) {
    return "garage";
  }

  if (isExplicitToolShed(candidate.detail.tags)) {
    return "tool_shed";
  }

  if (isExplicitHouse(candidate.detail.tags)) {
    return "house";
  }

  return null
}

/**
 * TODO 目前暂只支持住宅区
 * @param candidate
 * @param existingSchemas
 * @returns
 */
async function resolveAmbiguousCategory(
  candidate: BuildingCandidate,
  existingSchemas: Record<string, BuildingSchema>
): Promise<ResidentialCategoryKey | null> {
  return ambiguousResidentialCategory(candidate, existingSchemas);
}

/**
 * TODO 目前暂只支持住宅区
 * @param candidate
 * @param categoryKey
 * @returns
 */
function selectPatternKey(
  candidate: BuildingCandidate,
  categoryKey: ResidentialCategoryKey, // TODO 当前只支持住宅
): string {
  return selectResidentialPatternKey(candidate, categoryKey)
}

//#region 分区：住宅区

/**
 * 根据已经确定的 category 选出 pattern。
 *
 * 简单附属建筑不单独扩 pattern 表，而是直接把 category 名作为唯一 pattern。
 *
 * @param candidate 已标准化的建筑候选
 * @param categoryKey 已确定的 category
 * @returns category 对应的 pattern key
 */
function selectResidentialPatternKey(
  candidate: BuildingCandidate,
  categoryKey: ResidentialCategoryKey, // TODO 当前只支持住宅
): string {
  // 简单建筑直接返回 Category Key 作为 Pattern Key
  const simpleCategoryKeys = Object.entries(RESIDENTIAL_CATEGORIES)
    .filter(([key, cat]) => 'base_schema' in cat && cat.base_schema && 'self' in cat.base_schema)
    .map(([key, cat]) => key)
  if (simpleCategoryKeys.includes(categoryKey)) return categoryKey

  // 复杂建筑可以保证只剩 house 了
  const patternPool = determineHousePatternPool(candidate); // TODO 当前只支持住宅
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
 * 在没有 explicit building tag 的情况下，
 * 结合覆盖区域、周边道路和已有 schema 判断当前建筑是否位于独栋住宅区。
 */
async function ambiguousResidentialCategory(
  candidate: BuildingCandidate,
  existingSchemas: Record<string, BuildingSchema>,
): Promise<ResidentialCategoryKey | null> {
  const [coveringAreas, roadKinds] = await Promise.all([
    fetchBuildingCoveringAreas(candidate.detail.featureId),
    fetchBuildingRoadKinds(candidate.detail.featureId),
  ]);
  // console.log('coveringAreas: ',coveringAreas);
  // console.log('roadKinds;: ',roadKinds);

  const weights = computeResidentialDistrictWeights(candidate, existingSchemas, coveringAreas, roadKinds);
  // console.log('weights: ',weights);
  const isResidentialDistrict = weightedBoolean(weights.residential, weights.nonResidential);
  // console.log('isResidentialDistrict: ',isResidentialDistrict);
  if (!isResidentialDistrict) {
    console.log('随机判定不是住宅区建筑');
    return null;
  }

  const isStandaloneResidential = await isStandaloneResidentialBuilding(candidate.detail.featureId);
  return isStandaloneResidential ? "house" : "garage";
}

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
export async function isStandaloneResidentialBuilding(featureId: string): Promise<boolean> {
  // 获取数据库中的周遭建筑数据与建筑本身数据
  const featureRef = parseBuildingFeatureId(featureId);
  const sql = await classifyStandaloneResidentialBuildingSqlPromise;
  const result = await query<DbStandaloneResidentialBuildingRow>(
    sql,
    [featureRef.osmType, featureRef.osmId, STANDALONE_BUILDING_NEIGHBOR_RADIUS_METERS],
  );
  const row = result.rows[0];

  const areaSqm = toFiniteNumber(row?.area_sqm ?? null);
  // console.log(`${featureId}: 面积${areaSqm}`);
  const neighborSampleCount = toFiniteNumber(row?.neighbor_sample_count ?? null);
  // console.log(`周围建筑数${neighborSampleCount}`);
  const neighborAverageAreaSqm = toFiniteNumber(row?.neighbor_average_area_sqm ?? null);
  // console.log(`周围平均面积${neighborAverageAreaSqm}`);

  // 进行判断

  if ( // 没有其他建筑，按独栋住宅处理
    areaSqm === null
    || neighborSampleCount === null
    || neighborSampleCount < STANDALONE_BUILDING_MIN_NEIGHBOR_SAMPLE_COUNT
    || neighborAverageAreaSqm === null
  ) {
    return true;
  }

  if ( // 确实就是独立住宅
    row?.is_simple_rectangle !== true
    && areaSqm > STANDALONE_BUILDING_MAX_ACCESSORY_AREA_SQM
    && areaSqm >= neighborAverageAreaSqm * STANDALONE_BUILDING_RELATIVE_AREA_THRESHOLD
  ) {
    return true;
  }

  return false;
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
    return schema.category === "house"
      && distanceToPosition(schema.centerPosition, candidate.centerPosition) <= RESIDENTIAL_DISTRICT_SCHEMA_RADIUS_METERS;
  });
  residential += nearbyHouseSchemas.length * RESIDENTIAL_DISTRICT_SCHEMA_HOUSE_WEIGHT;

  return { residential, nonResidential };
}

//#region 共用逻辑函数

/**
 * 根据 featureId 取回单个 building 的细节与面积。
 *
 * 这里返回的 detail 直接复用 FeatureDetail 结构，
 * 让后续分类逻辑不必再关心底层 SQL 行结构。
 *
 * @param featureId 目标 building 的 feature id
 * @returns 细节快照；若数据库中不存在则返回 null
 */
async function fetchBuildingFeatureDetailById(
  featureId: string,
): Promise<{ detail: FeatureDetail; areaSqm: number | null; centerPosition: Position } | null> {
  const featureRef = parseBuildingFeatureId(featureId);
  const sql = await fetchBuildingFeatureDetailByIdSqlPromise;
  const result = await query<DbBuildingDetailRow>(sql, [featureRef.osmType, featureRef.osmId]);
  const row = result.rows[0];

  if (!row) {
    return null;
  }

  return {
    detail: mapBuildingDetailRowToFeatureDetail(row),
    areaSqm: toFiniteNumber(row.area_sqm),
    centerPosition: {
      lat: Number(row.center_lat),
      lon: Number(row.center_lon),
    },
  };
}

/**
 * 取回某个 building relation 下所有 part 成员建筑的细节。
 *
 * relation 本体的 tags 有时不足以支撑分类，因此这里会把 member 也拉上来，
 * 供后续做 tag 合并、层数推断、contained POI 补充等工作。
 *
 * @param relationOsmId building relation 的 osm id
 * @returns 每个成员建筑对应的 detail + 面积快照
 */
async function fetchBuildingRelationMemberSnapshots(
  relationOsmId: number,
): Promise<Array<{ detail: FeatureDetail; areaSqm: number | null; centerPosition: Position }>> {
  const sql = await fetchBuildingRelationMemberDetailsSqlPromise;
  const result = await query<DbBuildingDetailRow>(sql, [relationOsmId]);

  return result.rows.map((row) => ({
    detail: mapBuildingDetailRowToFeatureDetail(row),
    areaSqm: toFiniteNumber(row.area_sqm),
    centerPosition: {
      lat: Number(row.center_lat),
      lon: Number(row.center_lon),
    },
  }));
}

async function fetchBuildingRoadKinds(featureId: string): Promise<string[]> {
  const featureRef = parseBuildingFeatureId(featureId);
  const sql = await fetchBuildingRoadKindsSqlPromise;
  const result = await query<DbRoadKindsRow>(sql, [
    featureRef.osmType,
    featureRef.osmId,
    RESIDENTIAL_DISTRICT_ROAD_RADIUS_METERS,
  ]);

  return result.rows[0]?.road_kinds || [];
}

async function fetchBuildingCoveringAreas(featureId: string): Promise<string[]> {
  const featureRef = parseBuildingFeatureId(featureId);
  const sql = await fetchBuildingCoveringAreasSqlPromise;
  const result = await query<DbCoveringAreasRow>(sql, [featureRef.osmType, featureRef.osmId]);

  return result.rows[0]?.covering_areas || [];
}

/**
 * 把 DB 扁平行结构转换为代码内部统一使用的 FeatureDetail。
 *
 * @param row 查询返回的一行 building detail
 * @returns 对齐 FeatureDetail 字段命名后的结果
 */
function mapBuildingDetailRowToFeatureDetail(row: DbBuildingDetailRow): FeatureDetail {
  return {
    featureId: row.feature_id,
    osmType: row.osm_type,
    osmId: row.osm_id,
    category: "building",
    geometryType: row.geometry_type,
    tags: row.tags || {},
    meta: row.meta || {},
    tainted: row.tainted ?? false,
    relationReferences: row.relations || [],
    outlineReferences: row.outline_references || [],
    containedPoisReferences: row.contained_pois && row.contained_pois.length > 0 ? row.contained_pois : undefined,
  };
}

/**
 * 当 relation 本体自身无法直接查到完整细节时，
 * 使用其 member 建筑合成一个虚假的 relation 级 FeatureDetail。
 *
 * @param featureId relation 级 feature id
 * @param memberDetails 属于该 relation 的成员建筑细节
 * @returns 合成后的 relation 级 FeatureDetail（其实是假的，不存在于数据库中）
 */
function synthesizeRelationDetail(featureId: string, memberDetails: FeatureDetail[]): FeatureDetail {
  const parsed = parseBuildingFeatureId(featureId);
  // member 上的 tags 只做“主值缺失时补洞”，避免次级成员覆盖掉主成员上更明确的标签。
  const tags = memberDetails.reduce<Record<string, string>>(
    (mergedTags, memberDetail) => mergeStringRecord(mergedTags, memberDetail.tags),
    {},
  );
  const outlineReferences = dedupeOutlineReferences(
    memberDetails.flatMap((memberDetail) => memberDetail.outlineReferences || []),
  );
  const containedPoisReferences = memberDetails.flatMap((memberDetail) => memberDetail.containedPoisReferences || []);

  return {
    featureId,
    osmType: parsed.osmType,
    osmId: parsed.osmId,
    category: "building",
    geometryType: "MultiPolygon",
    tags,
    relationReferences: [],
    outlineReferences,
    containedPoisReferences: containedPoisReferences.length > 0 ? containedPoisReferences : undefined,
  };
}

/**
 * 把原始 detail 与衍生指标一起打包成分类阶段统一使用的候选结构。
 *
 * 衍生指标目前只包括面积、楼层数与高度，且优先使用主 detail，
 * 在缺失时再从 member 建筑中推断。
 *
 * @param scope 当前候选是单体建筑还是 relation 级建筑
 * @param detail 主体建筑 detail
 * @param memberDetails relation 级时的成员建筑细节
 * @param areaSqm 已解析出的面积
 * @returns 分类阶段统一使用的候选结构
 */
function toResolvedCandidate(
  scope: ScopeType,
  detail: FeatureDetail,
  memberDetails: FeatureDetail[] | undefined,
  areaSqm: number | null,
  centerPosition: Position,
): BuildingCandidate {
  const buildingLevels = parseBuildingLevels(detail.tags) ?? inferLevelsFromMembers(memberDetails);
  const heightMeters = parseHeightMeters(detail.tags.height) ?? inferHeightFromMembers(memberDetails);

  return {
    scope,
    detail,
    memberDetails,
    areaSqm,
    centerPosition,
    buildingLevels,
    heightMeters,
    buildingValue: trimTagValue(detail.tags.building),
  };
}

function buildBuildingSchema(
  featureId: string,
  category: string,
  centerPosition: Position,
  patternKey: string,
): BuildingSchema {
  void patternKey;
  return {
    featureId,
    category,
    centerPosition,
    theme: "default",
    levels: {},
  };
}


/**
 * 预留给下一阶段的 category/pattern -> Category Schema 应用入口。
 */
function applyPatternToCategorySchema(): void {
  // TODO: 下一阶段在这里把 category/pattern 应用到真正的 Category Schema。
}

//#endregion

//#region 帮助函数

/**
 * 解析内部统一使用的 `osmType/osmId` 形式 feature id。
 *
 * @param featureId 形如 `way/123` 或 `relation/456` 的 feature id
 * @returns 分离后的 osmType 与 osmId
 */
function parseBuildingFeatureId(featureId: string): { osmType: string; osmId: number } {
  const [osmType, osmIdText] = featureId.split("/");
  const osmId = Number.parseInt(osmIdText, 10);
  return { osmType, osmId };
}

/**
 * 把数据库里常见的 number/string/null 三态字段安全转换为 number。
 *
 * @param value 原始数据库字段
 * @returns 有限数值；若为空或非法则返回 null
 */
function toFiniteNumber(value: number | string | null): number | null {
  if (value === null || typeof value === "undefined") {
    return null;
  }

  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : null;
}

/**
 * 把 tag 值标准化为“去首尾空格后的非空字符串”。
 *
 * @param value 原始 tag 值
 * @returns 去空后的值；若为空则返回 null
 */
function trimTagValue(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * 优先从 `building:levels`，其次从 `level` 提取楼层数。
 *
 * @param tags building tags
 * @returns 解析出的楼层数；若字段缺失或格式不合法则返回 null
 */
function parseBuildingLevels(tags: Record<string, string>): number | null {
  return parseIntegerTag(tags["building:levels"]) ?? parseIntegerTag(tags.level);
}

/**
 * 仅解析纯整数字符串，避免把 `1;2`、`2.5` 等不稳定格式误当作可用楼层数。
 *
 * @param value 原始 tag 值
 * @returns 解析出的整数；若不合法则返回 null
 */
function parseIntegerTag(value: string | undefined): number | null {
  const trimmed = trimTagValue(value);
  if (!trimmed || !/^\d+$/.test(trimmed)) {
    return null;
  }

  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * 从形如 `12`, `12 m`, `12.5m` 这类字符串中提取高度数字部分。
 *
 * @param value 原始 height tag
 * @returns 解析出的高度；若缺失或格式不支持则返回 null
 */
function parseHeightMeters(value: string | undefined): number | null {
  const trimmed = trimTagValue(value);
  if (!trimmed) {
    return null;
  }

  const match = trimmed.match(/-?\d+(?:\.\d+)?/);
  if (!match) {
    return null;
  }

  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * 在主 detail 缺少楼层信息时，使用 member 建筑中的最大楼层数作为保守推断。
 *
 * @param memberDetails relation 成员建筑细节
 * @returns 推断出的楼层数；若无法推断则返回 null
 */
function inferLevelsFromMembers(memberDetails: FeatureDetail[] | undefined): number | null {
  if (!memberDetails || memberDetails.length === 0) {
    return null;
  }

  const levels = memberDetails
    .map((memberDetail) => parseBuildingLevels(memberDetail.tags))
    .filter((value): value is number => value !== null);

  if (levels.length === 0) {
    return null;
  }

  return Math.max(...levels);
}

/**
 * 在主 detail 缺少高度信息时，使用 member 建筑中的最大高度作为保守推断。
 *
 * @param memberDetails relation 成员建筑细节
 * @returns 推断出的高度；若无法推断则返回 null
 */
function inferHeightFromMembers(memberDetails: FeatureDetail[] | undefined): number | null {
  if (!memberDetails || memberDetails.length === 0) {
    return null;
  }

  const heights = memberDetails
    .map((memberDetail) => parseHeightMeters(memberDetail.tags.height))
    .filter((value): value is number => value !== null);

  if (heights.length === 0) {
    return null;
  }

  return Math.max(...heights);
}

/**
 * TODO: 不合理，容易多算重叠部分的面积
 * 对一组可空面积求和；若没有任何有效面积，则保留 null。
 *
 * @param areas 待求和的面积列表
 * @returns 面积总和；若没有有效值则返回 null
 */
function sumAreas(areas: Array<number | null>): number | null {
  const finiteAreas = areas.filter((area): area is number => area !== null);
  if (finiteAreas.length === 0) {
    return null;
  }

  return finiteAreas.reduce((sum, area) => sum + area, 0);
}

/**
 * 以 primary 为高优先级合并两份 tags，只在主值缺失时使用 fallback 补洞。
 *
 * @param primary 高优先级 tags
 * @param fallback 仅用于补洞的次级 tags
 * @returns 合并后的 tags
 */
function mergeStringRecord(primary: Record<string, string>, fallback: Record<string, string>): Record<string, string> {
  const merged = { ...primary };
  for (const [key, value] of Object.entries(fallback)) {
    if (!(key in merged)) {
      merged[key] = value;
    }
  }

  return merged;
}

function computeMeanCenterPosition(positions: Position[]): Position | null {
  if (positions.length === 0) {
    return null;
  }

  const totals = positions.reduce(
    (accumulator, position) => ({
      lat: accumulator.lat + position.lat,
      lon: accumulator.lon + position.lon,
    }),
    { lat: 0, lon: 0 },
  );

  return {
    lat: totals.lat / positions.length,
    lon: totals.lon / positions.length,
  };
}

/**
 * 判断 tags 是否直接指向住宅类 building。
 *
 * @param tags building tags
 * @returns 是否命中住宅 building 值
 */
function isExplicitHouse(tags: Record<string, string>): boolean {
  return EXPLICIT_HOUSE_BUILDING_VALUES.has(trimTagValue(tags.building) || "");
}

/**
 * 判断 tags 是否直接指向 garage 类 building。
 *
 * @param tags building tags
 * @returns 是否命中 garage building 值
 */
function isExplicitGarage(tags: Record<string, string>): boolean {
  return EXPLICIT_GARAGE_BUILDING_VALUES.has(trimTagValue(tags.building) || "");
}

/**
 * 判断 tags 是否直接指向 shed / 工具屋类 building。
 *
 * @param tags building tags
 * @returns 是否命中 tool shed building 值
 */
function isExplicitToolShed(tags: Record<string, string>): boolean {
  return EXPLICIT_TOOL_SHED_BUILDING_VALUES.has(trimTagValue(tags.building) || "");
}

/**
 * 在建筑所含 POI 中查找某个明确用途标签。
 *
 * 这一步主要用于把“主 building 标签不够明确，但 contained POI 很明确”的情况，
 * 归到简单类别里。
 *
 * @param candidate 当前建筑候选
 * @param key 需要检查的 tag key
 * @param values 允许命中的 tag value 列表
 * @returns 是否存在匹配的 contained POI
 */
function hasContainedPoiTag(
  candidate: BuildingCandidate,
  key: string,
  values: string[],
): boolean {
  const valueSet = new Set(values);
  return (candidate.detail.containedPoisReferences || []).some((poi) => {
    const tagValue = trimTagValue(poi.tags[key]);
    return tagValue !== null && valueSet.has(tagValue);
  });
}

/**
 * 以支持权重和反对权重加权随机得到结果
 * @param supportingWeight
 * @param nonSupportingWeight 为负数
 * @returns true 代表支持，false 代表反对
 */
function weightedBoolean(supportingWeight: number, nonSupportingWeight: number): boolean {
  const totalWeight = supportingWeight + nonSupportingWeight;
  if (totalWeight <= 0) return false;
  return Math.random() * totalWeight < supportingWeight;
}

/**
 * 从给定列表中均匀随机取一个值。
 *
 * @param values 候选值列表
 * @returns 被选中的值
 */
function pickRandom<T>(values: T[]): T {
  const index = Math.min(values.length - 1, Math.floor(Math.random() * values.length));
  return values[index];
}

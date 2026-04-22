import { query } from "@/db/client.js";
import { loadServiceSql } from "@/db/sqlLoader.js";
import { DbBuildingFeatureDetailRow, FeatureDetail, FeatureId, mapBuildingDetailRowToFeatureDetail } from "@/services/featureDetail.js";
import { Position } from "./gameSessionStore.js";
import { ambiguousResidentialCategory, buildApartmentCategorySchemaFromDistribution, buildHouseCategorySchemaFromDistribution, buildResidentialAccessoryCategorySchemaFromDistribution, finishApartmentBuildingSchema, finishHouseBuildingSchema, finishResidentialAccessoryBuildingSchema, RESIDENTIAL_CATEGORIES, RESIDENTIAL_CATEGORY_KEYS, RESIDENTIAL_PATTERN_KEYS, selectResidentialPatternKey } from "./buildingResidential.js";
import { trimTagValue } from "../utils.js";

// Data Base 类型

/**
 * 与 SQL 查询结果表一致的扁平类型
 */
interface DbBuildingClassifierDetailRow extends DbBuildingFeatureDetailRow {
  area_sqm: number;
  center_lon: number;
  center_lat: number;
}

interface DbRoadKindsRow {
  road_kinds: string[] | null;
}

interface DbCoveringAreasRow {
  covering_areas: string[] | null;
}

// Schema 类型

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

export interface RoomSchema {
  descrption: string;
  count: number;
  access?: "entrance" | "vertical" | "internal";
}

/**
 * 特意无 access
 */
export interface SuiteSchema {
  theme: string;
  count: number;
  subRooms: Record<string, SubRoomSchema>;
}

/**
 * 特意无 access
 */
export interface SubRoomSchema {
  descrption: string;
  count: number;
}

export interface CategorySchema {
  theme: string;
  levels: Record<string, CategoryLevelSchema>; // key 为楼层种类名
}

/**
 * 刻意由 Level 直接连接 Room
 */
export interface CategoryLevelSchema {
  theme: string;
  span: number[]; // 使用该 C-Schema 的楼层
  rooms: Record<string, CategoryRoomSchema>; // key 为该房间的种类名
}

/**
 * 刻意不包含数量信息；Suite 此时也由此类型表示
 */
export interface CategoryRoomSchema {
  descrption: string;
  access?: "entrance" | "vertical" | "internal";
}

/**
 * 特指经过了 Sector Distributtion，但还没到收尾阶段的 Schema
 */
export interface SectorDistributionSchem {
  theme: string;
  levels: Record<string, { // key 为楼层种类名
    theme: string;
    span: number[]; // 使用该 C-Schema 的楼层
    sectors: Record<string, { // key 为该 Sector 的名字
      area: number;
      centerPosition: Position;
      rooms: Record<string, CategoryRoomSchema>; // key 为该房间的种类名
    }>
  }>
}


/**
 * 单体建筑还是复合建筑
 */
type ScopeType = "single" | "building_relation";

/**
 * 根据 featureId 获取的候选地物，包含所有分类所需的信息
 * Category 信息和 Pattern 信息也借助此处流转
 */
export interface BuildingCandidate {
  featureId: string;
  scope: ScopeType;
  details: FeatureDetail[];
  outline?: FeatureId;
  areaSqm: number | null;
  centerPosition: Position;
  buildingLevels: number | null;
  heightMeters: number | null;
  buildingValue: string | null;
  categoryRecord?: string[]; // 整个 candidate 使用同一组 Category
  patternRecord?: Record<string, string>; // 每个 Category 都配一个 Pattern
}

//Definition 类型

export interface CategoryDefinition {
  desc: string;
  base_schema?: CategoryBaseSchemaDefinition
  patterns?: Record<string, PatternDefinition> // 键是该 Pattern 的名字
}

/**
 * Base Schem 是不参与 Pattern Distribution 的，只会在分配完成后应用到每个建筑中去
 */
export interface CategoryBaseSchemaDefinition {
  rooms: Record<string, true | PatternRoomDefinition>
}

export interface PatternDefinition {
  desc: string,
  rooms: Record<string, PatternRoomDefinition> // 键是该房间的名字
}

/**
 * Pattern 中对房间的定义，不包含数量
 */
export interface PatternRoomDefinition {
  desc?: string;
  prefered?: string; // 倾向的楼层
  chance?: number; // 出现在此 Pattern 中的概率
}

/**
 * 键为 featureId，值为已分配到该地物的房间定义；
 * 由于 Category 是整个多体建筑共用（不论是不是复合 Category），因此不能以 Category 为界限分类
 */
export type PatternDistribution = Record<FeatureId, Record<string, PatternRoomDefinition>>

//#region 出口函数

/**
 * 输入 featureId, 自行从数据库获取相关数据后进行分类等操作，返回现成的 Building Schema 记录。
 * @param featureId 支持传入单体 building 或 relation/part
 * @param existingSchemas 作为参考的来自 Game State 的 Building Schema
 * @param skipComplex 如果后续遇到必须依赖 LLM 才能判断的复杂分配，是否放弃此次生成
 * @returns 现成的 Building Schema 记录，或者表示无法生成的 undefined
 */
export async function generateBuildingSchema(
  featureId: string,
  existingSchemas: BuildingSchema[],
  skipComplex: boolean = true
): Promise<Record<FeatureId, BuildingSchema> | undefined> {
  // 先找到候选建筑
  const candidate = await fetchBuildingCandidate(featureId);
  if (!candidate) {
    return undefined;
  }
  let category = []
  // 看看能不能直接分类出来
  // 不能直接分出来就进入模糊分类模式
  category = resolveExplicitCategory(candidate);
  if (category.length === 0) category = await resolveAmbiguousCategory(candidate, existingSchemas);

  // TODO 再没有分类结果的话，还没定好怎么处理
  if (category.length === 0) return undefined;

  // Category 信息存入 candidate
  candidate.categoryRecord = category

  // 根据候选建筑本身信息，为每个 Category 随机选择一个 pattern
  const patternKeys: Record<string, string> = {}
  category.forEach(key => {// 键为各个 Category Key，值为对应 Pattern Key
    patternKeys[key] = selectPatternKey(candidate, key)
  })
  // console.log(patternKeys);

  // Pattern 信息存入 candidate
  candidate.patternRecord = patternKeys

  // 产出 Pattern Distribution 方案。
  // skipComplex 当前只作为未来 LLM 复杂分支的保留参数；已有逻辑都是确定性规则，不会因为它改变行为。
  const patternDistribution = decidePatternDistribution(candidate, skipComplex)
  // 对 Base Schema 应用 Pattern Distribution 方案
  const patternAppliedBaseSchema = applyCategoryBaseSchemasToDistribution(candidate, patternDistribution)

  // 根据 candidate 创建仅有楼层数的空 Category Schema
  const categorySchemas = buildCategorySchemaFromDistribution(patternAppliedBaseSchema, candidate)

  // 产出 Sector Distribution 方案。
  // 同 Pattern Distribution，目前实现尚未接入 LLM，因此这里只负责把参数继续穿透下去。
  const sectorDistributionSchems = decideSectorDistribution(categorySchemas, candidate, skipComplex)
  // 填充 Category Schema 没有的细节，生成完整 Building Schema
  const buildingSchemas = finishBuildingSchema(sectorDistributionSchems, candidate)

  return buildingSchemas;
}

/**
 * 为 building schema debug route 构造最小 existingSchemas。
 *
 * 住宅模糊分类目前只读取已有 schema 的 category 和 centerPosition；
 * 因此 debug mock 不需要填充楼层/房间细节，但位置必须与待测 feature 完全一致，
 * 才能稳定命中“附近已有建筑类型”的判断逻辑。
 *
 * @param featureId 待测 building feature id
 * @param categories 用户在 debug 页输入的已有 BuildingSchema category 列表
 * @returns mock existingSchemas；若 feature 不存在则返回 undefined
 */
export async function buildColocatedDebugBuildingSchemas(
  featureId: string,
  categories: string[],
): Promise<BuildingSchema[] | undefined> {
  const candidate = await fetchBuildingCandidate(featureId);
  if (!candidate) {
    return undefined;
  }

  return categories.map((category, index) => ({
    featureId: `debug-existing/${index + 1}`,
    category,
    centerPosition: candidate.centerPosition,
    theme: "debug mock schema",
    levels: {},
  }));
}

//#region 主逻辑函数
// 直接用在 generateBuildingSchema 函数中

const EXPLICIT_HOUSE_BUILDING_VALUES = new Set(["house", "detached", "residential"]);
const EXPLICIT_APARTMENT_BUILDING_VALUES = new Set(["apartment", "apartments"]);
const EXPLICIT_GARAGE_BUILDING_VALUES = new Set(["garage", "garages", "carport"]);
const EXPLICIT_TOOL_SHED_BUILDING_VALUES = new Set(["shed"]);

const ALL_CATEGORIES = {...RESIDENTIAL_CATEGORIES}
const ALL_CATEGORY_KEYS = [...RESIDENTIAL_CATEGORY_KEYS]
const ALL_PATTERN_KEYS = [...RESIDENTIAL_PATTERN_KEYS]

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
  if (!feature) return null

  // 寻找该地物是否通过 Relation Reference 指向一个多体建筑
  const relationReference = feature.detail.relationReferences?.find((relation) => {
    return relation.reltags.type === "building";
  });

  // 不指向多体建筑，说明该地物只是单体建筑
  // 由于 osmNormalization 逻辑当中，relation 会尽可能吸收其子要素，所以不存在 relation 与其子要素同时存在的情况；
  // 所以这里其实兼顾了普通单体建筑与 relation 吸收其子要素生成的单体建筑
  if (!relationReference) {
    const details = [feature.detail];
    return toResolvedCandidate("single", feature.detail.featureId, details, pickOutlineFeatureId(details), feature.areaSqm, feature.centerPosition);
  }

  // 多体建筑的子建筑（特征：包含 Relation Reference）
  const relationMembers = await fetchBuildingRelationMembers(relationReference.rel);
  const relationMemberDetails = relationMembers.map((snapshot) => snapshot.detail);
  const outline = pickOutlineFeatureId(relationMemberDetails);
  const outlineSnapshot = outline ? await fetchBuildingFeatureDetailById(outline) : null;
  const relationAreaSqm = outlineSnapshot?.areaSqm
    ?? sumAreas(relationMembers.map((snapshot) => snapshot.areaSqm));
  const relationCenterPosition = outlineSnapshot?.centerPosition
    ?? computeMeanCenterPosition(
      relationMembers.map((snapshot) => snapshot.centerPosition),
  );

  return toResolvedCandidate(
    "building_relation",
    `relation/${relationReference.rel}`, // 虽然此 osmId 的要素真实存在于 osm 的数据库，但不存在于本地数据库
    relationMemberDetails,
    outline,
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
 * @returns category 列表，长度超过1代表复合 Category；若当前阶段仍无法稳定判断则返回空数组
 */
function resolveExplicitCategory(candidate: BuildingCandidate): string[] {
  const category: string[] = []
  const tagsList = candidate.details.map( d => d.tags )
  // 以下顺序按照重要程度从大到小排列，保证最主体的分类可以排为复合分类的主分类
  if (isExplicitBuilding(EXPLICIT_APARTMENT_BUILDING_VALUES, tagsList)) return ["apartment"];
  if (isExplicitBuilding(EXPLICIT_HOUSE_BUILDING_VALUES, tagsList)) return ["house"];
  if (isExplicitBuilding(EXPLICIT_GARAGE_BUILDING_VALUES, tagsList) || hasContainedPoiTag(candidate, "amenity", ["parking"])) return ["garage"];
  if (isExplicitBuilding(EXPLICIT_TOOL_SHED_BUILDING_VALUES, tagsList)) return ["tool_shed"];

  return category
}

/**
 * TODO 目前暂只支持住宅区
 * @param candidate
 * @param existingSchemas
 * @returns
 */
async function resolveAmbiguousCategory(
  candidate: BuildingCandidate,
  existingSchemas: BuildingSchema[]
): Promise<string[]> {
  return ambiguousResidentialCategory(candidate, existingSchemas);
}

/**
 * TODO 目前暂只支持住宅区
 * @param candidate
 * @param categoryKey 已分解的 Category Key（不含`&`）
 * @returns
 */
function selectPatternKey(
  candidate: BuildingCandidate,
  categoryKey: string, // TODO 当前只支持住宅
): string {
  return selectResidentialPatternKey(candidate, categoryKey)
}

/**
 * TODO 当前是占位符，只返回单一的 PatternDistribution。
 *
 * skipComplex 表示未来遇到必须靠 LLM 才能抉择的复杂分配时可以直接放弃生成；
 * 当前实现仍全部是 deterministic fallback，因此接收该参数但暂不改变行为。
 * @param candidate 提供单体建筑或多体建筑
 * @param skipComplex 是否跳过未来的 LLM-only 复杂分支
 * @returns
 */
export function decidePatternDistribution(candidate: BuildingCandidate, skipComplex: boolean = true): PatternDistribution {
  void skipComplex;
  const featureIds = candidate.details.map(d => d.featureId)
  const categoryRecord = candidate.categoryRecord || []
  const patternRecord = candidate.patternRecord || {}
  // 把所有 rooms 全部提取到单一 Object
  const patternRoomsEntries = categoryRecord.flatMap( cat => {
    const patterns = ALL_CATEGORIES[cat].patterns
    if (!patterns) return []
    const patternKey = patternRecord[cat]
    const rooms = patterns[patternKey].rooms
    return Object.entries(rooms)
  })
  const patternRooms = Object.fromEntries(patternRoomsEntries)

  // 单一建筑就直接组装 patternDistribution
  if (candidate.scope === 'single' && candidate.details.length === 1) {
    return {[featureIds[0]]: patternRooms}
  }

  const result: PatternDistribution = {}
  // TODO 多体建筑未来需要应用特殊逻辑（LLM 或其他）。
  // 目前还没有非确定性分支，因此即使 skipComplex 为 true 也继续使用第一个 feature 的保守分配。
  return {[featureIds[0]]: patternRooms}
}

/**
 * 把各 Category 的 base schema 合并进 Pattern Distribution，保留房间 key。
 */
export function applyCategoryBaseSchemasToDistribution(
  candidate: BuildingCandidate,
  patternDistribution: PatternDistribution,
): PatternDistribution {
  const categoryRecord = candidate.categoryRecord || []
  const patternDistributionEntries = Object.entries(patternDistribution)
  // 提取所有 base schema 到单一 Object
  const baseSchemaEntries = categoryRecord.flatMap( cat => {
    const baseSchema = ALL_CATEGORIES[cat].base_schema
    if (!baseSchema) return []
    return Object.entries(baseSchema.rooms).flatMap(([roomKey, room]) => {
      if (room === true) return []

      if (roomKey === "self") {
        // self 只表示“该 Category 本体就是一个房间功能”，最终 Schema 仍使用 Category Key 与 Category 描述。
        return [[cat, {
          ...room,
          desc: ALL_CATEGORIES[cat].desc,
        }]]
      }

      return [[roomKey, room]]
    })
  })
  const baseSchemaApplied = patternDistributionEntries.map( ([featureId, roomDefs]) => {
    // 每个 Category 里的 base schema 都会应用给所有子建筑
    const baseSchemaAppliedRoomDefs = {...roomDefs, ...Object.fromEntries(baseSchemaEntries)}
    return [featureId, baseSchemaAppliedRoomDefs]
  })
  return Object.fromEntries(baseSchemaApplied)
}

/**
 * TODO 目前暂只支持住宅区
 * @param appliedBaseSchema 键为 feature id
 * @param candidate
 * @returns
 */
function buildCategorySchemaFromDistribution(
  appliedBaseSchema: PatternDistribution,
  candidate: BuildingCandidate,
): Record<FeatureId, CategorySchema> {
  // 当前 schema builder 只支持住宅类；按主 Category 分支，避免独立附属建筑复用住宅楼层语义。
  const mainCategory = candidate.categoryRecord?.[0];
  if (mainCategory === "house") {
    return buildHouseCategorySchemaFromDistribution(appliedBaseSchema, candidate)
  }
  if (mainCategory === "apartment") {
    return buildApartmentCategorySchemaFromDistribution(appliedBaseSchema, candidate)
  }
  if (mainCategory === "garage" || mainCategory === "tool_shed") {
    return buildResidentialAccessoryCategorySchemaFromDistribution(appliedBaseSchema, candidate)
  }
  return {}
}

/**
 * TODO 当前是占位符，只返回单一的 SectorDistribution。
 *
 * skipComplex 表示未来遇到必须靠 LLM 才能抉择的复杂分区时可以直接放弃生成；
 * 当前 sector 分配只创建 main sector，因此接收该参数但暂不改变行为。
 * @param categorySchema
 * @param candidate
 * @param skipComplex 是否跳过未来的 LLM-only 复杂分支
 */
function decideSectorDistribution(
  categorySchemas: Record<FeatureId, CategorySchema>,
  candidate: BuildingCandidate,
  skipComplex: boolean = true,
): Record<FeatureId, SectorDistributionSchem> {
  void skipComplex;
  const result: Record<FeatureId, SectorDistributionSchem> = {}
  Object.entries(categorySchemas).forEach(([featureId, schema]) => {
    const levelsEntries = Object.entries(schema.levels)
    const levelsSectorEntries = levelsEntries.map( ([key, level]) => {
      return [key, {
        theme: level.theme,
        span: level.span,
        sectors: {main: {
          area: candidate.areaSqm ?? 0,
          centerPosition: candidate.centerPosition,
          rooms: level.rooms,
        }}
      }]
    })
    result[featureId] = {
      theme: schema.theme,
      levels: Object.fromEntries(levelsSectorEntries)
    }
  })
  return result
}

/**
 * TODO 目前暂只支持住宅区
 * @param schema
 * @param candidate
 * @returns
 */
function finishBuildingSchema(
  schemas: Record<FeatureId, SectorDistributionSchem>,
  candidate: BuildingCandidate,
): Record<FeatureId, BuildingSchema> {
  // 收尾同样按主 Category 分支；住宅主体需要入口/楼梯等补全，独立附属建筑不需要。
  const mainCategory = candidate.categoryRecord?.[0];
  if (mainCategory === "house") {
    return finishHouseBuildingSchema(schemas, candidate)
  }
  if (mainCategory === "apartment") {
    return finishApartmentBuildingSchema(schemas, candidate)
  }
  if (mainCategory === "garage" || mainCategory === "tool_shed") {
    return finishResidentialAccessoryBuildingSchema(schemas, candidate)
  }
  return {}
}

//#region 共用逻辑函数

const fetchBuildingFeatureDetailByIdSqlPromise = loadServiceSql("gameSystem/sql/fetchBuildingFeatureDetailById.sql");
const fetchBuildingRelationMemberDetailsSqlPromise = loadServiceSql("gameSystem/sql/fetchBuildingRelationMemberDetails.sql");
const fetchBuildingRoadKindsSqlPromise = loadServiceSql("gameSystem/sql/fetchBuildingRoadKinds.sql");
const fetchBuildingCoveringAreasSqlPromise = loadServiceSql("gameSystem/sql/fetchBuildingCoveringAreas.sql");

const FETCH_ROAD_RADIUS_METERS = 90;

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
  const result = await query<DbBuildingClassifierDetailRow>(sql, [featureRef.osmType, featureRef.osmId]);
  const row = result.rows[0];

  if (!row) {
    return null;
  }

  return {
    detail: mapBuildingDetailRowToFeatureDetail(row),
    areaSqm: row.area_sqm,
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
async function fetchBuildingRelationMembers(
  relationOsmId: number,
): Promise<Array<{ detail: FeatureDetail; areaSqm: number | null; centerPosition: Position }>> {
  const sql = await fetchBuildingRelationMemberDetailsSqlPromise;
  const result = await query<DbBuildingClassifierDetailRow>(sql, [relationOsmId]);

  return result.rows.map((row) => ({
    detail: mapBuildingDetailRowToFeatureDetail(row),
    areaSqm: row.area_sqm,
    centerPosition: {
      lat: Number(row.center_lat),
      lon: Number(row.center_lon),
    },
  }));
}

export async function fetchBuildingRoadKinds(featureId: string): Promise<string[]> {
  const featureRef = parseBuildingFeatureId(featureId);
  const sql = await fetchBuildingRoadKindsSqlPromise;
  const result = await query<DbRoadKindsRow>(sql, [
    featureRef.osmType,
    featureRef.osmId,
    FETCH_ROAD_RADIUS_METERS,
  ]);

  return result.rows[0]?.road_kinds || [];
}

export async function fetchBuildingCoveringAreas(featureId: string): Promise<string[]> {
  const featureRef = parseBuildingFeatureId(featureId);
  const sql = await fetchBuildingCoveringAreasSqlPromise;
  const result = await query<DbCoveringAreasRow>(sql, [featureRef.osmType, featureRef.osmId]);

  return result.rows[0]?.covering_areas || [];
}

/**
 * 把 `&` 分隔的复合型 Category Key 拆分成主 Category 和附属 Category
 * @param categoryKey
 * @returns 尚未进行真实性检验的 Category Key (单纯的字符串)
 */
export function parseCompositeCategoryKey(categoryKey: string): {
  mainCategoryKey: string;
  containedCategoryKeys: string[];
} {
  const categoryKeys = categoryKey
    .split("&")
    .map((key) => key.trim())

  const [mainCategoryKey, ...containedCategoryKeys] = categoryKeys;
  return { mainCategoryKey, containedCategoryKeys };
}

/**
 * 把原始 detail 与衍生指标一起打包成分类阶段统一使用的候选结构。
 *
 * 衍生指标目前只包括面积、楼层数与高度，且优先使用主 detail，
 * 在缺失时再从其余 detail 中推断。
 *
 * @param scope 当前候选是单体建筑还是 relation 级建筑
 * @param featureId 当前候选身份 id
 * @param details 当前候选关联的真实建筑细节
 * @param outline relation outline 对应的 feature id
 * @param areaSqm 已解析出的面积
 * @returns 分类阶段统一使用的候选结构
 */
function toResolvedCandidate(
  scope: ScopeType,
  featureId: FeatureId,
  details: FeatureDetail[],
  outline: FeatureId | undefined,
  areaSqm: number | null,
  centerPosition: Position,
): BuildingCandidate {
  const [primaryDetail, ...secondaryDetails] = details;
  if (!primaryDetail) {
    throw new Error(`BuildingCandidate ${featureId} has no feature details.`);
  }

  const buildingLevels = parseBuildingLevels(primaryDetail.tags) ?? inferLevelsFromDetails(secondaryDetails);
  const heightMeters = parseHeightMeters(primaryDetail.tags.height) ?? inferHeightFromDetails(secondaryDetails);

  return {
    featureId,
    scope,
    details,
    outline,
    areaSqm,
    centerPosition,
    buildingLevels,
    heightMeters,
    buildingValue: trimTagValue(primaryDetail.tags.building),
  };
}

//#endregion

//#region 帮助函数

/**
 * 解析内部统一使用的 `osmType/osmId` 形式 feature id。
 *
 * @param featureId 形如 `way/123` 或 `relation/456` 的 feature id
 * @returns 分离后的 osmType 与 osmId
 */
export function parseBuildingFeatureId(featureId: string): { osmType: string; osmId: number } {
  const [osmType, osmIdText] = featureId.split("/");
  const osmId = Number.parseInt(osmIdText, 10);
  return { osmType, osmId };
}

/**
 * 找出该地物的 Outline Reference 所指的地物
 * @param details
 * @returns
 */
function pickOutlineFeatureId(details: FeatureDetail[]): FeatureId | undefined {
  const outlineReference = details.flatMap((detail) => detail.outlineReferences || [])[0];
  if (!outlineReference) {
    return undefined;
  }

  return `${outlineReference.osmType}/${outlineReference.osmId}`;
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
 * 在主 detail 缺少楼层信息时，使用其余 detail 中的最大楼层数作为保守推断。
 *
 * @param details 可用于补充推断的建筑细节
 * @returns 推断出的楼层数；若无法推断则返回 null
 */
function inferLevelsFromDetails(details: FeatureDetail[]): number | null {
  if (details.length === 0) {
    return null;
  }

  const levels = details
    .map((detail) => parseBuildingLevels(detail.tags))
    .filter((value): value is number => value !== null);

  if (levels.length === 0) {
    return null;
  }

  return Math.max(...levels);
}

/**
 * 在主 detail 缺少高度信息时，使用其余 detail 中的最大高度作为保守推断。
 *
 * @param details 可用于补充推断的建筑细节
 * @returns 推断出的高度；若无法推断则返回 null
 */
function inferHeightFromDetails(details: FeatureDetail[]): number | null {
  if (details.length === 0) {
    return null;
  }

  const heights = details
    .map((detail) => parseHeightMeters(detail.tags.height))
    .filter((value): value is number => value !== null);

  if (heights.length === 0) {
    return null;
  }

  return Math.max(...heights);
}

/**
 * TODO: 不合理，容易多算重叠部分的面积；也许可以靠读取 outline 建筑的面积
 *
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
  // 把所有 details 包含的 poi 全部列在一起
  const allContainedPoisRefs = candidate.details.flatMap(detail => detail.containedPoisReferences || [])
  return allContainedPoisRefs.some((poi) => {
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
export function weightedBoolean(supportingWeight: number, nonSupportingWeight: number): boolean {
  const totalWeight = supportingWeight + nonSupportingWeight;
  return Math.random() * totalWeight < supportingWeight;
}

/**
 * 从给定列表中均匀随机取一个值。
 *
 * @param values 候选值列表
 * @returns 被选中的值
 */
export function pickRandom<T>(values: T[]): T {
  const index = Math.min(values.length - 1, Math.floor(Math.random() * values.length));
  return values[index];
}

/**
 * 判断 tags 是否直接指向 explicitTagSets 所指代的建筑
 *
 * @param tagsList 所有 details 的 building tags
 * @returns 是否命中
 */
function isExplicitBuilding(explicitTagSets: Set<string>, tagsList: Record<string, string>[]): boolean {
  return tagsList.some( tags => explicitTagSets.has(trimTagValue(tags.building) || ""));
}

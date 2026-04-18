import { query } from "@/db/client.js";
import { loadServiceSql } from "@/db/sqlLoader.js";
import { FeatureDetail } from "@/services/featureDetail.js";
import { ContainedPoiReference, dedupeOutlineReferences, OutlineReference, RelationReference } from "@/services/osmNormalization/osmNormalizer.js";
import { Position } from "./gameSessionStore.js";
import { ambiguousResidentialCategory, selectResidentialPatternKey } from "./buildingResidential.js";
import { trimTagValue } from "../utils.js";

/**
 * 与 SQL 查询结果表一致的扁平类型
 */
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


/**
 * 单体建筑还是复合建筑
 */
type ScopeType = "single" | "building_relation";

/**
 * 根据 featureId 获取的候选地物，包含所有分类所需的信息
 */
export interface BuildingCandidate {
  scope: ScopeType;
  detail: FeatureDetail;
  memberDetails?: FeatureDetail[];
  areaSqm: number | null;
  centerPosition: Position;
  buildingLevels: number | null;
  heightMeters: number | null;
  buildingValue: string | null;
}

const FETCH_ROAD_RADIUS_METERS = 90;

const EXPLICIT_HOUSE_BUILDING_VALUES = new Set(["house", "detached", "residential"]);
const EXPLICIT_GARAGE_BUILDING_VALUES = new Set(["garage", "garages", "carport"]);
const EXPLICIT_TOOL_SHED_BUILDING_VALUES = new Set(["shed"]);

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
function resolveExplicitCategory(candidate: BuildingCandidate): string | null {
  if (isExplicitBuilding(EXPLICIT_GARAGE_BUILDING_VALUES, candidate.detail.tags) || hasContainedPoiTag(candidate, "amenity", ["parking"])) return "garage";
  if (isExplicitBuilding(EXPLICIT_TOOL_SHED_BUILDING_VALUES, candidate.detail.tags)) return "tool_shed";
  if (isExplicitBuilding(EXPLICIT_HOUSE_BUILDING_VALUES, candidate.detail.tags)) return "house";
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
): Promise<string | null> {
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
  categoryKey: string, // TODO 当前只支持住宅
): string {
  return selectResidentialPatternKey(candidate, categoryKey)
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
async function fetchBuildingRelationMemberSnapshots(
  relationOsmId: number,
): Promise<Array<{ detail: FeatureDetail; areaSqm: number | null; centerPosition: Position }>> {
  const sql = await fetchBuildingRelationMemberDetailsSqlPromise;
  const result = await query<DbBuildingDetailRow>(sql, [relationOsmId]);

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
export function parseBuildingFeatureId(featureId: string): { osmType: string; osmId: number } {
  const [osmType, osmIdText] = featureId.split("/");
  const osmId = Number.parseInt(osmIdText, 10);
  return { osmType, osmId };
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
export function weightedBoolean(supportingWeight: number, nonSupportingWeight: number): boolean {
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
export function pickRandom<T>(values: T[]): T {
  const index = Math.min(values.length - 1, Math.floor(Math.random() * values.length));
  return values[index];
}

/**
 * 判断 tags 是否直接指向 explicitTagSets 所指代的建筑
 *
 * @param tags building tags
 * @returns 是否命中
 */
function isExplicitBuilding(explicitTagSets: Set<string>, tags: Record<string, string>): boolean {
  return explicitTagSets.has(trimTagValue(tags.building) || "");
}
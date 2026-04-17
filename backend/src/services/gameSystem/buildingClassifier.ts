import { query } from "@/db/client.js";
import { loadServiceSql } from "@/db/sqlLoader.js";
import { FeatureDetail } from "@/services/featureDetail.js";
import { ContainedPoiReference, OutlineReference, RelationReference } from "@/services/osmNormalization/osmNormalizer.js";
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
}

export interface BuildingSchema {
  featureId: string;
  theme: string;
  levels: Record<string, LevelSchema>; // key 为楼层种类名
  classification?: ResolvedBuildingSelection;
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

type ResidentialPatternKey = keyof typeof RESIDENTIAL_CATEGORIES.house.patterns;
type SimpleCategoryKey = "garage" | "tool_shed";
type SupportedCategoryKey = keyof typeof RESIDENTIAL_CATEGORIES;
type ScopeType = "single" | "building_relation";
type PatternSource = "by_tag" | "by_residential_rule" | "by_area_and_levels";

export interface ResolvedBuildingSelection {
  effectiveFeatureId: string;
  categoryKeys: SupportedCategoryKey[];
  patternKey: ResidentialPatternKey | SimpleCategoryKey;
  patternSource: PatternSource;
  skipReason?: string;
}

interface ResolvedBuildingCandidate {
  effectiveFeatureId: string;
  scope: ScopeType;
  detail: FeatureDetail;
  memberDetails?: FeatureDetail[];
  areaSqm: number | null;
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

//#region 出口函数

/**
 * 输入 featureId, 自行从数据库获取相关数据后进行分类等操作，返回现成的 Building Schema
 * TODO: 添加最终 Building Schema 的组装逻辑。目前只做到 category/pattern 选择。
 * @param featureId
 * @param skipComplex 是否跳过太复杂需要 LLM 参与的步骤
 * @returns 现成的 Building Schema，或者表示被跳过的 undefined
 */
export async function generateBuildingSchema(
  featureId: string,
  skipComplex: boolean = true
): Promise<BuildingSchema | undefined> {
  const selection = await resolveBuildingSelection(featureId, skipComplex);
  if (!selection) {
    return undefined;
  }

  return buildFinalBuildingSchema(selection);
}

export async function resolveBuildingSelection(
  featureId: string,
  skipComplex: boolean = true,
): Promise<ResolvedBuildingSelection | undefined> {
  const candidate = await resolveBuildingCandidate(featureId);
  if (!candidate) {
    return undefined;
  }

  const directCategory = await resolveDirectCategory(candidate);
  if (directCategory) {
    return {
      effectiveFeatureId: candidate.effectiveFeatureId,
      categoryKeys: [directCategory],
      patternKey: selectPatternKey(candidate, directCategory),
      patternSource: directCategory === "house" ? "by_area_and_levels" : "by_tag",
    };
  }

  if (skipComplex) {
    return undefined;
  }

  return resolveComplexCategory(candidate);
}

//#region 主函数

const classifyStandaloneResidentialBuildingSqlPromise = loadServiceSql("gameSystem/sql/classifyStandaloneResidentialBuilding.sql");
const fetchBuildingFeatureDetailByIdSqlPromise = loadServiceSql("gameSystem/sql/fetchBuildingFeatureDetailById.sql");
const fetchBuildingRelationMemberDetailsSqlPromise = loadServiceSql("gameSystem/sql/fetchBuildingRelationMemberDetails.sql");

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
  const neighborSampleCount = toFiniteNumber(row?.neighbor_sample_count ?? null);
  const neighborAverageAreaSqm = toFiniteNumber(row?.neighbor_average_area_sqm ?? null);

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
    row?.is_simple_rectangle !== true
    || areaSqm > STANDALONE_BUILDING_MAX_ACCESSORY_AREA_SQM
    || areaSqm >= neighborAverageAreaSqm * STANDALONE_BUILDING_RELATIVE_AREA_THRESHOLD
  ) {
    return true;
  }

  return false;
}

async function resolveBuildingCandidate(featureId: string): Promise<ResolvedBuildingCandidate | null> {
  const directSnapshot = await fetchBuildingSnapshotByFeatureId(featureId);
  if (!directSnapshot) {
    return null;
  }

  const relationReference = directSnapshot.detail.relationReferences?.find((relation) => {
    return relation.reltags.type === "building";
  });

  const shouldPromoteToRelation = directSnapshot.detail.osmType === "way" && relationReference;
  if (!shouldPromoteToRelation) {
    return toResolvedCandidate(featureId, "single", directSnapshot.detail, undefined, directSnapshot.areaSqm);
  }

  const relationFeatureId = `relation/${relationReference.rel}`;
  const relationSnapshot = await fetchBuildingSnapshotByFeatureId(relationFeatureId);
  const relationMemberSnapshots = await fetchBuildingRelationMemberSnapshots(relationReference.rel);

  if (!relationSnapshot && relationMemberSnapshots.length === 0) {
    return toResolvedCandidate(featureId, "single", directSnapshot.detail, undefined, directSnapshot.areaSqm);
  }

  const memberDetails = relationMemberSnapshots.map((snapshot) => snapshot.detail);
  const relationDetail = relationSnapshot?.detail ?? synthesizeRelationDetail(relationFeatureId, memberDetails);
  const relationAreaSqm = relationSnapshot?.areaSqm ?? sumAreas(relationMemberSnapshots.map((snapshot) => snapshot.areaSqm));

  return toResolvedCandidate(relationFeatureId, "building_relation", relationDetail, memberDetails, relationAreaSqm);
}

async function resolveDirectCategory(candidate: ResolvedBuildingCandidate): Promise<SupportedCategoryKey | null> {
  if (isExplicitGarage(candidate.detail.tags) || hasContainedPoiTag(candidate, "amenity", ["parking"])) {
    return "garage";
  }

  if (isExplicitToolShed(candidate.detail.tags)) {
    return "tool_shed";
  }

  if (isExplicitHouse(candidate.detail.tags)) {
    const isResidential = await isStandaloneResidentialBuilding(candidate.effectiveFeatureId);
    if (isResidential) {
      return "house";
    }

    if (isExplicitGarage(candidate.detail.tags)) {
      return "garage";
    }

    if (isExplicitToolShed(candidate.detail.tags)) {
      return "tool_shed";
    }

    return null;
  }

  return null;
}

function selectPatternKey(
  candidate: ResolvedBuildingCandidate,
  categoryKey: SupportedCategoryKey,
): ResidentialPatternKey | SimpleCategoryKey {
  if (categoryKey === "garage" || categoryKey === "tool_shed") {
    return categoryKey;
  }

  const patternPool = determineResidentialPatternPool(candidate);
  return pickRandom(patternPool);
}

function determineResidentialPatternPool(candidate: ResolvedBuildingCandidate): ResidentialPatternKey[] {
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

async function fetchBuildingSnapshotByFeatureId(
  featureId: string,
): Promise<{ detail: FeatureDetail; areaSqm: number | null } | null> {
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
  };
}

async function fetchBuildingRelationMemberSnapshots(
  relationOsmId: number,
): Promise<Array<{ detail: FeatureDetail; areaSqm: number | null }>> {
  const sql = await fetchBuildingRelationMemberDetailsSqlPromise;
  const result = await query<DbBuildingDetailRow>(sql, [relationOsmId]);

  return result.rows.map((row) => ({
    detail: mapBuildingDetailRowToFeatureDetail(row),
    areaSqm: toFiniteNumber(row.area_sqm),
  }));
}

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

function synthesizeRelationDetail(featureId: string, memberDetails: FeatureDetail[]): FeatureDetail {
  const parsed = parseBuildingFeatureId(featureId);
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

function toResolvedCandidate(
  effectiveFeatureId: string,
  scope: ScopeType,
  detail: FeatureDetail,
  memberDetails: FeatureDetail[] | undefined,
  areaSqm: number | null,
): ResolvedBuildingCandidate {
  const buildingLevels = parseBuildingLevels(detail.tags) ?? inferLevelsFromMembers(memberDetails);
  const heightMeters = parseHeightMeters(detail.tags.height) ?? inferHeightFromMembers(memberDetails);

  return {
    effectiveFeatureId,
    scope,
    detail,
    memberDetails,
    areaSqm,
    buildingLevels,
    heightMeters,
    buildingValue: trimTagValue(detail.tags.building),
  };
}

function buildFinalBuildingSchema(selection: ResolvedBuildingSelection): BuildingSchema {
  return {
    featureId: selection.effectiveFeatureId,
    theme: "default",
    levels: {},
    classification: selection,
  };
}

async function resolveComplexCategory(
  candidate: ResolvedBuildingCandidate,
): Promise<ResolvedBuildingSelection | undefined> {
  void candidate;
  return undefined;
}

function applyPatternToCategorySchema(): void {
  // TODO: 下一阶段在这里把 category/pattern 应用到真正的 Category Schema。
}

//#endregion

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

function trimTagValue(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseBuildingLevels(tags: Record<string, string>): number | null {
  return parseIntegerTag(tags["building:levels"]) ?? parseIntegerTag(tags.level);
}

function parseIntegerTag(value: string | undefined): number | null {
  const trimmed = trimTagValue(value);
  if (!trimmed || !/^\d+$/.test(trimmed)) {
    return null;
  }

  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

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

function sumAreas(areas: Array<number | null>): number | null {
  const finiteAreas = areas.filter((area): area is number => area !== null);
  if (finiteAreas.length === 0) {
    return null;
  }

  return finiteAreas.reduce((sum, area) => sum + area, 0);
}

function mergeStringRecord(primary: Record<string, string>, fallback: Record<string, string>): Record<string, string> {
  const merged = { ...primary };
  for (const [key, value] of Object.entries(fallback)) {
    if (!(key in merged)) {
      merged[key] = value;
    }
  }

  return merged;
}

function dedupeOutlineReferences(references: OutlineReference[]): OutlineReference[] {
  const seen = new Set<string>();
  const deduped: OutlineReference[] = [];

  for (const reference of references) {
    const key = `${reference.osmType}/${reference.osmId}:${reference.role}:${reference.rel}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(reference);
  }

  return deduped;
}

function isExplicitHouse(tags: Record<string, string>): boolean {
  return EXPLICIT_HOUSE_BUILDING_VALUES.has(trimTagValue(tags.building) || "");
}

function isExplicitGarage(tags: Record<string, string>): boolean {
  return EXPLICIT_GARAGE_BUILDING_VALUES.has(trimTagValue(tags.building) || "");
}

function isExplicitToolShed(tags: Record<string, string>): boolean {
  return EXPLICIT_TOOL_SHED_BUILDING_VALUES.has(trimTagValue(tags.building) || "");
}

function hasContainedPoiTag(
  candidate: ResolvedBuildingCandidate,
  key: string,
  values: string[],
): boolean {
  const valueSet = new Set(values);
  return (candidate.detail.containedPoisReferences || []).some((poi) => {
    const tagValue = trimTagValue(poi.tags[key]);
    return tagValue !== null && valueSet.has(tagValue);
  });
}

function pickRandom<T>(values: T[]): T {
  const index = Math.min(values.length - 1, Math.floor(Math.random() * values.length));
  return values[index];
}

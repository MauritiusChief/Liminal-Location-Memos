import { Feature, FeatureCollection, Geometry } from "geojson";
import osmtogeojson from "osmtogeojson";
import { OverpassJson } from "overpass-ts";

interface RelationReference {
  role: string;
  rel: number;
  reltags: Record<string, string>;
}

interface OutlineReference {
  osmType: string;
  osmId: number;
  tags: Record<string, string>;
  role: string;
  rel: number;
  reltags: Record<string, string>;
}

interface ContainedPoiReference {
  osmType: string;
  osmId: number;
  tags: Record<string, string>;
  meta: Record<string, string | number>;
  tainted: boolean;
  coordinate: [number, number];
  sourceFeatureId: string;
  relationReferences?: RelationReference[];
}

/**
 * 规整化后的 GeoJSON 所应携带的 property 数据。
 * 其中额外包含对应地物所属 relation、所属 relation 的 outline、所包含的 POI，这三项拼接数据。
 */
interface NormalizedFeatureProperties {
  osmType: string;
  osmId: number;
  tags: Record<string, string>;
  meta: Record<string, string | number>;
  tainted: boolean;
  containedPoiReferences?: ContainedPoiReference[];
  relationReferences: RelationReference[];
  outlineReferences: OutlineReference[];
}

export type NormalizedFeature = Feature<Geometry, NormalizedFeatureProperties>;
export type NormalizedFeatureCollection = FeatureCollection<Geometry, NormalizedFeatureProperties>;

type RawWayElement = {
  type: 'way';
  id: number;
  tags: Record<string, string>;
};

type RawRelationMember = {
  type: string;
  ref: number;
  role: string;
};

/**
 * building 的与 relation 相关的信息
 */
type BuildingRelationInfo = {
  rel: number;
  reltags: Record<string, string>;
  outlineMembers: RawRelationMember[];
  outlineReferences: OutlineReference[];
  inheritedTags: Record<string, string>;
};

type FeatureTagSource = {
  osmType: string;
  osmId: number;
  tags: Record<string, string>;
};

//#region 主函数

/**
 * 按照多种规则整理和筛选数据
 * TODO：哪些规则？
 * @param raw 规整化之前的 osm 数据
 * @returns 规整化后的地物数据
 */
export function convertOverpassToNormalizedFeatures(raw: OverpassJson): NormalizedFeature[] {
  // 建立原始信息索引
  const rawWayTagIndex = buildIndexRawWayTag(raw);
  const buildingRelationOutlineIndex = buildIndexBuildingRelationOutline(raw);

  // 转化整理原始数据
  const converted = osmtogeojson(raw, { flatProperties: false }) as FeatureCollection;
  const normalizedFeatures = converted.features.map((feature) => normalizeFeature(feature)).filter(f => f !== null);

  // 建立规整化信息的索引
  const featureTagIndex = buildIndexFeatureTag(normalizedFeatures);
  const buildingRelationIndex = buildIndexBuildingRelation(buildingRelationOutlineIndex, featureTagIndex, rawWayTagIndex);
  const areaRelationIds = buildAreaRelationIndex(normalizedFeatures);
  const lineRelationIds = buildLineRelationIndex(normalizedFeatures);

  return normalizedFeatures
  .filter((feature) => {
    if (isAbstractLineRelationFeature(feature, lineRelationIds)) {
      return false;
    }

    if (isBuildingRelationOutlineFeature(feature, buildingRelationIndex)) {
      return false;
    }

    if (isBuildingPartLineFeature(feature, buildingRelationIndex)) {
      return false;
    }

    if (isMemberPolygonCoveredByRelationPolygon(feature, areaRelationIds)) {
      return false;
    }

    if (isRelationOutlineCoveredByPolygon(feature, areaRelationIds)) {
      return false;
    }

    if (isMemberLineCoveredByRelationLine(feature, lineRelationIds)) {
      return false;
    }

    return true;
  }).map((feature) => finalizeFeature(feature, lineRelationIds, buildingRelationIndex));
}

/**
 * 规整化收口步骤：移除已被 relation 吸收的引用，并补齐 building relation 的 tags / outline。
 * @param feature 过滤后保留下来的 feature
 * @param relationLineIds 线状 relation id 集合
 * @param buildingRelationIndex building relation 信息索引
 * @returns 最终可进入分类和落库阶段的 feature
 */
function finalizeFeature(
  feature: NormalizedFeature,
  relationLineIds: Set<number>,
  buildingRelationIndex: Map<number, BuildingRelationInfo>,
): NormalizedFeature {
  const filteredRelations = feature.properties.relationReferences.filter( relation => {
    return relationLineIds.has(relation.rel);
  });
  const outlineReferences = isBuildingRelationFeature(feature, buildingRelationIndex) || isBuildingPartPolygonFeature(feature, buildingRelationIndex)
    ? buildingRelationIndex.get(feature.properties.osmId)?.outlineReferences || []
    : isPolygonGeometry(feature)
      ? collectBuildingOutlineReferences(filteredRelations, buildingRelationIndex)
      : [];
  const tags = elevateBuildingTags(feature, buildingRelationIndex);

  const resolvedOutlineReferences = isBuildingPartPolygonFeature(feature, buildingRelationIndex)
    ? collectBuildingOutlineReferences(filteredRelations, buildingRelationIndex)
    : outlineReferences;

  return {
    ...feature,
    properties: {
      ...feature.properties,
      tags,
      relationReferences: filteredRelations,
      outlineReferences: resolvedOutlineReferences,
    },
  };
}

/**
 * 把单个 GeoJSON feature 规整成内部统一结构；没有 geometry 的对象直接丢弃。
 * @param feature osmtogeojson 产出的原始 feature
 * @returns 规整后的 feature；若缺失几何则返回 null
 */
function normalizeFeature(feature: Feature): NormalizedFeature | null {
  if (!feature.geometry || !feature.properties) {
    return null;
  }
  const properties = feature.properties;
  if (typeof properties.type !== 'string' || typeof properties.id !== 'number') {
    return null
  }
  const {type: osmType, id: osmId} = properties

  return {
    type: 'Feature',
    id: `${osmType}/${osmId}`,
    geometry: feature.geometry,
    properties: {
      osmType,
      osmId,
      tags: toStringRecord(properties.tags),
      relationReferences: toRelationReferences(properties.relations),
      outlineReferences: [],
      meta: toMetaRecord(properties.meta),
      tainted: Boolean(properties.tainted),
    },
  };
}

//#region 索引建立函数

/**
 * 从原始 overpass 数据里建立 way tags 索引，供 building relation 回查 outline 标签。
 * @param raw overpass 原始响应
 * @returns 以 way id 为键的 tags 索引
 */
function buildIndexRawWayTag(raw: OverpassJson): Map<number, RawWayElement> {
  const index = new Map<number, RawWayElement>();

  for (const element of raw.elements) {
    if (element.type !== 'way' || typeof element.id !== 'number') {
      continue;
    }

    const tags = toStringRecord(element.tags);
    const existing = index.get(element.id);
    const mergedTags = existing ? mergeTagsPreferPrimary(existing.tags, tags) : tags;

    index.set(element.id, {
      type: 'way',
      id: element.id,
      tags: mergedTags,
    });
  }

  return index;
}

/**
 * 先从未被 osmtogeojson 改写的 raw relation 中提取 outline members，保留原始 number 型 ref。
 * @param raw overpass 原始响应
 * @returns 以 relation id 为键的 building relation 信息索引骨架
 */
function buildIndexBuildingRelationOutline(raw: OverpassJson): Map<number, BuildingRelationInfo> {
  const relationIndex = new Map<number, BuildingRelationInfo>();

  for (const element of raw.elements) {
    if (element.type !== 'relation' || typeof element.id !== 'number') {
      continue;
    }
    const reltags = toStringRecord(element.tags);
    if (reltags.type !== 'building') {
      continue;
    }

    const outlineMembers = toRelationMembers(element.members)
      .filter((member) => member.type === 'way' && member.role === 'outline');

    relationIndex.set(element.id, {
      rel: element.id,
      reltags,
      outlineMembers,
      outlineReferences: [],
      inheritedTags: reltags,
    });
  }

  return relationIndex;
}

/**
 * 从已转换的 polygon feature 中建立稳定的标签索引
 * @param features 规整化候选地物
 * @returns 以 osmType/osmId 为键的标签索引
 */
function buildIndexFeatureTag(features: NormalizedFeature[]): Map<string, FeatureTagSource> {
  const index = new Map<string, FeatureTagSource>();

  for (const feature of features) {
    if (!isPolygonGeometry(feature)) {
      continue;
    }

    const key = `${feature.properties.osmType}/${feature.properties.osmId}`;
    const existing = index.get(key);
    const mergedTags = existing
      ? mergeTagsPreferPrimary(existing.tags, feature.properties.tags)
      : feature.properties.tags;

    index.set(key, {
      osmType: feature.properties.osmType,
      osmId: feature.properties.osmId,
      tags: mergedTags,
    });
  }

  return index;
}

/**
 * 为 building relation 汇总 outline 引用与可继承标签，供最终 relation feature 提升信息。
 * @param relationOutlineIndex 基于原始 raw relation 提前提取出的成员索引
 * @param featureTagIndex 已转换 polygon feature 的标签索引
 * @param rawWayTagIndex 原始 way tags 索引
 * @returns 以 relation id 为键的 building relation 信息索引
 */
function buildIndexBuildingRelation(
  relationOutlineIndex: Map<number, BuildingRelationInfo>,
  featureTagIndex: Map<string, FeatureTagSource>,
  rawWayTagIndex: Map<number, RawWayElement>,
): Map<number, BuildingRelationInfo> {
  const relationIndex = new Map<number, BuildingRelationInfo>();

  for (const buildingRelation of relationOutlineIndex.values()) {
    const outlineMembers = buildingRelation.outlineMembers
      .map((member) => ({
        member,
        tags: mergeTagsPreferPrimary(
          featureTagIndex.get(`${member.type}/${member.ref}`)?.tags || {},
          rawWayTagIndex.get(member.ref)?.tags || {},
        ),
      }));

    const outlineReferences = outlineMembers.map<OutlineReference>(({ member, tags }) => ({
        osmType: member.type,
        osmId: member.ref,
        role: member.role,
        rel: buildingRelation.rel,
        reltags: buildingRelation.reltags,
        tags,
      }));
    const inheritedTags = outlineMembers.reduce<Record<string, string>>(
      (tags, outlineMember) => mergeTagsPreferPrimary(tags, outlineMember.tags),
      {},
    );

    relationIndex.set(buildingRelation.rel, {
      rel: buildingRelation.rel,
      reltags: buildingRelation.reltags,
      outlineMembers: buildingRelation.outlineMembers,
      outlineReferences,
      inheritedTags: mergeTagsPreferPrimary(buildingRelation.reltags, inheritedTags),
    });
  }

  return relationIndex;
}

/**
 * 建立面状 relation 的 id 索引，后续用于过滤重复的成员 polygon / outline line。
 * @param features 全量规整化候选地物
 * @returns 需要优先保留的 area relation id 集合
 */
function buildAreaRelationIndex(features: NormalizedFeature[]): Set<number> {
  const relationIds = new Set<number>();

  for (const feature of features) {
    if (isAreaRelationFeature(feature)) {
      relationIds.add(feature.properties.osmId);
    }
  }

  return relationIds;
}

/**
 * 建立线状 relation 的 id 索引，后续用于去掉已被 relation 本体覆盖的成员 way。
 * @param features 全量规整化候选地物
 * @returns 线状 relation id 集合
 */
function buildLineRelationIndex(features: NormalizedFeature[]): Set<number> {
  const relationIds = new Set<number>();

  for (const feature of features) {
    if (isLineRelationFeature(feature)) {
      relationIds.add(feature.properties.osmId);
    }
  }

  return relationIds;
}

//#region 过滤函数

/**
 * 判断当前 feature 是否是抽象线状 relation 本体；这类 relation 本身不直接落库。
 * @param feature 待判断地物
 * @param relationLineIds 线状 relation id 集合
 * @returns 是否为抽象 line relation
 */
function isAbstractLineRelationFeature(feature: NormalizedFeature, relationLineIds: Set<number>): boolean {
  return feature.properties.osmType === 'relation' && relationLineIds.has(feature.properties.osmId);
}

/**
 * 判断某个 way 是否是 building relation 的 outline 成员；若是则由 relation 本体代表。
 * @param feature 待判断地物
 * @param buildingRelationIndex building relation 信息索引
 * @returns 是否为 building outline way
 */
function isBuildingRelationOutlineFeature(
  feature: NormalizedFeature,
  buildingRelationIndex: Map<number, BuildingRelationInfo>,
): boolean {
  if (feature.properties.osmType !== 'way') {
    return false;
  }

  return feature.properties.relationReferences.some((relation) => {
    if (!buildingRelationIndex.has(relation.rel)) {
      return false;
    }

    return relation.role === 'outline';
  });
}

/**
 * 判断某个线性 way 是否只是 building relation 的 part 成员线框；这类线不应单独落库。
 * @param feature 待判断地物
 * @param buildingRelationIndex building relation 信息索引
 * @returns 是否为 building part 线地物
 */
function isBuildingPartLineFeature(
  feature: NormalizedFeature,
  buildingRelationIndex: Map<number, BuildingRelationInfo>,
): boolean {
  if (!isLinearGeometry(feature) || feature.properties.osmType !== 'way') {
    return false;
  }

  return feature.properties.relationReferences.some((relation) => {
    return buildingRelationIndex.has(relation.rel) && relation.role === 'part';
  });
}

/**
 * 判断当前 feature 是否是需要做标签提升的 building relation polygon。
 * @param feature 待判断地物
 * @param buildingRelationIndex building relation 信息索引
 * @returns 是否命中 building relation 本体
 */
function isBuildingRelationFeature(
  feature: NormalizedFeature,
  buildingRelationIndex: Map<number, BuildingRelationInfo>,
): boolean {
  return (
    isPolygonGeometry(feature)
    && feature.properties.osmType === 'relation'
    && buildingRelationIndex.has(feature.properties.osmId)
  );
}

/**
 * 判断当前 feature 是否是 building relation 的面状 part，最终由它代表复杂建筑入库。
 * @param feature 待判断地物
 * @param buildingRelationIndex building relation 信息索引
 * @returns 是否命中 building part polygon
 */
function isBuildingPartPolygonFeature(
  feature: NormalizedFeature,
  buildingRelationIndex: Map<number, BuildingRelationInfo>,
): boolean {
  if (!isPolygonGeometry(feature) || feature.properties.osmType !== 'way') {
    return false;
  }

  return feature.properties.relationReferences.some((relation) => {
    return buildingRelationIndex.has(relation.rel) && relation.role === 'part';
  });
}

/**
 * 判断 polygon way 是否已被面状 relation 本体覆盖，若是则成员本体可去掉。
 * @param feature 待判断成员地物
 * @param areaRelationIds 面状 relation id 集合
 * @returns 是否应由 relation polygon 替代该成员 polygon
 */
function isMemberPolygonCoveredByRelationPolygon(feature: NormalizedFeature, areaRelationIds: Set<number>): boolean {
  if (!isPolygonGeometry(feature) || feature.properties.osmType !== 'way') {
    return false;
  }

  return feature.properties.relationReferences.some((relation) => areaRelationIds.has(relation.rel));
}

/**
 * 判断线状 outline way 是否已被面状 relation polygon 代表，避免边界线单独落库。
 * @param feature 待判断线地物
 * @param areaRelationIds 面状 relation id 集合
 * @returns 是否应被 relation polygon 吸收
 */
function isRelationOutlineCoveredByPolygon(feature: NormalizedFeature, areaRelationIds: Set<number>): boolean {
  if (!isLinearGeometry(feature) || feature.properties.osmType !== 'way') {
    return false;
  }

  return feature.properties.relationReferences.some((relation) => {
    if (!areaRelationIds.has(relation.rel)) {
      return false;
    }

    const relationType = relation.reltags.type;
    const isAreaRelation = relationType === 'multipolygon' || relationType === 'boundary';
    const isOutlineRole = relation.role === 'outer' || relation.role === 'inner';
    return isAreaRelation && isOutlineRole;
  });
}

/**
 * 判断线状成员 way 是否已被线状 relation 本体覆盖。
 * @param feature 待判断线地物
 * @param relationLineIds 线状 relation id 集合
 * @returns 是否应被 relation line 吸收
 */
function isMemberLineCoveredByRelationLine(feature: NormalizedFeature, relationLineIds: Set<number>): boolean {
  if (!isLinearGeometry(feature) || feature.properties.osmType !== 'way') {
    return false;
  }

  return feature.properties.relationReferences.some((relation) => {
    if (!relationLineIds.has(relation.rel)) {
      return false;
    }

    const relationType = relation.reltags.type;
    return relationType === 'route' || relationType === 'waterway';
  });
}

//#region 帮助函数

/**
 * 根据 feature 挂载的 building relation，引出所有需要保留的 outline 引用。
 * @param relations feature 当前保留的 relation 引用
 * @param buildingRelationIndex building relation 信息索引
 * @returns 该 feature 关联到的 outline 引用集合
 */
function collectBuildingOutlineReferences(
  relations: RelationReference[],
  buildingRelationIndex: Map<number, BuildingRelationInfo>,
): OutlineReference[] {
  const collected = relations.flatMap((relation) => {
    const buildingRelation = buildingRelationIndex.get(relation.rel);
    if (!buildingRelation) {
      return [];
    }

    return buildingRelation.outlineReferences;
  });

  return dedupeOutlineReferences(collected);
}

/**
 * 对 building outline 引用去重，避免同一 outline 被重复挂到最终 feature 上。
 * @param references 原始 outline 引用数组
 * @returns 去重后的 outline 引用
 */
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

/**
 * 为 building relation 本体和 part polygon 补齐继承标签，保证后续分类与展示能拿到完整信息。
 * @param feature 当前待收口的 feature
 * @param buildingRelationIndex building relation 信息索引
 * @returns 合并好 tags 的结果；非 building relation 原样返回
 */
function elevateBuildingTags(
  feature: NormalizedFeature,
  buildingRelationIndex: Map<number, BuildingRelationInfo>,
): Record<string, string> {
  const buildingRelations = feature.properties.relationReferences
    .filter((relation) => buildingRelationIndex.has(relation.rel));

  if (!isBuildingRelationFeature(feature, buildingRelationIndex) && buildingRelations.length === 0) {
    return feature.properties.tags;
  }

  if (isBuildingRelationFeature(feature, buildingRelationIndex)) {
    const buildingRelation = buildingRelationIndex.get(feature.properties.osmId);
    if (!buildingRelation) {
      return feature.properties.tags;
    }

    return mergeTagsPreferPrimary(feature.properties.tags, buildingRelation.inheritedTags);
  }

  if (!isBuildingPartPolygonFeature(feature, buildingRelationIndex)) {
    return feature.properties.tags;
  }

  return buildingRelations.reduce<Record<string, string>>((tags, relation) => {
    const buildingRelation = buildingRelationIndex.get(relation.rel);
    if (!buildingRelation) {
      return tags;
    }

    return mergeTagsPreferPrimary(tags, buildingRelation.inheritedTags);
  }, feature.properties.tags);
}

/**
 * 在“目标标签为空时才补值”的规则下合并两份 tags，前者优先级更高。
 * @param primary 优先保留的标签来源
 * @param fallback 仅在主标签缺失时用于补洞的标签来源
 * @returns 合并后的 tags
 */
function mergeTagsPreferPrimary(
  primary: Record<string, string>,
  fallback: Record<string, string>,
): Record<string, string> {
  const merged = { ...primary };
  for (const [key, value] of Object.entries(fallback)) {
    if (!(key in merged)) {
      merged[key] = value;
    }
  }

  return merged;
}

//#region 清洗函数

/**
 * 清洗 osmtogeojson 产出的 relation 引用数组，统一成内部使用的 RelationReference。
 * @param value 原始 relations 字段
 * @returns 仅包含合法 relation 引用的数组
 */
function toRelationReferences(value: unknown): RelationReference[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.role !== 'string' || typeof entry.rel !== 'number') {
      return [];
    }

    return [
      {
        role: entry.role,
        rel: entry.rel,
        reltags: toStringRecord(entry.reltags),
      },
    ];
  });
}

/**
 * 把 relation members 清洗成内部使用的轻量结构，只保留合法成员。
 * @param value 原始 members 字段
 * @returns 统一后的成员数组
 */
function toRelationMembers(value: unknown): RawRelationMember[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {

    if (
      !isRecord(entry)
      || typeof entry.type !== 'string'
      || typeof entry.ref !== 'number'
      || typeof entry.role !== 'string'
    ) {
      return [];
    }

    return [{
      type: entry.type,
      ref: entry.ref,
      role: entry.role,
    }];
  });
}

/**
 * 把未知对象清洗成 meta 用的轻量记录，只保留 string / number。
 * @param value 原始 meta 结构
 * @returns 适合落库和后续展示的 meta 对象
 */
function toMetaRecord(value: unknown): Record<string, string | number> {
  if (!isRecord(value)) {
    return {};
  }

  const entries: Array<[string, string | number]> = [];
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'number' || typeof entry === 'string') {
      entries.push([key, entry]);
    }
  }
  return Object.fromEntries(entries);
}

/**
 * 把未知对象清洗成 `Record<string, string>`，过滤掉所有非字符串值。
 * @param value 原始 tags / reltags 等结构
 * @returns 只保留字符串键值对后的结果
 */
function toStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }

  const entries: Array<[string, string]> = [];
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') {
      entries.push([key, entry]);
    }
  }
  return Object.fromEntries(entries);
}

/**
 * 判断一个未知值是否为普通对象，供后续做安全的字段读取与类型收窄。
 * @param value 任意待判断值
 * @returns 仅当值为非 null、非数组的对象时返回 true
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

//#region 判断函数

/**
 * 判断一个 relation feature 是否代表线状 relation 本体。
 * @param feature 待判断地物
 * @returns 仅当 line relation 且 type 为 route / waterway 时返回 true
 */
function isLineRelationFeature(feature: NormalizedFeature): boolean {
  if (!isLinearGeometry(feature) || feature.properties.osmType !== 'relation') {
    return false;
  }

  const relationType = feature.properties.tags.type;
  return relationType === 'route' || relationType === 'waterway';
}

/**
 * 判断一个 relation feature 是否代表面状 relation 本体。
 * @param feature 待判断地物
 * @returns 仅当 polygon relation 且 type 为 multipolygon / boundary 时返回 true
 */
function isAreaRelationFeature(feature: NormalizedFeature): boolean {
  if (!isPolygonGeometry(feature) || feature.properties.osmType !== 'relation') {
    return false;
  }

  const relationType = feature.properties.tags.type;
  return relationType === 'multipolygon' || relationType === 'boundary';
}

/**
 * 判断当前地物是否为面几何，供建筑 / 区域 relation 的后续处理复用。
 * @param feature 待判断地物
 * @returns 是否为 Polygon / MultiPolygon
 */
function isPolygonGeometry(feature: NormalizedFeature): boolean {
  return feature.geometry.type === 'Polygon' || feature.geometry.type === 'MultiPolygon';
}

/**
 * 判断当前地物是否为线性几何，供路线 relation 和成员去重时复用。
 * @param feature 待判断地物
 * @returns 是否为 LineString / MultiLineString
 */
function isLinearGeometry(feature: NormalizedFeature): boolean {
  return feature.geometry.type === 'LineString' || feature.geometry.type === 'MultiLineString';
}
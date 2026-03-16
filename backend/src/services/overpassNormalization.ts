import osmtogeojson from 'osmtogeojson';
import type { Feature, FeatureCollection, Geometry } from 'geojson';

export interface NormalizedOverpassRequest {
  lat: number;
  lon: number;
  radius: number;
  includeRaw?: boolean; // debug 用，用来检查规整化前的 overpass api 返回结果
}

export interface RelationReference {
  role: string;
  rel: number;
  reltags: Record<string, string>;
}

export interface OutlineReference {
  osmType: string;
  osmId: number;
  role: string;
  rel: number;
  reltags: Record<string, string>;
  tags: Record<string, string>;
}

export interface ContainedPoi {
  osmType: string;
  osmId: number;
  tags: Record<string, string>;
  relations: RelationReference[];
  meta: Record<string, string | number>;
  tainted: boolean;
  coordinate: [number, number];
  sourceFeatureId: string;
}

export interface NormalizedFeatureProperties {
  osmType: string;
  osmId: number;
  tags: Record<string, string>;
  relations: RelationReference[];
  outlineReferences?: OutlineReference[];
  meta: Record<string, string | number>;
  tainted: boolean;
  containedPois?: ContainedPoi[];
}

export type NormalizedFeature = Feature<Geometry, NormalizedFeatureProperties>;
export type NormalizedFeatureCollection = FeatureCollection<Geometry, NormalizedFeatureProperties>;

export interface NormalizationDiagnostics {
  rawElementCounts: Record<string, number>;
  totalRawElements: number;
  totalConvertedFeatures: number;
  totalNormalizedFeatures: number;
  featureCountsByGeometryType: Record<string, number>;
  taintedFeatures: number;
  skippedFeaturesWithoutGeometry: number;
  filteredRelationOutlineFeatures: number;
  filteredRelationMemberLineFeatures: number;
}

export interface OverpassJsonResponse {
  version?: number;
  generator?: string;
  osm3s?: {
    timestamp_osm_base?: string;
    copyright?: string;
  };
  elements: Array<{ type?: string; id?: number; tags?: unknown; members?: unknown }>;
}

type RawFeatureProperties = {
  type?: unknown;
  id?: unknown;
  tags?: unknown;
  relations?: unknown;
  meta?: unknown;
  tainted?: unknown;
};

/**
 * 判断一个未知值是否为普通对象，供后续做安全的字段读取与类型收窄。
 * @param value 任意待判断值
 * @returns 仅当值为非 null、非数组的对象时返回 true
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
 * 把单个 GeoJSON feature 规整成内部统一结构；没有 geometry 的对象直接丢弃。
 * @param feature osmtogeojson 产出的原始 feature
 * @returns 规整后的 feature；若缺失几何则返回 null
 */
function normalizeFeature(feature: Feature): NormalizedFeature | null {
  if (!feature.geometry) {
    return null;
  }

  const properties = (feature.properties || {}) as RawFeatureProperties;
  const osmType = typeof properties.type === 'string' ? properties.type : 'unknown';
  const osmId = typeof properties.id === 'number' ? properties.id : Number.NaN;

  return {
    type: 'Feature',
    id: feature.id ? String(feature.id) : `${osmType}/${osmId}`,
    geometry: feature.geometry,
    properties: {
      osmType,
      osmId,
      tags: toStringRecord(properties.tags),
      relations: toRelationReferences(properties.relations),
      outlineReferences: [],
      meta: toMetaRecord(properties.meta),
      tainted: Boolean(properties.tainted),
    },
  };
}

/**
 * 判断当前地物是否为线性几何，供路线 relation 和成员去重时复用。
 * @param feature 待判断地物
 * @returns 是否为 LineString / MultiLineString
 */
function isLinearGeometry(feature: NormalizedFeature): boolean {
  return feature.geometry.type === 'LineString' || feature.geometry.type === 'MultiLineString';
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

type BuildingRelationInfo = {
  rel: number;
  reltags: Record<string, string>;
  outlineReferences: OutlineReference[];
  inheritedTags: Record<string, string>;
};

/**
 * 判断原始 overpass element 是否至少是个对象，以便安全读取 way 字段。
 * @param value 待判断值
 * @returns 是否可视为原始 way element
 */
function isWayElement(value: unknown): value is { type?: unknown; id?: unknown; tags?: unknown } {
  return isRecord(value);
}

/**
 * 判断原始 overpass element 是否至少是个对象，以便安全读取 relation 字段。
 * @param value 待判断值
 * @returns 是否可视为原始 relation element
 */
function isRelationElement(value: unknown): value is { type?: unknown; id?: unknown; tags?: unknown; members?: unknown } {
  return isRecord(value);
}

/**
 * 从原始 overpass 数据里建立 way tags 索引，供 building relation 回查 outline 标签。
 * @param raw overpass 原始响应
 * @returns 以 way id 为键的 tags 索引
 */
function buildRawWayTagIndex(raw: OverpassJsonResponse): Map<number, RawWayElement> {
  const index = new Map<number, RawWayElement>();

  for (const element of raw.elements) {
    if (!isWayElement(element) || element.type !== 'way' || typeof element.id !== 'number') {
      continue;
    }

    index.set(element.id, {
      type: 'way',
      id: element.id,
      tags: toStringRecord(element.tags),
    });
  }

  return index;
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

/**
 * 为 building relation 汇总 outline 引用与可继承标签，供最终 relation feature 提升信息。
 * @param raw overpass 原始响应
 * @param rawWayTagIndex 原始 way tags 索引
 * @returns 以 relation id 为键的 building relation 信息索引
 */
function buildBuildingRelationIndex(raw: OverpassJsonResponse, rawWayTagIndex: Map<number, RawWayElement>): Map<number, BuildingRelationInfo> {
  const relationIndex = new Map<number, BuildingRelationInfo>();

  for (const element of raw.elements) {
    if (!isRelationElement(element) || element.type !== 'relation' || typeof element.id !== 'number') {
      continue;
    }

    const reltags = toStringRecord(element.tags);
    if (reltags.type !== 'building') {
      continue;
    }

    const outlineMembers = toRelationMembers(element.members)
      .filter((member) => member.type === 'way' && member.role === 'outline')
      .map((member) => ({
        member,
        tags: rawWayTagIndex.get(member.ref)?.tags || {},
      }));
    const outlineReferences = outlineMembers.map<OutlineReference>(({ member, tags }) => ({
        osmType: member.type,
        osmId: member.ref,
        role: member.role,
        rel: element.id as number,
        reltags,
        tags,
      }));
    const inheritedTags = outlineMembers.reduce<Record<string, string>>(
      (tags, outlineMember) => mergeTagsPreferPrimary(tags, outlineMember.tags),
      {},
    );

    relationIndex.set(element.id, {
      rel: element.id,
      reltags,
      outlineReferences,
      inheritedTags: mergeTagsPreferPrimary(reltags, inheritedTags),
    });
  }

  return relationIndex;
}

/**
 * 从 relations 数组里剔除满足条件的 relation，避免重复语义继续向下游传播。
 * @param relations 原 relation 引用数组
 * @param predicate 需要被移除的条件
 * @returns 过滤后的 relation 引用数组
 */
function stripRelations(
  relations: RelationReference[],
  predicate: (relation: RelationReference) => boolean,
): RelationReference[] {
  return relations.filter((relation) => !predicate(relation));
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
 * 判断 polygon way 是否已被面状 relation 本体覆盖，若是则成员本体可去掉。
 * @param feature 待判断成员地物
 * @param areaRelationIds 面状 relation id 集合
 * @returns 是否应由 relation polygon 替代该成员 polygon
 */
function isMemberPolygonCoveredByRelationPolygon(feature: NormalizedFeature, areaRelationIds: Set<number>): boolean {
  if (!isPolygonGeometry(feature) || feature.properties.osmType !== 'way') {
    return false;
  }

  return feature.properties.relations.some((relation) => areaRelationIds.has(relation.rel));
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

  return feature.properties.relations.some((relation) => {
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

  return feature.properties.relations.some((relation) => {
    if (!relationLineIds.has(relation.rel)) {
      return false;
    }

    const relationType = relation.reltags.type;
    return relationType === 'route' || relationType === 'waterway';
  });
}

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

  return feature.properties.relations.some((relation) => {
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

  return feature.properties.relations.some((relation) => {
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
 * 为 building relation 本体补齐 outline 带来的继承标签，保证后续分类与展示能拿到完整信息。
 * @param feature 当前待收口的 feature
 * @param buildingRelationIndex building relation 信息索引
 * @returns 合并好 tags 的结果；非 building relation 原样返回
 */
function elevateBuildingRelationTags(
  feature: NormalizedFeature,
  buildingRelationIndex: Map<number, BuildingRelationInfo>,
): Record<string, string> {
  if (!isBuildingRelationFeature(feature, buildingRelationIndex)) {
    return feature.properties.tags;
  }

  const buildingRelation = buildingRelationIndex.get(feature.properties.osmId);
  if (!buildingRelation) {
    return feature.properties.tags;
  }

  return mergeTagsPreferPrimary(feature.properties.tags, buildingRelation.inheritedTags);
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
  const filteredRelations = stripRelations(feature.properties.relations, (relation) => {
    return relationLineIds.has(relation.rel);
  });
  const outlineReferences = isBuildingRelationFeature(feature, buildingRelationIndex)
    ? buildingRelationIndex.get(feature.properties.osmId)?.outlineReferences || []
    : isPolygonGeometry(feature)
      ? collectBuildingOutlineReferences(filteredRelations, buildingRelationIndex)
      : [];
  const tags = elevateBuildingRelationTags(feature, buildingRelationIndex);

  return {
    ...feature,
    properties: {
      ...feature.properties,
      tags,
      relations: filteredRelations,
      outlineReferences,
    },
  };
}

/**
 * 生成专门用于规整化函数的 Overpass Query，无任何过滤且启用 skel 参数。
 * @param request 经纬度与范围
 * @returns 生成的 Overpass Query
 */
export function buildJsonSkelOverpassQuery(request: NormalizedOverpassRequest): string {
  return [
    '[out:json][timeout:25];',
    `nwr(around:${request.radius},${request.lat},${request.lon});`,
    'out body geom;',
    '>;',
    'out skel geom;',
  ].join('\n');
}

/**
 * relation 本体优先保留，其组成成员会在这里被规整掉，避免重复落库。
 * @param raw 规整化之前的 osm 数据
 * @returns 规整化后的地物数据
 */
export function convertOverpassToNormalizedFeatures(raw: OverpassJsonResponse): NormalizedFeature[] {
  const converted = osmtogeojson(raw, { flatProperties: false }) as FeatureCollection;
  const normalizedCandidates = converted.features.map((feature) => normalizeFeature(feature));
  const normalizedFeatures = normalizedCandidates.filter((feature): feature is NormalizedFeature => feature !== null);
  const rawWayTagIndex = buildRawWayTagIndex(raw);
  const buildingRelationIndex = buildBuildingRelationIndex(raw, rawWayTagIndex);
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
    })
    .map((feature) => finalizeFeature(feature, lineRelationIds, buildingRelationIndex));
}

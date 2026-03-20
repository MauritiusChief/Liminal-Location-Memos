import { generateReplyWithSystemPrompt } from './llm.js';
import {
  buildProjectedSceneSummary,
  DEFAULT_LARGE_DESCRIPTION_SUMMARY_MODE,
  DEFAULT_SMALL_DESCRIPTION_SUMMARY_MODE,
} from './sceneSummaryService.js';
import {
  findActiveLargeDescription,
  findNearbySmallDescriptions,
  findReusableSmallDescription,
  insertLargeDescription,
  insertSmallDescription,
} from './sceneDescriptionRepository.js';
import type {
  ActiveLevelSchema,
  AreaSummary,
  BuildingLevelSchemaDefinition,
  BuildingSchema,
  BuildingSchemaRoom,
  BuildingSchemaRoomEntry,
  BuildingSchemaSubRoom,
  BuildingSchemaSuiteRoom,
  BuildingSummary,
  GamePosition,
  LevelDescriptionRecord,
  LineSummary,
  LoadedGameSession,
  PlayerIndoorLocation,
  LargeDescriptionRecord,
  SceneContext,
  SmallDescriptionRecord,
} from '../types/game.js';
import { buildGameSystemPrompt, styleRule } from './sharedDefaultSysPromptPart.js';

export async function ensureLargeDescription(
  sceneContext: SceneContext,
  session: LoadedGameSession,
): Promise<LargeDescriptionRecord> {
  // 大描述优先复用；只有当前位置不在任何已有描述的有效半径内时才调用 LLM 生成。
  const existing = await findActiveLargeDescription(session, sceneContext.position);
  console.log('[DEBUG] ensureLargeDescription() - reuse result', {
    reused: existing !== null,
    descriptionId: existing?.id ?? null,
    effectiveRadiusM: existing?.effectiveRadiusM ?? null,
  });

  if (existing) {
    return existing;
  }

  console.log('[DEBUG] ensureLargeDescription() - generateReplyWithSystemPrompt() call');
  const conciseFarSummary = await buildProjectedSceneSummary(
    sceneContext.position,
    DEFAULT_LARGE_DESCRIPTION_SUMMARY_MODE,
    'game',
  );
  const generated = await generateReplyWithSystemPrompt(
    [
      '你是一个环境叙述生成器。你的任务是将结构化的地理环境数据转换为用于文字探索游戏的环境描述。',
      '输入是程序根据 OpenStreetMap 场景数据生成的确定性摘要，分为四个距离层级：',
      '0. 0~30 米\n使用一个边长 5米的 12 × 12 的网格表示，玩家位于第6、7行与第6、7列这四个格子的边界的交叉处。\n每个格子代表玩家周围约数米范围内的具体地物或结构，反映非常近距离的空间关系。',
      '1. 30~100 米\n使用极坐标描述周围较近的建筑以及其他要素。',
      '2. 100~300 米\n使用极坐标描述更远的建筑以及其他要素。',
      '3. 300 米~1 公里\n使用极坐标描述视野尽头的建筑以及其他要素。',
      styleRule,
      '叙述视角：\n纯客观视角，禁止提及人称\n',
      '描述顺序：',
      '按距离由近到远组织描述',
      '* 首先描述 0–30 米范围内最明显的物体或空间结构',
      '* 然后描述 30–100 米范围',
      '* 再描述 100–300 米范围',
      '* 最后简要提到远处（300 米–1 公里）的地标或环境轮廓',
    ].join('\n'),
    conciseFarSummary,
    { snapshotType: 'scene-large' },
  );
  console.log('[DEBUG] ensureLargeDescription() - generateReplyWithSystemPrompt() return');

  return insertLargeDescription(session, {
    position: sceneContext.position,
    descriptionText: generated.reply.trim(),
  });
}

export async function ensureSmallDescription(
  sceneContext: SceneContext,
  session: LoadedGameSession,
): Promise<SmallDescriptionRecord> {
  // 小描述也是“先查再生”，只是生成时会额外参考周边小描述的远距可见细节。
  const existing = await findReusableSmallDescription(session, sceneContext.position);
  console.log('[DEBUG] ensureSmallDescription() - reuse result', {
    reused: existing !== null,
    descriptionId: existing?.id ?? null,
    effectiveRadiusM: existing?.effectiveRadiusM ?? null,
  });

  if (existing) {
    return existing;
  }

  console.log('[DEBUG] ensureSmallDescription() - generateSmallDescription() call');
  const nearby = await findNearbySmallDescriptions(session, sceneContext.position, 200);
  const generated = await generateSmallDescription(sceneContext, nearby);
  console.log('[DEBUG] ensureSmallDescription() - generateSmallDescription() return');
  return insertSmallDescription(session, {
    position: sceneContext.position,
    descriptionText: generated.descriptionText,
    farVisibleNotes: generated.farVisibleNotes,
  });
}

export async function ensureBuildingSchema(
  input: {
    currentBuildings: BuildingSummary[];
    currentAreas: AreaSummary[];
    nearbyLines: LineSummary[];
  },
  session: LoadedGameSession,
): Promise<Record<string, BuildingSchema>> {
  // 建筑 schema 以 buildingId 为键缓存到存档中。
  // 一次生成面向“当前位置命中的整组建筑”，这样同 relation 的 building parts 只触发一次 LLM。
  const buildingIds = input.currentBuildings.map((building) => building.buildingId);
  if (buildingIds.length === 0) {
    return {};
  }

  const missingBuildingIds = buildingIds.filter((buildingId) => !session.save.buildingSchemas[buildingId]);
  if (missingBuildingIds.length === 0) {
    return Object.fromEntries(buildingIds.map((buildingId) => [buildingId, session.save.buildingSchemas[buildingId]]));
  }

  const generated = await generateReplyWithSystemPrompt(
    buildGameSystemPrompt.trim(),
    JSON.stringify({
      currentBuildings: input.currentBuildings,
      currentAreas: input.currentAreas,
      nearbyLines: input.nearbyLines,
    }, null, 2),
    { snapshotType: 'scene-building' },
  );
  const parsed = parseBuildingSchemaJson(generated.reply, buildingIds);

  for (const [buildingId, schema] of Object.entries(parsed)) {
    session.save.buildingSchemas[buildingId] = schema;
  }

  return Object.fromEntries(buildingIds.map((buildingId) => [buildingId, session.save.buildingSchemas[buildingId]]));
}

export async function ensureLevelDescription(
  input: {
    buildingId: string;
    level: number;
    buildingSchema: BuildingSchema;
    activeLevelSchema: ActiveLevelSchema;
    currentBuildings: BuildingSummary[];
    currentAreas: AreaSummary[];
    nearbyLines: LineSummary[];
    isTopFloor: boolean;
  },
  session: LoadedGameSession,
): Promise<LevelDescriptionRecord> {
  // 楼层描述按“buildingId + level”缓存。
  // 顶楼允许在描述里保留一些可见的外部环境暗示，其他楼层严格聚焦室内。
  const existing = session.save.levelDescriptions[buildLevelDescriptionKey(input.buildingId, input.level)];
  if (existing) {
    return existing;
  }

  const generated = await generateReplyWithSystemPrompt(
    [
      '你是一个文字探索游戏中的建筑楼层环境描述生成器。',
      '你会收到一个 JSON，其中包含当前建筑、建筑完整楼层结构、当前所在楼层结构、周边区域和附近线性要素。',
      '你的任务是只描述当前这一层能够被体验到的内部环境。',
      input.isTopFloor
        ? '当前楼层是顶楼。你可以在描述中保留一些通过窗户、露台或边缘位置能观察到的外部环境暗示，但主体仍然是楼层内部。'
        : '当前楼层不是顶楼。请只聚焦这一层的内部环境，不要补写楼外大场景。',
      styleRule,
      '叙述视角：\n纯客观视角，禁止提及人称\n',
      '输出格式：只输出一段或两段自然语言描述，不要输出 JSON，不要加标题。',
    ].join('\n'),
    JSON.stringify({
      buildingId: input.buildingId,
      buildingSchema: input.buildingSchema,
      activeLevelSchema: input.activeLevelSchema,
      currentBuildings: input.currentBuildings,
      currentAreas: input.currentAreas,
      nearbyLines: input.nearbyLines,
      isTopFloor: input.isTopFloor,
    }, null, 2),
    { snapshotType: 'scene-level' },
  );

  const now = new Date().toISOString();
  const record: LevelDescriptionRecord = {
    buildingId: input.buildingId,
    level: input.level,
    descriptionText: generated.reply.trim(),
    createdAt: now,
    updatedAt: now,
  };
  session.save.levelDescriptions[buildLevelDescriptionKey(input.buildingId, input.level)] = record;
  return record;
}

export function filterFarVisibleSmallDescriptions(
  records: SmallDescriptionRecord[],
  position: GamePosition,
): SmallDescriptionRecord[] {
  // 这里专门做一层过滤，确保真正喂给后续 prompt 的只有 farVisibleNotes，
  // 不会把别处的小描述全文直接混入当前上下文。
  return records
    .filter((record) => record.farVisibleNotes && record.farVisibleNotes.trim().length > 0)
    .map((record) => ({
      ...record,
      distanceMeters: record.distanceMeters ?? approximateDistanceMeters(position, record.center),
    }))
    .sort((left, right) => (left.distanceMeters || 0) - (right.distanceMeters || 0));
}

async function generateSmallDescription(
  sceneContext: SceneContext,
  nearbySmallDescriptions: SmallDescriptionRecord[],
): Promise<{ descriptionText: string; farVisibleNotes: string | null }> {
  // 小描述生成时要求模型同时返回两部分：
  // 1. descriptionText：给玩家/首页看的自然语言
  // 2. farVisibleNotes：仅给其他小描述复用的远距细节
  const visibleNotes = nearbySmallDescriptions
    .flatMap((record) => (record.farVisibleNotes ? [`- ${record.farVisibleNotes}`] : []))
    .join('\n');
  const conciseNearSummary = await buildProjectedSceneSummary(
    sceneContext.position,
    DEFAULT_SMALL_DESCRIPTION_SUMMARY_MODE,
    'game',
  );
  const generated = await generateReplyWithSystemPrompt(
    [
      '你是一个文字探索游戏中的局部环境描述生成器。',
      '你会根据程序生成的确定性场景摘要，输出一段局部环境描述。',
      '同时你还需要输出一段“本地细节中200米外仍可见的细节的笔记”，供其他邻近描述复用。',
      '输出必须是 JSON 对象，格式为 {"descriptionText":"...","farVisibleNotes":"..."}。',
      'descriptionText 指代的是站在原地，环视周围可以看到的近处与远处的细节。',
      'farVisibleNotes 指代的是假如视角移动到了200米外，在目前场景摘要内所包含的内容中，有哪些是依然能被看到的。比方说可见的轮廓、显著建筑体量、地标等。',
      '如果提供了“供参考的邻近描述细节”，那么 descriptionText 将不仅仅只有近场微观细节如招牌、门牌、30米内观察才能知道的信息等，还需要包含这些邻近描述的细节。',
      '这些其实就是其他邻近描述中的 farVisibleNotes，是用来填充之前提到的“看到的近处与远处的细节”中的“远处的细节”的。',
      styleRule,
      '叙述视角：\n纯客观视角，禁止提及人称\n',
      visibleNotes ? `供参考的邻近描述细节：\n${visibleNotes}` : '当前没有可参考的供参考的邻近描述细节。',
    ].join('\n'),
    conciseNearSummary,
    { snapshotType: 'scene-small' },
  );

  return parseDescriptionJson(generated.reply);
}

function parseDescriptionJson(input: string): { descriptionText: string; farVisibleNotes: string | null } {
  // 模型可能会夹带说明文字，因此这里做宽松解析：
  // 能提取 JSON 就提取，提取失败就把整段回复当 descriptionText。
  const start = input.indexOf('{');
  const end = input.lastIndexOf('}');
  const fallback = {
    descriptionText: input.trim(),
    farVisibleNotes: null,
  };

  if (start < 0 || end <= start) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(input.slice(start, end + 1)) as {
      descriptionText?: unknown;
      farVisibleNotes?: unknown;
    };

    return {
      descriptionText: typeof parsed.descriptionText === 'string' && parsed.descriptionText.trim()
        ? parsed.descriptionText.trim()
        : fallback.descriptionText,
      farVisibleNotes: typeof parsed.farVisibleNotes === 'string' && parsed.farVisibleNotes.trim()
        ? parsed.farVisibleNotes.trim()
        : null,
    };
  } catch {
    return fallback;
  }
}

function approximateDistanceMeters(left: GamePosition, right: GamePosition): number {
  // 这里只用于 UI 排序和补充展示，不要求 GIS 级精度。
  const latFactor = 111320;
  const lonFactor = Math.cos((left.lat * Math.PI) / 180) * 111320;
  const dLat = (right.lat - left.lat) * latFactor;
  const dLon = (right.lon - left.lon) * lonFactor;
  return Math.sqrt((dLat * dLat) + (dLon * dLon));
}

export function resolveActiveLevelSchema(
  buildingSchema: BuildingSchema,
  level: number,
): ActiveLevelSchema | null {
  for (const [schemaKey, definition] of Object.entries(buildingSchema)) {
    const [start, end = start] = definition.span;
    if (level >= start && level <= end) {
      return {
        schemaKey,
        span: definition.span,
        rooms: definition.rooms,
      };
    }
  }

  return null;
}

export function resolveIndoorEntranceLocation(
  buildingId: string,
  buildingSchema: BuildingSchema,
): PlayerIndoorLocation {
  // 入口房间选择规则：
  // 从所有 span 展开的楼层中，寻找 access=entrance 的房间，并优先取层数最低的一处。
  let bestMatch: { level: number; roomKey: string } | null = null;

  for (const definition of Object.values(buildingSchema)) {
    const [start, end = start] = definition.span;
    for (let level = start; level <= end; level += 1) {
      for (const [roomKey, room] of Object.entries(definition.rooms)) {
        if (isSingleRoomEntry(room) && room.access === 'entrance') {
          if (!bestMatch || level < bestMatch.level) {
            bestMatch = { level, roomKey };
          }
        }
      }
    }
  }

  if (!bestMatch) {
    throw new Error(`Building schema for ${buildingId} does not contain an entrance room.`);
  }

  return {
    buildingId,
    level: bestMatch.level,
    roomKey: bestMatch.roomKey,
  };
}

export function isTopFloorOfBuilding(
  buildingSchema: BuildingSchema,
  level: number,
): boolean {
  // “顶楼”只看正楼层中的最高层；地下层不会被视作顶楼。
  const maxLevel = Object.values(buildingSchema).reduce<number | null>((currentMax, definition) => {
    const [, end = definition.span[0]] = definition.span;
    if (end <= 0) {
      return currentMax;
    }

    return currentMax === null ? end : Math.max(currentMax, end);
  }, null);

  return maxLevel !== null && level === maxLevel;
}

function parseBuildingSchemaJson(
  input: string,
  expectedBuildingIds: string[],
): Record<string, BuildingSchema> {
  const parsed = parseLooseJsonObject(input);
  if (!parsed) {
    throw new Error('Failed to parse building schema JSON.');
  }

  const resultEntries = expectedBuildingIds.flatMap((buildingId) => {
    const rawSchema = parsed[buildingId];
    const schema = normalizeBuildingSchema(rawSchema);
    return schema ? [[buildingId, schema] as const] : [];
  });

  if (resultEntries.length !== expectedBuildingIds.length) {
    throw new Error('Building schema JSON missing one or more requested building ids.');
  }

  return Object.fromEntries(resultEntries);
}

function normalizeBuildingSchema(input: unknown): BuildingSchema | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }

  const entries = Object.entries(input as Record<string, unknown>).flatMap(([schemaKey, definition]) => {
    const normalized = normalizeLevelSchemaDefinition(definition);
    return normalized ? [[schemaKey, normalized] as const] : [];
  });

  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

function normalizeLevelSchemaDefinition(input: unknown): BuildingLevelSchemaDefinition | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }

  const candidate = input as Record<string, unknown>;
  const span = normalizeSpan(candidate.span);
  const rooms = normalizeRooms(candidate.rooms);

  if (!span || !rooms || Object.keys(rooms).length === 0) {
    return null;
  }

  return {
    span,
    rooms,
  };
}

function normalizeSpan(input: unknown): [number] | [number, number] | null {
  if (!Array.isArray(input) || (input.length !== 1 && input.length !== 2)) {
    return null;
  }

  const numeric = input.map((item) => Number(item));
  if (!numeric.every((item) => Number.isInteger(item))) {
    return null;
  }

  if (numeric.length === 1) {
    return [numeric[0]];
  }

  return [numeric[0], numeric[1]];
}

function normalizeRooms(input: unknown): Record<string, BuildingSchemaRoomEntry> | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }

  const entries = Object.entries(input as Record<string, unknown>).flatMap(([roomKey, room]) => {
    const normalized = normalizeRoomEntry(room);
    return normalized ? [[roomKey, normalized] as const] : [];
  });

  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

function normalizeRoomEntry(input: unknown): BuildingSchemaRoomEntry | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }

  const candidate = input as Record<string, unknown>;
  const count = Number(candidate.count);
  const desc = typeof candidate.desc === 'string' ? candidate.desc.trim() : '';

  if (!Number.isFinite(count) || count <= 0 || !desc) {
    return null;
  }

  if ('subRooms' in candidate) {
    const subRooms = normalizeSubRooms(candidate.subRooms);
    if (!subRooms) {
      return null;
    }

    return {
      count,
      desc,
      subRooms,
    } satisfies BuildingSchemaSuiteRoom;
  }

  const access = normalizeAccess(candidate.access);
  return {
    count,
    desc,
    ...(access ? { access } : {}),
  } satisfies BuildingSchemaRoom;
}

function normalizeSubRooms(input: unknown): Record<string, BuildingSchemaSubRoom> | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }

  const entries = Object.entries(input as Record<string, unknown>).flatMap(([roomKey, room]) => {
    if (!room || typeof room !== 'object' || Array.isArray(room)) {
      return [];
    }

    const candidate = room as Record<string, unknown>;
    const count = Number(candidate.count);
    const desc = typeof candidate.desc === 'string' ? candidate.desc.trim() : '';
    if (!Number.isFinite(count) || count <= 0 || !desc) {
      return [];
    }

    return [[roomKey, {
      count,
      desc,
    } satisfies BuildingSchemaSubRoom] as const];
  });

  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

function normalizeAccess(input: unknown): BuildingSchemaRoom['access'] | null {
  if (input === 'entrance' || input === 'vertical' || input === 'internal') {
    return input;
  }

  return null;
}

function parseLooseJsonObject(input: string): Record<string, unknown> | null {
  const start = input.indexOf('{');
  const end = input.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return null;
  }

  try {
    const parsed = JSON.parse(input.slice(start, end + 1)) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }

    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function buildLevelDescriptionKey(buildingId: string, level: number): string {
  return `${buildingId}::${level}`;
}

function isSingleRoomEntry(room: BuildingSchemaRoomEntry): room is BuildingSchemaRoom {
  return !('subRooms' in room);
}

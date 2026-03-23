import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildDescriptionIndex } from './gameDescriptionIndex.js';
import { distanceBetweenCoordinates } from './geometry.js';
import type {
  ActiveLevelSchema,
  BuildingSchema,
  GameClientLevelDescription,
  GameClientLargeDescription,
  GameClientMessage,
  GameClientSmallDescription,
  GamePosition,
  GameMessage,
  GameSaveDocument,
  GameSessionSnapshotResponse,
  LevelDescriptionRecord,
  LoadedGameSession,
  LastSceneContextMeta,
  PlayerIndoorLocation,
} from '../types/game.js';

const testPosition = [39.90310484384369, -83.44964892561046]

const DEFAULT_START_POSITION: GamePosition = {
  // lat: 33.83653441683847,
  // lon: -84.34211999827654,
  lat: testPosition[0],
  lon: testPosition[1]
};

const SAVE_DIRECTORY = path.resolve(process.cwd(), 'data', 'game-saves');

// 运行时缓存 + JSON 持久化：
// 内存层负责减少重复读盘和重复建索引，JSON 层负责服务重启后的恢复。
const sessions = new Map<string, LoadedGameSession>();

export async function getOrCreateSession(sessionId?: string): Promise<LoadedGameSession> {
  if (sessionId) {
    const existing = sessions.get(sessionId);
    if (existing) {
      return existing;
    }
  }

  const nextSessionId = sessionId || randomUUID();
  const save = await loadSaveDocument(nextSessionId) || createSaveDocument(nextSessionId);
  const loadedSession: LoadedGameSession = {
    save,
    descriptionIndex: buildDescriptionIndex(save),
  };

  sessions.set(nextSessionId, loadedSession);
  return loadedSession;
}

export async function updateSession(session: LoadedGameSession): Promise<void> {
  // 统一通过这个入口回写，避免路由层直接操作缓存和文件。
  session.descriptionIndex = buildDescriptionIndex(session.save);
  sessions.set(session.save.sessionId, session);
  await persistSaveDocument(session.save);
}

export async function getSessionSnapshot(sessionId: string): Promise<GameSessionSnapshotResponse | null> {
  const session = await getOrCreateSession(sessionId);
  const activeLargeDescription = session.save.activeLargeDescriptionId
    ? session.save.largeDescriptions.find((record) => record.id === session.save.activeLargeDescriptionId) || null
    : null;
  const nearbySmallDescriptions = session.save.visibleSmallDescriptionIds
    .map((id) => session.save.smallDescriptions.find((record) => record.id === id) || null)
    .filter((record): record is NonNullable<typeof record> => record !== null)
    .map((record) => ({
      ...record,
      distanceMeters: distanceBetweenCoordinates(
        [session.save.playerPosition.lon, session.save.playerPosition.lat],
        [record.center.lon, record.center.lat],
      ),
    }))
    .sort((left, right) => left.distanceMeters - right.distanceMeters);
  const currentBuildingSchema = getCurrentBuildingSchema(session.save.buildingSchemas, session.save.playerIndoorLocation);
  const currentLevelSchema = getCurrentLevelSchema(currentBuildingSchema, session.save.playerIndoorLocation);
  const currentLevelDescription = getCurrentLevelDescription(session.save.levelDescriptions, session.save.playerIndoorLocation);

  // 若 sessionId 对应的 JSON 根本不存在，则 getOrCreateSession 会新建一个空存档。
  // 恢复接口不应该把“新建空存档”误认为成功恢复，因此这里要求至少已有历史或描述才算可恢复。
  const hasPersistedState = session.save.messageHistory.length > 0
    || session.save.largeDescriptions.length > 0
    || session.save.smallDescriptions.length > 0
    || Object.keys(session.save.buildingSchemas).length > 0
    || Object.keys(session.save.levelDescriptions).length > 0
    || session.save.playerIndoorLocation !== null;

  if (!hasPersistedState) {
    return null;
  }

  return {
    sessionId: session.save.sessionId,
    hasStarted: true,
    messages: toClientMessages(session.save.messageHistory),
    playerPosition: session.save.playerPosition,
    activeLargeDescription: toClientLargeDescription(activeLargeDescription),
    nearbySmallDescriptions: toClientSmallDescriptions(nearbySmallDescriptions),
    playerIndoorLocation: session.save.playerIndoorLocation,
    currentBuildingSchema,
    currentLevelSchema,
    currentLevelDescription: toClientLevelDescription(currentLevelDescription),
  };
}

export function updateLastSceneContextMeta(
  session: LoadedGameSession,
  meta: LastSceneContextMeta,
): void {
  session.save.lastSceneContextMeta = meta;
}

export function toClientMessages(history: GameMessage[]): GameClientMessage[] {
  const messages: GameClientMessage[] = [];

  for (const message of history) {
    if (message.role === 'user') {
      if (message.isOpeningPrompt) {
        continue;
      }

      messages.push({
        role: 'user',
        content: message.content,
      });
      continue;
    }

    if (message.role === 'assistant') {
      if (message.isToolCallMessage) {
        continue;
      }

      messages.push({
        role: 'assistant',
        content: message.content,
      });
      continue;
    }

    const toolContent = message.toolName === 'move_player'
      ? sanitizeMovePlayerToolContent(message.content)
      : message.content;

    messages.push({
      role: 'tool',
      content: toolContent,
      toolName: message.toolName,
    });
  }

  return messages;
}

export function toClientLargeDescription(
  record: { id: string; descriptionText: string } | null,
): GameClientLargeDescription | null {
  if (!record) {
    return null;
  }

  return {
    id: record.id,
    descriptionText: record.descriptionText,
  };
}

export function toClientSmallDescriptions(
  records: Array<{ id: string; descriptionText: string; distanceMeters?: number }>,
): GameClientSmallDescription[] {
  return records.map((record) => ({
    id: record.id,
    descriptionText: record.descriptionText,
    distanceMeters: record.distanceMeters,
  }));
}

export function toClientLevelDescription(
  record: LevelDescriptionRecord | null,
): GameClientLevelDescription | null {
  if (!record) {
    return null;
  }

  return {
    buildingId: record.buildingId,
    level: record.level,
    descriptionText: record.descriptionText,
  };
}

function sanitizeMovePlayerToolContent(content: string): string {
  try {
    const parsed = JSON.parse(content) as { bearingDegrees?: unknown; distanceMeters?: unknown };
    const sanitized = {
      bearingDegrees: Number(parsed.bearingDegrees),
      distanceMeters: Number(parsed.distanceMeters),
    };

    if (!Number.isFinite(sanitized.bearingDegrees) || !Number.isFinite(sanitized.distanceMeters)) {
      return content;
    }

    return JSON.stringify(sanitized);
  } catch {
    return content;
  }
}

function createSaveDocument(sessionId: string): GameSaveDocument {
  return {
    sessionId,
    playerPosition: { ...DEFAULT_START_POSITION },
    // 室内状态由这三组字段共同表示：
    // 1. playerIndoorLocation 表示玩家当前是否在建筑内以及所处楼层/房间
    // 2. buildingSchemas 缓存建筑内部结构
    // 3. levelDescriptions 缓存具体楼层的文字描述
    playerIndoorLocation: null,
    messageHistory: [],
    activeLargeDescriptionId: null,
    visibleSmallDescriptionIds: [],
    largeDescriptions: [],
    smallDescriptions: [],
    buildingSchemas: {},
    levelDescriptions: {},
    lastSceneContextMeta: null,
  };
}

async function loadSaveDocument(sessionId: string): Promise<GameSaveDocument | null> {
  const savePath = getSavePath(sessionId);

  try {
    const content = await readFile(savePath, 'utf8');
    return normalizeSaveDocument(JSON.parse(content) as Partial<GameSaveDocument>, sessionId);
  } catch (error) {
    if (isFileNotFound(error)) {
      return null;
    }

    throw error;
  }
}

async function persistSaveDocument(save: GameSaveDocument): Promise<void> {
  await mkdir(SAVE_DIRECTORY, { recursive: true });
  await writeFile(getSavePath(save.sessionId), `${JSON.stringify(save, null, 2)}\n`, 'utf8');
}

function getSavePath(sessionId: string): string {
  return path.join(SAVE_DIRECTORY, `${sessionId}.json`);
}

function normalizeSaveDocument(input: Partial<GameSaveDocument>, sessionId: string): GameSaveDocument {
  return {
    sessionId: input.sessionId || sessionId,
    playerPosition: normalizePosition(input.playerPosition),
    playerIndoorLocation: normalizePlayerIndoorLocation(input.playerIndoorLocation),
    messageHistory: normalizeMessageHistory(input.messageHistory),
    activeLargeDescriptionId: typeof input.activeLargeDescriptionId === 'string' ? input.activeLargeDescriptionId : null,
    visibleSmallDescriptionIds: Array.isArray(input.visibleSmallDescriptionIds) ? input.visibleSmallDescriptionIds : [],
    largeDescriptions: normalizeLargeDescriptions(input.largeDescriptions),
    smallDescriptions: normalizeSmallDescriptions(input.smallDescriptions),
    buildingSchemas: normalizeBuildingSchemas(input.buildingSchemas),
    levelDescriptions: normalizeLevelDescriptions(input.levelDescriptions),
    lastSceneContextMeta: normalizeLastSceneContextMeta(input.lastSceneContextMeta),
  };
}

function normalizeLargeDescriptions(input: unknown): GameSaveDocument['largeDescriptions'] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input.flatMap((item) => {
    if (!item || typeof item !== 'object') {
      return [];
    }

    const id = typeof item.id === 'string' ? item.id : null;
    const center = normalizePosition('center' in item ? item.center as Partial<GamePosition> : undefined);
    const sourceRadiusM = Number('sourceRadiusM' in item ? item.sourceRadiusM : NaN);
    const effectiveRadiusM = Number('effectiveRadiusM' in item ? item.effectiveRadiusM : NaN);
    const descriptionText = typeof item.descriptionText === 'string' ? item.descriptionText : null;
    const createdAt = typeof item.createdAt === 'string' ? item.createdAt : null;
    const updatedAt = typeof item.updatedAt === 'string' ? item.updatedAt : null;

    if (!id || !descriptionText || !createdAt || !updatedAt || !Number.isFinite(sourceRadiusM) || !Number.isFinite(effectiveRadiusM)) {
      return [];
    }

    return [{
      id,
      center,
      sourceRadiusM,
      effectiveRadiusM,
      descriptionText,
      createdAt,
      updatedAt,
    }];
  });
}

function normalizeSmallDescriptions(input: unknown): GameSaveDocument['smallDescriptions'] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input.flatMap((item) => {
    if (!item || typeof item !== 'object') {
      return [];
    }

    const id = typeof item.id === 'string' ? item.id : null;
    const center = normalizePosition('center' in item ? item.center as Partial<GamePosition> : undefined);
    const sourceRadiusM = Number('sourceRadiusM' in item ? item.sourceRadiusM : NaN);
    const effectiveRadiusM = Number('effectiveRadiusM' in item ? item.effectiveRadiusM : NaN);
    const descriptionText = typeof item.descriptionText === 'string' ? item.descriptionText : null;
    const farVisibleNotes = typeof item.farVisibleNotes === 'string' ? item.farVisibleNotes : null;
    const createdAt = typeof item.createdAt === 'string' ? item.createdAt : null;
    const updatedAt = typeof item.updatedAt === 'string' ? item.updatedAt : null;
    const distanceMetersRaw = 'distanceMeters' in item ? Number(item.distanceMeters) : undefined;

    if (!id || !descriptionText || !createdAt || !updatedAt || !Number.isFinite(sourceRadiusM) || !Number.isFinite(effectiveRadiusM)) {
      return [];
    }

    return [{
      id,
      center,
      sourceRadiusM,
      effectiveRadiusM,
      descriptionText,
      farVisibleNotes,
      createdAt,
      updatedAt,
      distanceMeters: Number.isFinite(distanceMetersRaw) ? distanceMetersRaw : undefined,
    }];
  });
}

function normalizeLastSceneContextMeta(input: unknown): LastSceneContextMeta | null {
  if (!input || typeof input !== 'object' || !('diagnostics' in input)) {
    return null;
  }

  return {
    diagnostics: input.diagnostics as LastSceneContextMeta['diagnostics'],
  };
}

function normalizePlayerIndoorLocation(input: unknown): PlayerIndoorLocation | null {
  if (!input || typeof input !== 'object') {
    return null;
  }

  const candidate = input as Record<string, unknown>;
  const buildingId = typeof candidate.buildingId === 'string' ? candidate.buildingId : null;
  const level = Number(candidate.level);
  const roomKey = typeof candidate.roomKey === 'string' ? candidate.roomKey : null;

  if (!buildingId || !Number.isInteger(level) || !roomKey) {
    return null;
  }

  return {
    buildingId,
    level,
    roomKey,
  };
}

function normalizeBuildingSchemas(input: unknown): GameSaveDocument['buildingSchemas'] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {};
  }

  const entries = Object.entries(input as Record<string, unknown>)
    .filter(([, schema]) => isBuildingSchema(schema));

  return Object.fromEntries(entries) as GameSaveDocument['buildingSchemas'];
}

function normalizeLevelDescriptions(input: unknown): GameSaveDocument['levelDescriptions'] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {};
  }

  const normalizedEntries = Object.entries(input as Record<string, unknown>).flatMap(([key, value]) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return [];
    }

    const candidate = value as Record<string, unknown>;
    const buildingId = typeof candidate.buildingId === 'string' ? candidate.buildingId : null;
    const level = Number(candidate.level);
    const descriptionText = typeof candidate.descriptionText === 'string' ? candidate.descriptionText : null;
    const createdAt = typeof candidate.createdAt === 'string' ? candidate.createdAt : null;
    const updatedAt = typeof candidate.updatedAt === 'string' ? candidate.updatedAt : null;

    if (!buildingId || !Number.isInteger(level) || !descriptionText || !createdAt || !updatedAt) {
      return [];
    }

    return [[key, {
      buildingId,
      level,
      descriptionText,
      createdAt,
      updatedAt,
    } satisfies LevelDescriptionRecord] as const];
  });

  return Object.fromEntries(normalizedEntries);
}

function normalizeMessageHistory(history: unknown): GameMessage[] {
  if (!Array.isArray(history)) {
    return [];
  }

  const messages: GameMessage[] = [];

  for (const item of history) {
    if (!item || typeof item !== 'object' || !('role' in item) || !('content' in item)) {
      continue;
    }

    const role = typeof item.role === 'string' ? item.role : '';
    const content = typeof item.content === 'string' ? item.content : '';

    if (role === 'user') {
      messages.push({
        role: 'user' as const,
        content,
        isOpeningPrompt: typeof item.isOpeningPrompt === 'boolean' ? item.isOpeningPrompt : undefined,
      });
      continue;
    }

    if (role === 'assistant') {
      const reasoningContent = typeof item.reasoningContent === 'string' ? item.reasoningContent : undefined;
      const isToolCallMessage = item.isToolCallMessage === true;
      if (isToolCallMessage
        && typeof item.toolCallId === 'string'
        && typeof item.toolName === 'string'
        && typeof item.toolArgumentsText === 'string') {
        messages.push({
          role: 'assistant' as const,
          content,
          reasoningContent,
          isToolCallMessage: true,
          toolCallId: item.toolCallId,
          toolName: item.toolName,
          toolArgumentsText: item.toolArgumentsText,
        });
        continue;
      }

      messages.push({
        role: 'assistant' as const,
        content,
        reasoningContent,
      });
      continue;
    }

    if (role === 'tool' && typeof item.toolCallId === 'string' && typeof item.toolName === 'string') {
      messages.push({
        role: 'tool' as const,
        content,
        toolCallId: item.toolCallId,
        toolName: item.toolName,
      });
      continue;
    }

  }

  return messages;
}

function getCurrentBuildingSchema(
  buildingSchemas: Record<string, BuildingSchema>,
  playerIndoorLocation: PlayerIndoorLocation | null,
): BuildingSchema | null {
  // snapshot/chat response 不额外存冗余“当前建筑 schema”，而是从 save 中按玩家当前室内位置即时还原。
  if (!playerIndoorLocation) {
    return null;
  }

  return buildingSchemas[playerIndoorLocation.buildingId] || null;
}

function getCurrentLevelSchema(
  buildingSchema: BuildingSchema | null,
  playerIndoorLocation: PlayerIndoorLocation | null,
): ActiveLevelSchema | null {
  if (!buildingSchema || !playerIndoorLocation) {
    return null;
  }

  for (const [schemaKey, definition] of Object.entries(buildingSchema)) {
    const [start, end = start] = definition.span;
    if (playerIndoorLocation.level >= start && playerIndoorLocation.level <= end) {
      return {
        schemaKey,
        span: definition.span,
        rooms: definition.rooms,
      };
    }
  }

  return null;
}

function getCurrentLevelDescription(
  levelDescriptions: Record<string, LevelDescriptionRecord>,
  playerIndoorLocation: PlayerIndoorLocation | null,
): LevelDescriptionRecord | null {
  if (!playerIndoorLocation) {
    return null;
  }

  return levelDescriptions[buildLevelDescriptionKey(playerIndoorLocation.buildingId, playerIndoorLocation.level)] || null;
}

function buildLevelDescriptionKey(buildingId: string, level: number): string {
  return `${buildingId}::${level}`;
}

function isBuildingSchema(value: unknown): value is BuildingSchema {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  return Object.values(value as Record<string, unknown>).every((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return false;
    }

    const candidate = entry as Record<string, unknown>;
    return Array.isArray(candidate.span)
      && (candidate.span.length === 1 || candidate.span.length === 2)
      && candidate.span.every((item) => Number.isInteger(item))
      && candidate.rooms !== null
      && typeof candidate.rooms === 'object'
      && !Array.isArray(candidate.rooms);
  });
}

function normalizePosition(position: Partial<GamePosition> | undefined): GamePosition {
  if (position && Number.isFinite(position.lat) && Number.isFinite(position.lon)) {
    return {
      lat: Number(position.lat),
      lon: Number(position.lon),
    };
  }

  return { ...DEFAULT_START_POSITION };
}

function isFileNotFound(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'ENOENT';
}

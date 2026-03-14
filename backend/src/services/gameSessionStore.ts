import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildDescriptionIndex } from './gameDescriptionIndex.js';
import { distanceBetweenCoordinates } from './overpassGeometry.js';
import type {
  GamePosition,
  GameMessage,
  GameSaveDocument,
  GameSessionSnapshotResponse,
  LoadedGameSession,
  LastSceneContextMeta,
} from '../types/game.js';

const DEFAULT_START_POSITION: GamePosition = {
  lat: 33.8356574838558,
  lon: -84.34150239554577,
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

  // 若 sessionId 对应的 JSON 根本不存在，则 getOrCreateSession 会新建一个空存档。
  // 恢复接口不应该把“新建空存档”误认为成功恢复，因此这里要求至少已有历史或描述才算可恢复。
  const hasPersistedState = session.save.messageHistory.length > 0
    || session.save.largeDescriptions.length > 0
    || session.save.smallDescriptions.length > 0;

  if (!hasPersistedState) {
    return null;
  }

  return {
    sessionId: session.save.sessionId,
    hasStarted: true,
    messages: session.save.messageHistory,
    playerPosition: session.save.playerPosition,
    activeLargeDescription,
    nearbySmallDescriptions,
    debugSceneMeta: session.save.lastSceneContextMeta,
  };
}

export function updateLastSceneContextMeta(
  session: LoadedGameSession,
  meta: LastSceneContextMeta,
): void {
  session.save.lastSceneContextMeta = meta;
}

function createSaveDocument(sessionId: string): GameSaveDocument {
  return {
    sessionId,
    playerPosition: { ...DEFAULT_START_POSITION },
    messageHistory: [],
    activeLargeDescriptionId: null,
    visibleSmallDescriptionIds: [],
    largeDescriptions: [],
    smallDescriptions: [],
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
    messageHistory: normalizeMessageHistory(input.messageHistory),
    activeLargeDescriptionId: typeof input.activeLargeDescriptionId === 'string' ? input.activeLargeDescriptionId : null,
    visibleSmallDescriptionIds: Array.isArray(input.visibleSmallDescriptionIds) ? input.visibleSmallDescriptionIds : [],
    largeDescriptions: normalizeLargeDescriptions(input.largeDescriptions),
    smallDescriptions: normalizeSmallDescriptions(input.smallDescriptions),
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

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildDescriptionIndex } from './gameDescriptionIndex.js';
import type {
  GamePosition,
  GameSaveDocument,
  GameSessionSnapshotResponse,
  LoadedGameSession,
  LastSceneContextMeta,
} from '../types/game.js';

const DEFAULT_START_POSITION: GamePosition = {
  lat: 34.03051902687699,
  lon: -84.06309056978101,
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
    .filter((record): record is NonNullable<typeof record> => record !== null);

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
    messages: session.save.messageHistory
      .filter((message): message is { role: 'user' | 'assistant'; content: string } =>
        message.role === 'user' || message.role === 'assistant')
      .map((message) => ({
        role: message.role,
        content: message.content,
      })),
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
    messageHistory: Array.isArray(input.messageHistory) ? input.messageHistory : [],
    activeLargeDescriptionId: typeof input.activeLargeDescriptionId === 'string' ? input.activeLargeDescriptionId : null,
    visibleSmallDescriptionIds: Array.isArray(input.visibleSmallDescriptionIds) ? input.visibleSmallDescriptionIds : [],
    largeDescriptions: Array.isArray(input.largeDescriptions) ? input.largeDescriptions : [],
    smallDescriptions: Array.isArray(input.smallDescriptions) ? input.smallDescriptions : [],
    lastSceneContextMeta: input.lastSceneContextMeta || null,
  };
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

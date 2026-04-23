import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { BuildingSchema } from './buildingClassifier.js';
import { BuildingRecord } from './toolIndoorPosition.js';
import { FeatureId } from '../featureDetail.js';

export interface Position {
  lat: number;
  lon: number;
}

/**
 * 仅记录游戏对话，不包含系统提示词或者工具消息
 */
export type GameMessage =
  | {
      role: 'player';
      content: string;
    }
  | {
      role: 'book';
      content: string;
    };

export interface FieldVisualDescriptionRecord {
  id: string;
  center: Position; // 绑定经纬度坐标
  content: string; // 纯文本形式的列表
  createdAt: string;
  updatedAt: string;
}

/**
 * 文本形式记录某一建筑外部相关的事实性细节
 */
export interface ExteriorVisualDescriptionRecord {
  buildingId: string; // 绑定特定建筑的 featureId
  content: string; // 纯文本形式的列表
  createdAt: string;
  updatedAt: string;
}

/**
 * 文本形式记录某一建筑的某一楼层某一 Sector 的事实性细节
 */
export interface SectorVisualDescriptionRecord {
  buildingId: string;
  level: number;
  sectorName: string
  // ↑综合绑定特定建筑的特定 Sector
  content: string; // 纯文本形式的列表
  createdAt: string;
  updatedAt: string;
}

export interface PlayerIndoorLocation {
  buildingId: FeatureId;
  level: number;
  roomId: string;
}

/**
 * 仅仅用在 activeVisibleLocation 的类型，表示玩家能看见哪些地方
 */
export interface PlayerVisibleLocation {
  buildingId: FeatureId;
  level: number;
  suiteId?: string;
  roomId?: string;
}

/**
 * 纯长期游戏状态。
 * 不包含流式请求、后台任务、排队消息等运行时字段。
 */
export interface GameState {
  playerPosition: Position;
  playerOrientation: number;
  playerIndoorLocation: PlayerIndoorLocation | null;
  messageHistory: GameMessage[];
  activeFieldVisualDescriptions: string[];
  fieldVisualDescriptions: Record<string, FieldVisualDescriptionRecord>;
  activeExteriorVisualDescriptions: string[];
  exteriorVisualDescriptions: Record<string, ExteriorVisualDescriptionRecord>;
  buildingSchemas: Record<string, BuildingSchema>;
  buildingRecords: Record<string, BuildingRecord>; // 建筑的长期信息存储（包括未来可能会有的物品信息）
  activeVisibleLocations: PlayerVisibleLocation[];
  sectorVisualDescriptions: Record<string, SectorVisualDescriptionRecord>;
  activeSectorVisualDescriptions: string[];
}

/**
 * 可持久化恢复的存档。
 */
export interface GameSave {
  sessionId: string;
  gameState: GameState;
  llmProvider?: string;
}

export interface GameSessionRuntime {
  pendingVisualDescription: boolean;
  queuedPlayerMessage: string | null;
  activeTurnId: string | null;
  pendingVisualDescriptionTask: Promise<void> | null;
}

/**
 * 运行时会话：GameSave + 运行期编排状态。
 */
export interface GameSession {
  sessionId: string;
  gameState: GameState;
  llmProvider?: string;
  runtime: GameSessionRuntime;
}

/**
 * 提供给前端的可恢复快照。
 * 基础数据来自 GameSave，但允许附带少量运行态摘要供 UI 展示。
 */
export interface GameClientSessionSnapshot extends GameState {
  sessionId: string;
  llmProvider?: string;
  pendingVisualDescription: boolean;
  hasQueuedPlayerMessage: boolean;
}

//#region 常量

// const testPosition = [39.90310484384369, -83.44964892561046]
const testPosition = [39.99952202640245, -83.01270469750418]

const DEFAULT_START_POSITION: Position = {
  // lat: 33.83653441683847,
  // lon: -84.34211999827654,
  lat: testPosition[0],
  lon: testPosition[1],
};

const SAVE_DIRECTORY = path.resolve(process.cwd(), 'data', 'game-saves');

//#region 出口函数

/**
 * 运行时缓存 session，键是 UUID，值是 GameSession
 */
const sessions = new Map<string, GameSession>();

/**
 * 获取 Game Session
 * @param sessionId
 * @returns 获取到的 Game Session，或者表示失败的 undefined
 */
export async function getRuntimeSession(sessionId: string): Promise<GameSession | undefined> {
  if (sessionId) {
    const existing = sessions.get(sessionId);
    if (existing) {
      return existing;
    }
  }

  const save = await loadGameSave(sessionId);
  if (!save) {
    return undefined;
  }

  const session = createRuntimeSessionFromSave(save);
  sessions.set(sessionId, session);  // 把文件存档态的 Game Session 存入内存缓存
  return session;
}

/**
 * 创建 Game Session
 * @returns 新创建的 Game Session
 */
export async function createRuntimeSession(): Promise<GameSession> {
  const nextSessionId = randomUUID();
  const save = createGameSave(nextSessionId);
  const session = createRuntimeSessionFromSave(save);

  sessions.set(nextSessionId, session);
  return session;
}

/**
 * Game Session 更新统一通过这个入口回写，避免路由层直接操作缓存和文件。
 * @param session
 */
export async function updateRuntimeSession(session: GameSession): Promise<void> {
  sessions.set(session.sessionId, session);
  await saveGameSave(toGameSave(session));
}

export async function saveGameSave(save: GameSave): Promise<void> {
  await mkdir(SAVE_DIRECTORY, { recursive: true });
  const savePath = path.join(SAVE_DIRECTORY, `${save.sessionId}.json`);
  await writeFile(savePath, `${JSON.stringify(save, null, 2)}\n`, 'utf8');
}

//#region 帮助函数

export async function loadGameSave(sessionId: string): Promise<GameSave | null> {
  const savePath = path.join(SAVE_DIRECTORY, `${sessionId}.json`);

  try {
    const content = await readFile(savePath, 'utf8');
    const parsed = JSON.parse(content) as Partial<GameSave> | Partial<GameState>;
    return normalizeLoadedSave(sessionId, parsed);
  } catch (error) {
    if (isFileNotFound(error)) {
      return null;
    }

    throw error;
  }
}

export function toGameSave(session: GameSession): GameSave {
  return {
    sessionId: session.sessionId,
    gameState: cloneGameState(session.gameState),
    llmProvider: session.llmProvider,
  };
}

export function toClientGameSessionSnapshot(session: GameSession): GameClientSessionSnapshot {
  const snapshot = cloneGameState(session.gameState);
  return {
    sessionId: session.sessionId,
    llmProvider: session.llmProvider,
    pendingVisualDescription: session.runtime.pendingVisualDescription,
    hasQueuedPlayerMessage: Boolean(session.runtime.queuedPlayerMessage),
    ...snapshot,
  };
}

export function cloneGameState(gameState: GameState): GameState {
  return structuredClone(gameState);
}

function createRuntimeSessionFromSave(save: GameSave): GameSession {
  return {
    sessionId: save.sessionId,
    gameState: cloneGameState(save.gameState),
    llmProvider: save.llmProvider,
    runtime: {
      pendingVisualDescription: false,
      queuedPlayerMessage: null,
      activeTurnId: null,
      pendingVisualDescriptionTask: null,
    },
  };
}

function createGameSave(sessionId: string): GameSave {
  return {
    sessionId,
    gameState: {
      playerPosition: { ...DEFAULT_START_POSITION },
      playerOrientation: Math.floor(Math.random() * 360),
      playerIndoorLocation: null, // 根据 DEFAULT_STARTING_POSITION 获取所在建筑的 feature id，而 level 和 roomId 填充独特的占位符
      messageHistory: [],
      activeFieldVisualDescriptions: [],
      fieldVisualDescriptions: {},
      activeExteriorVisualDescriptions: [],
      exteriorVisualDescriptions: {},
      buildingSchemas: {},
      buildingRecords: {},
      activeVisibleLocations: [],
      sectorVisualDescriptions: {},
      activeSectorVisualDescriptions: [],
    },
  };
}

function normalizeLoadedSave(sessionId: string, parsed: Partial<GameSave> | Partial<GameState>): GameSave {
  if ('gameState' in parsed && parsed.gameState) {
    const save = parsed as GameSave;
    return {
      sessionId: save.sessionId || sessionId,
      gameState: save.gameState,
      llmProvider: save.llmProvider,
    };
  }

  // 兼容旧版本直接把 GameSession/GameState 写进文件的存档。
  return {
    sessionId,
    gameState: parsed as GameState,
  };
}

function isFileNotFound(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'ENOENT';
}

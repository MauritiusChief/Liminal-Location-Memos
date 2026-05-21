import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { BuildingSchema } from '../buildingGeneration/buildingSchema.js';
import { FeatureId } from '../featureDetail.js';
import type { BuildingRecord } from '../buildingGeneration/buildingRecord.js';
import { GameStateToolCall } from './agentStateManager.js';
import { CardboardItemRecord, ItemRecord } from '../objectGeneration/itemTemplates.js';
import { GeneralContent } from '../objectGeneration/objectGeneraterShared.js';

export interface Position {
  lat: number;
  lon: number;
}

/**
 * 仅记录游戏对话和对玩家对话识别后直接产生的工具调用记录，
 * 不包含系统提示词或者 refresh state 工具消息
 */
export type GameMessage =
  | {
      role: 'player';
      content: string;
      stateChange?: GameStateToolCall[]
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
 * 文本形式记录某一建筑的某一楼层某一房间的事实性细节
 */
export interface RoomVisualDescriptionRecord {
  buildingId: string;
  level: number;
  roomId: string;
  // ↑综合绑定特定建筑的特定房间
  content: string; // 纯文本形式的列表
  createdAt: string;
  updatedAt: string;
}

export interface PlayerIndoorLocation {
  buildingId: FeatureId;
  level: number;
  sectorName: string;
  locationType: "room" | "suite" | "subRoom";
  suiteId?: string;
  suiteDescription?: string;
  roomId: string;
  roomDescription: string;
}

/**
 * 仅仅用在 activeVisibleLocation 的类型，表示玩家能看见哪些地方
 */
export interface PlayerVisibleLocation {
  buildingId: FeatureId;
  level: number;
  sectorName: string;
  locationType: "room" | "suite" | "subRoom";
  suiteId?: string;
  suiteDescription?: string;
  roomId?: string;
  roomDescription?: string;
}

/**
 * 纯长期游戏状态。
 * 不包含流式请求、后台任务、排队消息等运行时字段。
 */
export interface GameState {
  // 玩家信息
  playerPosition: Position;
  playerOrientation: number;
  playerIndoorLocation: PlayerIndoorLocation | null;
  playerVisionRange: number;
  playerStatus: PlayerStatus;
  playerVisibleLocations: PlayerVisibleLocation[];
  playerInventory: Record<string, GeneralContent>; // 键为 UUID
  // 完整聊天信息
  messageHistory: GameMessage[];
  // 建筑、载具（未完成）、物品（未完成）信息
  buildingSchemas: Record<string, BuildingSchema>;
  buildingRecords: Record<string, BuildingRecord>; // 建筑的长期信息存储（包括物品信息）
  weatherAnchors: WeatherAnchor[];
  chunckRecords: ChunckRecord[];
  // 来自LLM的视觉事实信息落盘
  activeFieldVisualDescriptions: string[];
  fieldVisualDescriptions: Record<string, FieldVisualDescriptionRecord>;
  activeExteriorVisualDescriptions: string[];
  exteriorVisualDescriptions: Record<string, ExteriorVisualDescriptionRecord>;
  activeRoomVisualDescriptions: string[];
  roomVisualDescriptions: Record<string, RoomVisualDescriptionRecord>;
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

interface PlayerStatus {
  // HP相关
  health: number; // 笼统的健康条，由100减去会致死的四条（blood_loss/infection/poisonous/nerv_mis）中的最大值得到
  blood_loss: number; // 字面意义的血量，特指外伤/内伤出血，涨满表示失血过多而死
  infection: number; // 特指病毒/细菌感染，涨满表示败血症引发多器官衰竭而死
  poisonous: number; // 特指中毒，涨满表示肝衰竭/肾衰竭而死
  nerv_mis: number; // 神经系统功能损失，涨满表示心跳骤停/呼吸麻痹等神经失去功能导致的死亡
  // 重要状态，可间接至死
  hydration: number; // 饮水值，归零代表失水过多，将增加 poisonous（血流不足引起肾衰竭）
  calorie: number; // 卡路里，归零代表糖原、脂肪消耗均殆尽，将开始消耗 protein
  protein: number; // 蛋白质量，归零代表体内蛋白质跌破正常生存所需量，将增加 infection（低蛋白质引起免疫系统崩溃）
  exceeded_heat: number; // 特指人体正常生活以外的热量，涨满会消耗 hydration 为代价抵消其额外增长（出汗）；如果 hydration 归零或者某种原因无法出汗，会减少 protein 值（蛋白质高温失活）
  essential_heat: number; // 特指人体所需的必要热量，归零会消耗 calorie 为代价抵消其额外下降（发抖）；如果 calorie 归零，会增加 nerv_mis（中枢神经抑制）
  // 次级状态
  fatigue: number; // 疲劳值，任何行动都会增加疲劳，且只有睡觉可以恢复
  endurance: number; // 体力值，任何行动都需要体力值允许
}

/**
 * 每 10km 创建一个新的天气锚定参数
 */
interface WeatherAnchor {
  center: Position;
  createdAt: string;
  updatedAt: string;
}

/**
 * 把载具/物品...经纬度按 0.01° 取整，得到的就是所处的 chunck id
 */
interface ChunckRecord {
  id: Position;
}

interface FieldItemRecord extends ItemRecord {
  position: Position;
}

interface FieldCardboardItemRecord extends CardboardItemRecord {
  position: Position;
}


//#region 常量

// const testPosition = [39.90310484384369, -83.44964892561046]
// const testPosition = [39.99952202640245, -83.01270469750418]
const testPosition = [40.018030, -83.015056]

const DEFAULT_START_POSITION: Position = {
  // lat: 33.83653441683847,
  // lon: -84.34211999827654,
  lat: testPosition[0],
  lon: testPosition[1],
};

const DEFAULT_START_TIME = new Date()

const INITIAL_PLAYER_STATUS: PlayerStatus = {
  health: 100,
  blood_loss: 0, infection: 0, poisonous: 0, nerv_mis: 0,
  hydration: 100, calorie: 100, protein: 100,
  exceeded_heat: 0, essential_heat: 100,
  fatigue: 0,
  endurance: 100,
}

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
    const parsed = JSON.parse(content) as GameSave;
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
    gameState: createDefaultGameState(),
  };
}

function normalizeLoadedSave(sessionId: string, parsed: GameSave): GameSave {
  const save = parsed as GameSave;
  return {
    sessionId: save.sessionId || sessionId,
    gameState: save.gameState,
    llmProvider: save.llmProvider,
  };
}

function createDefaultGameState(): GameState {
  return {
    playerPosition: { ...DEFAULT_START_POSITION },
    playerOrientation: Math.floor(Math.random() * 360),
    playerIndoorLocation: null,
    playerVisionRange: 500,
    playerStatus: INITIAL_PLAYER_STATUS,
    playerVisibleLocations: [],
    playerInventory: {},

    messageHistory: [],

    buildingSchemas: {},
    buildingRecords: {},
    weatherAnchors: [],
    chunckRecords: [],

    activeFieldVisualDescriptions: [],
    fieldVisualDescriptions: {},
    activeExteriorVisualDescriptions: [],
    exteriorVisualDescriptions: {},
    activeRoomVisualDescriptions: [],
    roomVisualDescriptions: {},
  };
}

function isFileNotFound(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'ENOENT';
}

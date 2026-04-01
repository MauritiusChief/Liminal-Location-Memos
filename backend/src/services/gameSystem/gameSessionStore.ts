import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

export interface Position {
  lat: number;
  lon: number;
}

/**
 * 仅记录游戏对话，不包含系统提示词或者工具消息
 */
export type GameMessage =
  | {
      role: 'user';
      content: string;
    }
  | {
      role: 'book';
      content: string;
    }

export interface GameSession {
  sessionId: string;
  playerPosition: Position;
  playerIndoorLocation: PlayerIndoorLocation | null;
  messageHistory: GameMessage[];
  activeVisualDescriptions: string[]; // 记录 id
  visualDescriptions: Record<string, VisualDescriptionRecord>;
  buildingSchemas: Record<string, BuildingSchema>;
  levelDescriptions: Record<string, LevelDescriptionRecord>;
}

/**
 * 文本形式记录某一经纬度附近(100m范围内)的事实性细节
 */
export interface VisualDescriptionRecord {
  id: string;
  center: Position; // 绑定经纬度坐标
  content: string; // 纯文本形式的列表
  createdAt: string;
  updatedAt: string;
}

/**
 * 建筑蓝图，由多个建筑楼层蓝图组成
 */
export type BuildingSchema = Record<string, BuildingLevelSchemaDefinition>;
/**
 * 建筑楼层蓝图组成，由该蓝图所管辖的房间以及所属的多个建筑房间蓝图组成
 */
export interface BuildingLevelSchemaDefinition {
  span: number | [number, number]; // 对应单层与多层状况
  rooms: Record<string, BuildingSchemaRoom | BuildingSchemaSuiteRoom>;
}
/**
 * 简单房间蓝图
 */
export interface BuildingSchemaRoom {
  count: number;
  desc: string;
  access?: 'entrance' | 'vertical' | 'internal';
}
/**
 * 套房蓝图，适用于重复的复杂结构房间，设定不包含 access
 */
export interface BuildingSchemaSuiteRoom {
  count: number;
  desc: string;
  subRooms: Record<string, BuildingSchemaSubRoom>;
}
/**
 * 套房蓝图的子房间蓝图，设定不包含 access
 */
export interface BuildingSchemaSubRoom {
  count: number;
  desc: string;
}

/**
 * 文本形式记录某一建筑的某一楼层的事实性细节
 */
export interface LevelDescriptionRecord {
  buildingId: string;
  level: number; // 综合绑定特定建筑的特定楼层
  content: string; // 纯文本形式的列表
  createdAt: string;
  updatedAt: string;
}

export interface PlayerIndoorLocation {
  buildingId: string;
  level: number;
  roomKey: string;
}

//#region 客户端类型

/**
 * TODO：在添加登录功能时，添加仅暴露必须字段的客户端专用类型
 */

//#region 常量

const testPosition = [39.90310484384369, -83.44964892561046]

const DEFAULT_START_POSITION: Position = {
  // lat: 33.83653441683847,
  // lon: -84.34211999827654,
  lat: testPosition[0],
  lon: testPosition[1]
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
export async function getSession(sessionId: string): Promise<GameSession | undefined> {
  if (sessionId) {
    const existing = sessions.get(sessionId);
    if (existing) {
      return existing;
    }
  }

  const save = await loadSaveDocument(sessionId)
  if (!save) return undefined // 没有找到 Game Session

  const loadedSession: GameSession = save
  sessions.set(sessionId, loadedSession);
  return loadedSession;
}

/**
 * 创建 Game Session
 * @returns 新创建的 Game Session
 */
export async function createSession(): Promise<GameSession> {
  const nextSessionId = randomUUID();
  const save = createSaveDocument(nextSessionId);
  const loadedSession: GameSession = save

  sessions.set(nextSessionId, loadedSession);
  return loadedSession;
}

/**
 * Game Session 更新统一通过这个入口回写，避免路由层直接操作缓存和文件。
 * @param session
 */
export async function updateSession(session: GameSession): Promise<void> {
  sessions.set(session.sessionId, session);
  await mkdir(SAVE_DIRECTORY, { recursive: true });
  const savePath = path.join(SAVE_DIRECTORY, `${session.sessionId}.json`)
  await writeFile(savePath, `${JSON.stringify(session, null, 2)}\n`, 'utf8');
}

//#region 帮助函数

async function loadSaveDocument(sessionId: string): Promise<GameSession | null> {
  const savePath = path.join(SAVE_DIRECTORY, `${sessionId}.json`);

  try {
    const content = await readFile(savePath, 'utf8');
    return JSON.parse(content) as GameSession;
  } catch (error) {
    if (isFileNotFound(error)) {
      return null;
    }

    throw error;
  }
}

function createSaveDocument(sessionId: string): GameSession {
  return {
    sessionId,
    playerPosition: { ...DEFAULT_START_POSITION },
    playerIndoorLocation: null,
    messageHistory: [],
    activeVisualDescriptions: [],
    visualDescriptions: {},
    buildingSchemas: {},
    levelDescriptions: {},
  };
}

function isFileNotFound(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'ENOENT';
}
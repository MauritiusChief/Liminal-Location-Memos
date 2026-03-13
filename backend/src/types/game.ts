import type { DbNormalizationDiagnostics } from '../services/dbSceneTypes.js';
import type { NormalizedMicroGrid } from '../services/overpassGrid.js';
import type { NormalizedPolarView } from '../services/overpassPolar.js';

// 这一组类型描述“正式游戏链路”里前后端共享的核心状态：
// 玩家坐标、会话历史、工具调用结果，以及后端返回给首页 debug 面板的数据。
export interface GamePosition {
  lat: number;
  lon: number;
}

export interface GameMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
}

export interface MovePlayerToolInput {
  bearingDegrees: number;
  distanceMeters: number;
  reason?: string;
  targetLabel?: string;
}

export interface MovePlayerToolResult {
  previousPosition: GamePosition;
  nextPosition: GamePosition;
  bearingDegrees: number;
  distanceMeters: number;
  reason: string;
  targetLabel?: string;
  coverageSyncTriggered: boolean;
}

export interface SceneContext {
  // SceneContext 是一次“当前位置场景装载”的完整结果。
  // summary 不落库，而是每次从 scene data 现算后塞进这里。
  position: GamePosition;
  radius: number;
  diagnostics: DbNormalizationDiagnostics;
  microGrid?: NormalizedMicroGrid;
  polarView?: NormalizedPolarView;
  largeSummary: string;
  smallSummary: string;
  largeSceneSignature: string;
  smallSceneSignature: string;
}

export interface LargeDescriptionRecord {
  // 大描述覆盖 1km 场景，并在当前位置附近一段范围内复用。
  id: string;
  center: GamePosition;
  sourceRadiusM: number;
  effectiveRadiusM: number;
  sourceSceneSignature: string;
  descriptionText: string;
  createdAt: string;
  updatedAt: string;
}

export interface SmallDescriptionRecord {
  // 小描述覆盖 200m 局部环境，farVisibleNotes 只保留可供其他小描述复用的远距细节。
  id: string;
  center: GamePosition;
  sourceRadiusM: number;
  effectiveRadiusM: number;
  sourceSceneSignature: string;
  descriptionText: string;
  farVisibleNotes: string | null;
  createdAt: string;
  updatedAt: string;
  distanceMeters?: number;
}

export interface LastSceneContextMeta {
  diagnostics: DbNormalizationDiagnostics;
  largeSceneSignature: string;
  smallSceneSignature: string;
}

export interface GameSaveDocument {
  // 这是单会话单 JSON 文件的落盘格式。
  sessionId: string;
  playerPosition: GamePosition;
  messageHistory: GameMessage[];
  activeLargeDescriptionId: string | null;
  visibleSmallDescriptionIds: string[];
  largeDescriptions: LargeDescriptionRecord[];
  smallDescriptions: SmallDescriptionRecord[];
  lastSceneContextMeta: LastSceneContextMeta | null;
}

export interface DescriptionIndexPoint<TRecord extends LargeDescriptionRecord | SmallDescriptionRecord> {
  id: string;
  lon: number;
  lat: number;
  record: TRecord;
}

export interface DescriptionIndexBundle {
  // 实际的 kdbush 实例由运行时服务管理；
  // 这里保留 points 结果，便于其他模块理解当前索引覆盖了哪些记录。
  largePoints: DescriptionIndexPoint<LargeDescriptionRecord>[];
  smallPoints: DescriptionIndexPoint<SmallDescriptionRecord>[];
}

export interface LoadedGameSession {
  save: GameSaveDocument;
  descriptionIndex: DescriptionIndexBundle;
}

export interface GameChatRequest {
  sessionId?: string;
  message?: string;
}

export interface GameChatResponse {
  // 首页每次发送消息后，都会拿到最新位置、描述和调试元数据。
  sessionId: string;
  assistantMessage: string;
  playerPosition: GamePosition;
  movementResult: MovePlayerToolResult | null;
  activeLargeDescription: LargeDescriptionRecord | null;
  nearbySmallDescriptions: SmallDescriptionRecord[];
  debugSceneMeta: {
    diagnostics: DbNormalizationDiagnostics;
    largeSceneSignature: string;
    smallSceneSignature: string;
    coverageSyncTriggered: boolean;
  } | null;
}

export interface GameSessionSnapshotResponse {
  // 这是“恢复旧存档”专用的只读快照，不会产生新消息。
  sessionId: string;
  hasStarted: boolean;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  playerPosition: GamePosition;
  activeLargeDescription: LargeDescriptionRecord | null;
  nearbySmallDescriptions: SmallDescriptionRecord[];
  debugSceneMeta: {
    diagnostics: DbNormalizationDiagnostics;
    largeSceneSignature: string;
    smallSceneSignature: string;
  } | null;
}

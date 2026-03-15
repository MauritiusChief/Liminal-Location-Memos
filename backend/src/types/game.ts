import type { DbNormalizationDiagnostics } from '../services/dbSceneTypes.js';
import type { NormalizedMicroGrid } from '../services/overpassGrid.js';
import type { NormalizedPolarView } from '../services/overpassPolar.js';
import type { SummaryPreviewMode } from '../services/scene/sceneSummaryService.js';

// 这一组类型描述“正式游戏链路”里前后端共享的核心状态：
// 玩家坐标、会话历史、工具调用结果，以及后端返回给首页 debug 面板的数据。
export interface GamePosition {
  lat: number;
  lon: number;
}

export type GameMessage =
  | {
      role: 'user';
      content: string;
      isOpeningPrompt?: boolean;
    }
  | {
      role: 'assistant';
      content: string;
      reasoningContent?: string;
      isToolCallMessage?: false;
    }
  | {
      role: 'assistant';
      content: string;
      reasoningContent?: string;
      isToolCallMessage: true;
      toolCallId: string;
      toolName: string;
      toolArgumentsText: string;
    }
  | {
      role: 'tool';
      content: string;
      toolCallId: string;
      toolName: string;
    };

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

export type SceneContextSummaryMode = 'concise_near' | 'concise_far' | 'detailed_far';

export interface SceneContextSnapshotPayload {
  type: 'scene_context_snapshot';
  summaryMode: SceneContextSummaryMode;
  largeDescription: string;
  activeSummary: string;
  nearbyFarVisibleDetails: Array<{
    distanceMeters: number;
    notes: string;
  }>;
}

export type LookFarToolResult = SceneContextSnapshotPayload;

export interface SceneContext {
  // SceneContext 是一次“当前位置场景装载”的完整结果。
  // summary 不落库，而是按需从 scene data 现算并缓存。
  position: GamePosition;
  radius: number;
  diagnostics: DbNormalizationDiagnostics;
  microGrid?: NormalizedMicroGrid;
  polarView?: NormalizedPolarView;
  getSummary: (summaryMode: SummaryPreviewMode) => Promise<string>;
}

export interface LargeDescriptionRecord {
  // 大描述覆盖 1km 场景，并在当前位置附近一段范围内复用。
  id: string;
  center: GamePosition;
  sourceRadiusM: number;
  effectiveRadiusM: number;
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
  descriptionText: string;
  farVisibleNotes: string | null;
  createdAt: string;
  updatedAt: string;
  distanceMeters?: number;
}

export interface LastSceneContextMeta {
  diagnostics: DbNormalizationDiagnostics;
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
  isOpeningPrompt?: boolean;
}

export type GameClientMessage =
  | {
      role: 'user';
      content: string;
    }
  | {
      role: 'assistant';
      content: string;
    }
  | {
      role: 'tool';
      content: string;
      toolName: string;
    };

export interface GameClientLargeDescription {
  id: string;
  descriptionText: string;
}

export interface GameClientSmallDescription {
  id: string;
  descriptionText: string;
  distanceMeters?: number;
}

export interface GameChatResponse {
  // 首页每次发送消息后，都会拿到最新位置和必要的展示数据。
  sessionId: string;
  messages: GameClientMessage[];
  playerPosition: GamePosition;
  activeLargeDescription: GameClientLargeDescription | null;
  nearbySmallDescriptions: GameClientSmallDescription[];
}

export interface GameSessionSnapshotResponse {
  // 这是“恢复旧存档”专用的只读快照，不会产生新消息。
  sessionId: string;
  hasStarted: boolean;
  messages: GameClientMessage[];
  playerPosition: GamePosition;
  activeLargeDescription: GameClientLargeDescription | null;
  nearbySmallDescriptions: GameClientSmallDescription[];
}

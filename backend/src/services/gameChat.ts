import { movePosition } from './gameMovement.js';
import { ensureCoverageForPosition, loadSceneContext } from './gameScene.js';
import {
  getOrCreateSession,
  toClientLevelDescription,
  toClientLargeDescription,
  toClientMessages,
  toClientSmallDescriptions,
  updateLastSceneContextMeta,
  updateSession,
} from './gameSessionStore.js';
import {
  runChatCompletionWithTools,
  ToolEnabledChatResponse,
  type AssistantHistoryMessage,
  type ChatRequestMessage,
  type ToolDefinition,
} from './llm.js';
import { writeGameChatMessageSnapshot } from './gameChatDebugLog.js';
import { findNearbySmallDescriptions } from './sceneDescriptionRepository.js';
import {
  ensureBuildingSchema,
  ensureLargeDescription,
  ensureLevelDescription,
  ensureSmallDescription,
  filterFarVisibleSmallDescriptions,
  isTopFloorOfBuilding,
  resolveActiveLevelSchema,
  resolveIndoorEntranceLocation,
} from './sceneDescriptionService.js';
import { buildProjectedSceneSummary, SCENE_CONTEXT_SUMMARY_MODE_TO_PREVIEW_MODE } from './sceneSummaryService.js';
import { findAreasAtPosition, findBuildingsAtPosition, findNearbyLinesAtPosition } from './osmRepository.js';
import type {
  ActiveLevelSchema,
  BuildingSchema,
  GameChatResponse,
  GameMessage,
  GameChatRequest,
  LevelDescriptionRecord,
  LargeDescriptionRecord,
  LookFarToolResult,
  LoadedGameSession,
  MovePlayerToolInput,
  MovePlayerToolResult,
  SceneContextSnapshotPayload,
  SceneContextSummaryMode,
  SceneContext,
  SmallDescriptionRecord,
  GamePosition,
  BuildingSummary,
  AreaSummary,
  LineSummary,
} from '../types/game.js';
import { styleRule } from './sharedDefaultSysPromptPart.js';

// 目前正式游戏回合只暴露一个工具：
// 模型如果判断用户想移动，就必须把结果收敛为“角度 + 距离”。
const MOVE_PLAYER_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'move_player',
    description: '当用户明确或隐含地要求玩家移动时，调用此工具以给出移动方向和距离。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        bearingDegrees: { type: 'number', description: '以正北为0度，顺时针增加。' },
        distanceMeters: { type: 'number', description: '移动距离，单位米。' },
        reason: { type: 'string', description: '简短说明为何这样移动。' },
        targetLabel: { type: 'string', description: '若用户提到目标地物，可记录其标签。' },
      },
      required: ['bearingDegrees', 'distanceMeters'],
    },
  },
};

const LOOK_FAR_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'look_far',
    description: '当用户要求眺望远处、观察较远目标，或打算前往远处前先确认情况时，调用此工具以切换到远眺信息视角。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
};

const GAME_CHAT_TOOLS: ToolDefinition[] = [MOVE_PLAYER_TOOL, LOOK_FAR_TOOL];

const SYNTHETIC_SCENE_CONTEXT_TOOL_NAME = 'refresh_scene_context';
const SYNTHETIC_SCENE_CONTEXT_TOOL_ARGUMENTS = '{}';
const MAX_STORED_TURNS = 6;

interface TurnRuntime {
  // shared: regardless of indoor/outdoor, every turn needs session, input, sceneContext and tool-chain state.
  session: LoadedGameSession;
  inputMessage: string;
  userMessage: GameMessage;
  sceneContext: SceneContext;
  // outdoor-only: when the player is not inside a building, these fields drive the original scene-description flow.
  activeLargeDescription: LargeDescriptionRecord | null;
  activeSmallDescription: SmallDescriptionRecord | null;
  nearbySmallDescriptions: SmallDescriptionRecord[];
  // indoor-only: when the player is inside a building, these fields replace most outdoor scene-description state.
  currentBuildingSchema: BuildingSchema | null;
  currentLevelSchema: ActiveLevelSchema | null;
  currentLevelDescription: LevelDescriptionRecord | null;
  indoorTopFloor: boolean;
  promptSummaryMode: SceneContextSummaryMode;
  currentTurnToolMessages: GameMessage[];
}

interface PositionContextBundle {
  // This bundle is intentionally limited to OSM-derived positional context so callers can reuse queries
  // without coupling runtime-preparation to unrelated state such as coverage sync flags.
  currentBuildings: BuildingSummary[];
  currentAreas: AreaSummary[];
  nearbyLines: LineSummary[];
}

interface RequestModelTurnOptions {
  tools: ToolDefinition[];
  snapshotDirection: 'to-llm' | 'llm-use-tool';
  injectSyntheticSceneRefresh: boolean;
  syntheticSceneRefreshStage: string;
}

interface ToolStepResult {
  remainingTools: ToolDefinition[];
  injectSyntheticSceneRefresh: boolean;
  syntheticSceneRefreshStage: string;
}

/**
 * 运行一个对话回合
 * @param input
 * @returns 发送给前端的数据
 */
export async function runGameChatTurn(input: Pick<GameChatRequest, 'sessionId' | 'message' | 'isOpeningPrompt'> & {
  message: string;
}): Promise<GameChatResponse> {
  // 一次正式回合的主流程：
  // 1. 找或建 session
  // 2. 确保当前位置有覆盖数据
  // 3. 装载场景并复用/生成描述
  // 4. 让模型决定是否调用工具
  // 5. 若触发工具，则由后端执行对应逻辑，并把 assistant(tool_call) + tool(tool_return) 带回后续轮次生成最终自然语言回复
  const session = await getOrCreateSession(input.sessionId);
  const userMessage: GameMessage = {
    role: 'user',
    content: input.message,
    isOpeningPrompt: input.isOpeningPrompt === true,
  };
  const runtime = await initializeTurnRuntime(
    session,
    input.message,
    userMessage,
  );
  let modelResponse = await requestModelTurn(runtime, {
    tools: GAME_CHAT_TOOLS,
    snapshotDirection: 'to-llm',
    injectSyntheticSceneRefresh: true,
    syntheticSceneRefreshStage: 'initial',
  });

  while (modelResponse.toolCall) {
    const step = await executeToolStep(runtime, modelResponse);
    modelResponse = await requestModelTurn(runtime, {
      tools: step.remainingTools,
      snapshotDirection: 'llm-use-tool',
      injectSyntheticSceneRefresh: step.injectSyntheticSceneRefresh,
      syntheticSceneRefreshStage: step.syntheticSceneRefreshStage,
    });
  }

  return finalizeTurn(runtime, modelResponse);
}

/**
 * 初始化回合，准备该回合所有需要的 runtime
 * @param session 游戏的 session
 * @param inputMessage 玩家输入的消息
 * @param userMessage 用户端发送的消息
 * @returns 打包好的 runtime。首次进入时会根据存档中是否已有 playerIndoorLocation 自动进入室内或室外准备分支。
 */
async function initializeTurnRuntime(
  session: LoadedGameSession,
  inputMessage: string,
  userMessage: GameMessage
): Promise<TurnRuntime> {
  const runtime: TurnRuntime = {
    session: session,
    inputMessage: inputMessage,
    userMessage: userMessage,
    sceneContext: await loadSceneContext(session.save.playerPosition),
    activeLargeDescription: null,
    activeSmallDescription: null,
    nearbySmallDescriptions: [],
    currentBuildingSchema: null,
    currentLevelSchema: null,
    currentLevelDescription: null,
    indoorTopFloor: false,
    promptSummaryMode: 'concise_near',
    currentTurnToolMessages: [],
  };

  await prepareRuntimeForPosition(runtime, session.save.playerPosition);
  return runtime;
}

/**
 * 根据玩家当前坐标刷新 runtime。
 * 统一在这里负责 coverage 补洞与 sceneContext 装载，然后再分支：
 * 1. 室外：沿用原有的大描述/小描述缓存链路
 * 2. 室内：改为建筑 schema + 当前楼层描述链路
 *
 * prefetchedContext 仅用于复用当前位置已查询出的建筑/区域/线性要素，
 * 避免同一坐标在一个工具步骤内重复查库。
 */
async function prepareRuntimeForPosition(
  runtime: TurnRuntime,
  position: GamePosition,
  prefetchedContext?: PositionContextBundle,
): Promise<boolean> {
  const coverageSyncTriggered = await ensureCoverageForPosition(position);
  runtime.sceneContext = await loadSceneContext(position);
  runtime.currentBuildingSchema = null;
  runtime.currentLevelSchema = null;
  runtime.currentLevelDescription = null;
  runtime.indoorTopFloor = false;

  if (runtime.session.save.playerIndoorLocation) {
    const context = prefetchedContext || await loadPositionContext(position);
    const buildingSchemas = await ensureBuildingSchema(context, runtime.session);
    const indoorLocation = runtime.session.save.playerIndoorLocation;
    const currentBuildingSchema = buildingSchemas[indoorLocation.buildingId] || runtime.session.save.buildingSchemas[indoorLocation.buildingId] || null;
    if (!currentBuildingSchema) {
      throw new Error(`Missing building schema for ${indoorLocation.buildingId}.`);
    }

    const currentLevelSchema = resolveActiveLevelSchema(currentBuildingSchema, indoorLocation.level);
    if (!currentLevelSchema) {
      throw new Error(`Missing level schema for ${indoorLocation.buildingId} level ${indoorLocation.level}.`);
    }

    runtime.currentBuildingSchema = currentBuildingSchema;
    runtime.currentLevelSchema = currentLevelSchema;
    runtime.indoorTopFloor = isTopFloorOfBuilding(currentBuildingSchema, indoorLocation.level);
    runtime.currentLevelDescription = await ensureLevelDescription({
      buildingId: indoorLocation.buildingId,
      level: indoorLocation.level,
      buildingSchema: currentBuildingSchema,
      activeLevelSchema: currentLevelSchema,
      currentBuildings: context.currentBuildings,
      currentAreas: context.currentAreas,
      nearbyLines: context.nearbyLines,
      isTopFloor: runtime.indoorTopFloor,
    }, runtime.session);
    runtime.activeLargeDescription = runtime.indoorTopFloor
      ? await ensureLargeDescription(runtime.sceneContext, runtime.session)
      : null;
    runtime.activeSmallDescription = null;
    runtime.nearbySmallDescriptions = await findNearbySmallDescriptions(runtime.session, position, 200);
    return coverageSyncTriggered;
  }

  runtime.activeLargeDescription = await ensureLargeDescription(runtime.sceneContext, runtime.session);
  runtime.activeSmallDescription = await ensureSmallDescription(runtime.sceneContext, runtime.session);
  runtime.nearbySmallDescriptions = await mergeNearbySmallDescriptions(
    runtime.session,
    position,
    runtime.activeSmallDescription,
  );

  return coverageSyncTriggered;
}

/**
 * 整理 runtime 里所有 LLM 需要的信息，然后发送给 LLM
 * @param runtime
 * @param options
 * @returns
 */
async function requestModelTurn(
  runtime: TurnRuntime,
  options: RequestModelTurnOptions,
) {
  const messages = await buildModelMessages({
    history: runtime.session.save.messageHistory,
    userMessage: runtime.inputMessage,
    currentTurnToolMessages: runtime.currentTurnToolMessages,
    runtime,
    injectSyntheticSceneRefresh: options.injectSyntheticSceneRefresh,
    syntheticSceneRefreshStage: options.syntheticSceneRefreshStage,
  });

  await writeGameChatMessageSnapshot({
    direction: options.snapshotDirection,
    sessionId: runtime.session.save.sessionId,
    message: runtime.inputMessage,
    messages,
  });

  console.log('[DEBUG] runGameChatTurn() - runChatCompletionWithTools() call');
  const modelResponse = await runChatCompletionWithTools({
    messages,
    tools: options.tools,
  });
  console.log('[DEBUG] runGameChatTurn() - runChatCompletionWithTools() return');

  return modelResponse;
}

/**
 * 根据模型的工具选择，呼叫对应的工具函数对 runtime 进行更新
 * @param runtime
 * @param modelResponse
 * @returns
 */
async function executeToolStep(
  runtime: TurnRuntime,
  modelResponse: ToolEnabledChatResponse,
): Promise<ToolStepResult> {
  if (!modelResponse.toolCall) {
    throw new Error('executeToolStep requires a tool call response.');
  }

  const toolCall = modelResponse.toolCall;
  const assistantToolCallMessage = toStoredAssistantToolCallMessage(
    toolCall,
    modelResponse.assistantMessageForHistory,
  );
  runtime.currentTurnToolMessages.push(assistantToolCallMessage);

  if (toolCall.name === 'move_player') {
    await handleMovePlayerTool(runtime, toolCall, assistantToolCallMessage);
  } else if (toolCall.name === 'look_far') {
    await handleLookFarTool(runtime, assistantToolCallMessage);
  } else {
    throw new Error(`Unsupported tool call: ${toolCall.name}`);
  }

  return {
    remainingTools: GAME_CHAT_TOOLS.filter((tool) => tool.function.name !== toolCall.name),
    injectSyntheticSceneRefresh: toolCall.name !== 'look_far',
    syntheticSceneRefreshStage: `post_${toolCall.name}`,
  };
}

async function handleMovePlayerTool(
  runtime: TurnRuntime,
  toolCall: { id: string; name: string; argumentsText: string },
  assistantToolCallMessage: Extract<GameMessage, { role: 'assistant'; isToolCallMessage: true }>,
): Promise<void> {
  // 工具步骤顺序：
  // 1. 按 bearing/distance 移动经纬度
  // 2. 查询新坐标命中的建筑/区域/线性要素
  // 3. 若命中建筑，则切换到室内入口房间
  // 4. 统一调用 prepareRuntimeForPosition 刷新 runtime
  // 5. 将移动结果写回 tool message，供下一轮 synthetic refresh 使用
  console.log('[DEBUG] runGameChatTurn() - toolCall - move_player');
  const toolInput = parseMovePlayerArguments(toolCall.argumentsText);
  const previousPosition = runtime.session.save.playerPosition;
  const nextPosition = movePosition({
    position: previousPosition,
    bearingDegrees: toolInput.bearingDegrees,
    distanceMeters: toolInput.distanceMeters,
  });

  const context = await loadPositionContext(nextPosition);
  runtime.session.save.playerPosition = nextPosition;

  if (context.currentBuildings.length > 0) {
    const buildingSchemas = await ensureBuildingSchema(context, runtime.session);
    const activeBuildingId = context.currentBuildings[0].buildingId;
    const activeBuildingSchema = buildingSchemas[activeBuildingId] || runtime.session.save.buildingSchemas[activeBuildingId];
    if (!activeBuildingSchema) {
      throw new Error(`Missing active building schema for ${activeBuildingId}.`);
    }

    runtime.session.save.playerIndoorLocation = resolveIndoorEntranceLocation(activeBuildingId, activeBuildingSchema);
  } else {
    runtime.session.save.playerIndoorLocation = null;
  }
  const coverageSyncTriggered = await prepareRuntimeForPosition(runtime, nextPosition, context);

  const movementResult: MovePlayerToolResult = {
    previousPosition,
    nextPosition,
    bearingDegrees: toolInput.bearingDegrees,
    distanceMeters: toolInput.distanceMeters,
    reason: toolInput.reason || '根据用户输入执行移动。',
    targetLabel: toolInput.targetLabel,
    coverageSyncTriggered,
    currentBuildings: context.currentBuildings,
    currentAreas: context.currentAreas,
    nearbyLines: context.nearbyLines,
    enteredBuilding: runtime.session.save.playerIndoorLocation !== null,
    activeBuildingId: runtime.session.save.playerIndoorLocation?.buildingId,
    playerIndoorLocation: runtime.session.save.playerIndoorLocation || undefined,
  };

  runtime.currentTurnToolMessages.push({
    role: 'tool',
    content: JSON.stringify(movementResult),
    toolCallId: assistantToolCallMessage.toolCallId,
    toolName: assistantToolCallMessage.toolName,
  });
}

async function handleLookFarTool(
  runtime: TurnRuntime,
  assistantToolCallMessage: Extract<GameMessage, { role: 'assistant'; isToolCallMessage: true }>,
): Promise<void> {
  console.log('[DEBUG] runGameChatTurn() - toolCall - look_far');
  runtime.promptSummaryMode = 'concise_far';
  const lookFarResult: LookFarToolResult = await buildSceneContextSnapshotPayload(runtime, runtime.promptSummaryMode);

  runtime.currentTurnToolMessages.push({
    role: 'tool',
    content: JSON.stringify(lookFarResult),
    toolCallId: assistantToolCallMessage.toolCallId,
    toolName: assistantToolCallMessage.toolName,
  });
}

/**
 * 得到 LLM 返回的消息后，相应更新 runtime
 * @param runtime
 * @param modelResponse
 * @returns 将被 runChatTurn 发送给前端的数据
 */
async function finalizeTurn(
  runtime: TurnRuntime,
  modelResponse: ToolEnabledChatResponse,
): Promise<GameChatResponse> {
  const assistantMessage = modelResponse.reply
    || runtime.currentLevelDescription?.descriptionText
    || runtime.activeLargeDescription?.descriptionText
    || '';
  const persistedToolMessages = redactToolMessagesForStorage(runtime.currentTurnToolMessages);
  // 组装被存入存档的历史对话
  const messagesToAppend: GameMessage[] = [
    runtime.userMessage,
    ...persistedToolMessages,
    {
      role: 'assistant',
      content: assistantMessage,
      reasoningContent: modelResponse.assistantMessageForHistory.reasoningContent,
    },
  ];

  // 更新 runtime 数据
  runtime.session.save.activeLargeDescriptionId = runtime.activeLargeDescription?.id || null;
  runtime.session.save.visibleSmallDescriptionIds = runtime.nearbySmallDescriptions.map((record) => record.id);
  updateLastSceneContextMeta(runtime.session, {
    diagnostics: runtime.sceneContext.diagnostics,
  });
  const nextHistory: GameMessage[] = [
    ...runtime.session.save.messageHistory,
    ...messagesToAppend,
  ];
  runtime.session.save.messageHistory = trimMessageHistoryPreservingToolChains(nextHistory, MAX_STORED_TURNS);
  await updateSession(runtime.session);

  // 组装被写入快照的历史对话
  const finalMessages = await buildModelMessages({
    history: runtime.session.save.messageHistory,
    runtime,
    injectSyntheticSceneRefresh: false,
  });
  await writeGameChatMessageSnapshot({
    direction: 'from-llm',
    sessionId: runtime.session.save.sessionId,
    message: runtime.inputMessage,
    messages: finalMessages,
  });

  return {
    sessionId: runtime.session.save.sessionId,
    messages: toClientMessages(runtime.session.save.messageHistory),
    playerPosition: runtime.session.save.playerPosition,
    activeLargeDescription: toClientLargeDescription(runtime.activeLargeDescription),
    nearbySmallDescriptions: toClientSmallDescriptions(runtime.nearbySmallDescriptions),
    playerIndoorLocation: runtime.session.save.playerIndoorLocation,
    currentBuildingSchema: runtime.currentBuildingSchema,
    currentLevelSchema: runtime.currentLevelSchema,
    currentLevelDescription: toClientLevelDescription(runtime.currentLevelDescription),
  };
}

function buildHistoryMessages(history: GameMessage[]): ChatRequestMessage[] {
  // 这里把存档中的规范化消息重新转回 chat completion API 能接受的消息数组。
  const messages: ChatRequestMessage[] = [];

  for (const message of history) {
    if (message.role === 'user') {
      messages.push({ role: 'user', content: message.content });
      continue;
    }

    if (message.role === 'assistant' && message.isToolCallMessage) {
      messages.push({
        role: 'assistant',
        content: message.content,
        reasoning_content: message.reasoningContent,
        tool_calls: [{
          id: message.toolCallId,
          type: 'function',
          function: {
            name: message.toolName,
            arguments: message.toolArgumentsText,
          },
        }],
      });
      continue;
    }

    if (message.role === 'assistant') {
      messages.push({
        role: 'assistant',
        content: message.content,
        reasoning_content: message.reasoningContent,
      });
      continue;
    }

    messages.push({
      role: 'tool',
      content: message.content,
      tool_call_id: message.toolCallId,
    });
  }

  return messages;
}

/**
 * 为每轮对话构建系统提示词
 * @param sceneContext
 * @param largeDescription
 * @param nearbySmallDescriptions 用于组建上下文当中来自小描述的部分
 * @returns
 */
function buildGameSystemPrompt(): string {
  return [
    '你是一个文字探索游戏的会话助手。',
    '如果用户要求真实移动，调用 move_player 工具；如果用户要求观察远处、确认远方情况，或准备前往远处前先看一眼，则调用 look_far 工具；否则直接自然回复。',
    '即使用户要求移动了，也需要结合周遭环境信息分析能否成功到达，是否有阻碍移动的要素。如果有，可以将移动的目的地截停在障碍前。',
    '如果用户寻求建议或者提出问题，回答时应减少你的存在感，让回答看起来像是用户自己寻思出来的结论或者自问自答。',
    '如果用户输入的内容与游戏完全无关，或者根据当前游戏情景完全不可能，通过看起来像是用户自言自语的方式回绝这个输入。',
    styleRule,
    '叙述视角：\n第二人称“你”，以玩家为中心进行描述，使用类似“你所在的位置”“在你附近”“更远处”等空间表达。',
    '不要在文本回复里暴露经纬度、网格、极坐标等内部实现。',
    '请优先保持空间连续性。',
    '如果消息流中出现 type 为 scene_context_snapshot 的 tool 返回，请将其视为该时刻最新的环境快照，只对最新对话负责，不要倒推覆盖更早历史。',
  ].join('\n');
}

async function buildModelMessages(input: {
  history: GameMessage[];
  runtime: TurnRuntime;
  userMessage?: string;
  currentTurnToolMessages?: GameMessage[];
  injectSyntheticSceneRefresh: boolean;
  syntheticSceneRefreshStage?: string;
}): Promise<ChatRequestMessage[]> {
  const messages: ChatRequestMessage[] = [
    {
      role: 'system',
      content: buildGameSystemPrompt(),
    },
    ...buildHistoryMessages(input.history),
  ];

  if (input.userMessage) {
    messages.push({ role: 'user', content: input.userMessage });
  }

  if (input.currentTurnToolMessages?.length) {
    messages.push(...buildHistoryMessages(input.currentTurnToolMessages));
  }

  if (input.injectSyntheticSceneRefresh) {
    messages.push(...buildSyntheticSceneContextMessages({
      stage: input.syntheticSceneRefreshStage || 'runtime',
      payload: await buildSceneContextSnapshotPayload(input.runtime, input.runtime.promptSummaryMode),
    }));
  }

  return messages;
}

async function mergeNearbySmallDescriptions(
  session: LoadedGameSession,
  position: SceneContext['position'],
  activeSmallDescription: SmallDescriptionRecord | null,
): Promise<SmallDescriptionRecord[]> {
  if (!activeSmallDescription) {
    return findNearbySmallDescriptions(session, position, 200);
  }

  // 确保“当前命中的小描述”一定出现在首页 200m 列表中，
  // 即使索引查询排序或时序上暂时没把它带回来。
  const nearby = await findNearbySmallDescriptions(session, position, 200);
  const merged = nearby.some((record) => record.id === activeSmallDescription.id)
    ? nearby
    : [activeSmallDescription, ...nearby];

  return merged.sort((left, right) => (left.distanceMeters || 0) - (right.distanceMeters || 0));
}

function parseMovePlayerArguments(argumentsText: string): MovePlayerToolInput {
  // LLM tool call 的 arguments 本质上是字符串，这里负责把它收敛成严格的 TS 输入。
  let parsed: Record<string, unknown> = {};

  try {
    parsed = JSON.parse(argumentsText) as Record<string, unknown>;
  } catch {
    parsed = {};
  }

  const bearingDegrees = Number(parsed.bearingDegrees);
  const distanceMeters = Number(parsed.distanceMeters);

  if (!Number.isFinite(bearingDegrees) || !Number.isFinite(distanceMeters)) {
    throw new Error('move_player tool returned invalid arguments.');
  }

  return {
    bearingDegrees,
    distanceMeters,
    reason: typeof parsed.reason === 'string' ? parsed.reason : undefined,
    targetLabel: typeof parsed.targetLabel === 'string' ? parsed.targetLabel : undefined,
  };
}

async function loadPositionContext(position: GamePosition): Promise<PositionContextBundle> {
  // 与 runtime 准备解耦的纯位置查询封装。
  // 这里不做 coverage 判断，也不生成任何描述，只返回后续室内/室外决策会用到的原始位置上下文。
  const [currentBuildings, currentAreas, nearbyLines] = await Promise.all([
    findBuildingsAtPosition(position),
    findAreasAtPosition(position),
    findNearbyLinesAtPosition(position),
  ]);

  return {
    currentBuildings,
    currentAreas,
    nearbyLines,
  };
}

async function buildSceneContextSnapshotPayload(
  runtime: TurnRuntime,
  summaryMode: SceneContextSummaryMode,
): Promise<SceneContextSnapshotPayload> {
  return buildSceneContextSnapshotPayloadFromInput({
    runtime,
    summaryMode,
  });
}

async function buildSceneContextSnapshotPayloadFromInput(input: {
  runtime: TurnRuntime;
  summaryMode: SceneContextSummaryMode;
}): Promise<SceneContextSnapshotPayload> {
  // synthetic refresh 会把“当前可用的最新场景状态”压成一个 tool 返回：
  // - 室内非顶层：仅提供 levelSchema + levelDescription
  // - 室内顶层：额外补充 activeSummary + largeDescription，让模型可描述从顶层看到的外部环境
  // - 室外：保持原有 activeSummary + largeDescription 路径
  const farVisibleNotes = filterFarVisibleSmallDescriptions(input.runtime.nearbySmallDescriptions, input.runtime.sceneContext.position);
  const nearbyFarVisibleDetails = farVisibleNotes.map((record) => ({
    distanceMeters: Math.round(record.distanceMeters || 0),
    notes: record.farVisibleNotes || '',
  }));

  if (input.runtime.session.save.playerIndoorLocation && input.runtime.currentLevelSchema && input.runtime.currentLevelDescription) {
    const payload: SceneContextSnapshotPayload = {
      type: 'scene_context_snapshot',
      context: 'indoor',
      summaryMode: input.summaryMode,
      levelSchema: input.runtime.currentLevelSchema,
      levelDescription: input.runtime.currentLevelDescription.descriptionText,
      nearbyFarVisibleDetails,
      ...(input.runtime.indoorTopFloor && input.runtime.activeLargeDescription
        ? {
            activeSummary: await buildProjectedSceneSummary(
              input.runtime.sceneContext.position,
              SCENE_CONTEXT_SUMMARY_MODE_TO_PREVIEW_MODE[input.summaryMode],
              'game',
            ),
            largeDescription: input.runtime.activeLargeDescription.descriptionText,
          }
        : {}),
    };
    return payload;
  }

  if (!input.runtime.activeLargeDescription) {
    throw new Error('Outdoor scene snapshot requires activeLargeDescription.');
  }

  return {
    type: 'scene_context_snapshot',
    context: 'outdoor',
    summaryMode: input.summaryMode,
    largeDescription: input.runtime.activeLargeDescription.descriptionText,
    activeSummary: await buildProjectedSceneSummary(
      input.runtime.sceneContext.position,
      SCENE_CONTEXT_SUMMARY_MODE_TO_PREVIEW_MODE[input.summaryMode],
      'game',
    ),
    nearbyFarVisibleDetails,
  };
}

function buildSyntheticSceneContextMessages(input: {
  stage: string;
  payload: SceneContextSnapshotPayload;
}): ChatRequestMessage[] {
  const toolCallId = `synthetic_scene_context_${input.stage}`;

  return [
    {
      role: 'assistant',
      content: '',
      reasoning_content: '',
      tool_calls: [{
        id: toolCallId,
        type: 'function',
        function: {
          name: SYNTHETIC_SCENE_CONTEXT_TOOL_NAME,
          arguments: SYNTHETIC_SCENE_CONTEXT_TOOL_ARGUMENTS,
        },
      }],
    },
    {
      role: 'tool',
      content: JSON.stringify(input.payload),
      tool_call_id: toolCallId,
    },
  ];
}

function trimMessageHistoryPreservingToolChains(history: GameMessage[], maxTurns: number): GameMessage[] {
  if (history.length === 0 || maxTurns <= 0) {
    return [];
  }

  const turns = splitHistoryIntoTurns(history);
  const trimmedTurns = turns.slice(-maxTurns);
  return sanitizeStoredHistory(trimmedTurns.flat());
}

function splitHistoryIntoTurns(history: GameMessage[]): GameMessage[][] {
  const turns: GameMessage[][] = [];
  let currentTurn: GameMessage[] = [];

  for (const message of history) {
    if (message.role === 'user') {
      if (currentTurn.length > 0) {
        turns.push(currentTurn);
      }
      currentTurn = [message];
      continue;
    }

    if (currentTurn.length === 0) {
      continue;
    }

    currentTurn.push(message);
  }

  if (currentTurn.length > 0) {
    turns.push(currentTurn);
  }

  return turns;
}

function sanitizeStoredHistory(history: GameMessage[]): GameMessage[] {
  const sanitized: GameMessage[] = [];

  for (const [index, message] of history.entries()) {
    if (message.role === 'user') {
      sanitized.push(message);
      continue;
    }

    if (message.role === 'assistant' && message.isToolCallMessage) {
      const nextMessage = history[index + 1];
      if (nextMessage?.role !== 'tool' || nextMessage.toolCallId !== message.toolCallId) {
        continue;
      }

      sanitized.push(message);
      continue;
    }

    if (message.role === 'tool') {
      const previousMessage = sanitized.at(-1);
      if (
        previousMessage?.role !== 'assistant'
        || previousMessage.isToolCallMessage !== true
        || previousMessage.toolCallId !== message.toolCallId
      ) {
        continue;
      }

      sanitized.push(message);
      continue;
    }

    sanitized.push(message);
  }

  return sanitized;
}

function toStoredAssistantToolCallMessage(
  toolCall: { id: string; name: string; argumentsText: string },
  message: AssistantHistoryMessage,
): Extract<GameMessage, { role: 'assistant'; isToolCallMessage: true }> {
  return {
    role: 'assistant',
    content: message.content,
    reasoningContent: message.reasoningContent,
    isToolCallMessage: true,
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    toolArgumentsText: toolCall.argumentsText,
  };
}

function redactToolMessagesForStorage(messages: GameMessage[]): GameMessage[] {
  return messages.map((message) => {
    if (message.role !== 'tool' || message.toolName !== 'look_far') {
      return message;
    }

    return {
      ...message,
      content: buildRedactedLookFarToolContent(message.content),
    };
  });
}

function buildRedactedLookFarToolContent(content: string): string {
  const parsed = tryParseSceneContextSnapshotPayload(content);

  if (!parsed) {
    return JSON.stringify({
      type: 'scene_context_snapshot',
      redacted: true,
      note: 'look_far tool content removed after LLM consumption to reduce stored context size.',
    });
  }

  return JSON.stringify({
    type: parsed.type,
    summaryMode: parsed.summaryMode,
    redacted: true,
    note: 'look_far tool content removed after LLM consumption to reduce stored context size.',
  });
}

function tryParseSceneContextSnapshotPayload(content: string): {
  type: 'scene_context_snapshot';
  summaryMode?: SceneContextSummaryMode;
} | null {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }

    const candidate = parsed as Record<string, unknown>;
    if (candidate.type !== 'scene_context_snapshot') {
      return null;
    }

    return {
      type: 'scene_context_snapshot',
      summaryMode: typeof candidate.summaryMode === 'string'
        ? candidate.summaryMode as SceneContextSummaryMode
        : undefined,
    };
  } catch {
    return null;
  }
}

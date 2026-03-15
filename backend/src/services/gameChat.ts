import { movePosition } from './gameMovement.js';
import { ensureCoverageForPosition, loadSceneContext } from './gameScene.js';
import {
  getOrCreateSession,
  toClientLargeDescription,
  toClientMessages,
  toClientSmallDescriptions,
  updateLastSceneContextMeta,
  updateSession,
} from './gameSessionStore.js';
import {
  runChatCompletionWithTools,
  type AssistantHistoryMessage,
  type ChatRequestMessage,
  type ToolDefinition,
} from './llm.js';
import { writeGameChatMessageSnapshot } from './gameChatDebugLog.js';
import { findNearbySmallDescriptions } from './sceneDescriptionRepository.js';
import { ensureLargeDescription, ensureSmallDescription, filterFarVisibleSmallDescriptions } from './sceneDescriptionService.js';
import { buildSceneSummaryForGamePosition, resolveSceneContextSummaryMode } from './scene/sceneSummaryService.js';
import type {
  GameChatResponse,
  GameMessage,
  GameChatRequest,
  LookFarToolResult,
  LoadedGameSession,
  MovePlayerToolInput,
  MovePlayerToolResult,
  SceneContextSnapshotPayload,
  SceneContextSummaryMode,
  SceneContext,
  SmallDescriptionRecord,
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
  await ensureCoverageForPosition(session.save.playerPosition);
  let sceneContext = await loadSceneContext(session.save.playerPosition);
  let activeLargeDescription = await ensureLargeDescription(sceneContext, session);
  let activeSmallDescription = await ensureSmallDescription(sceneContext, session);
  let nearbySmallDescriptions = await mergeNearbySmallDescriptions(session, session.save.playerPosition, activeSmallDescription);
  let promptSummaryMode: SceneContextSummaryMode = 'concise_near';
  const userMessage: GameMessage = {
    role: 'user',
    content: input.message,
    isOpeningPrompt: input.isOpeningPrompt === true,
  };
  const initialMessages = await buildModelMessages({
    history: session.save.messageHistory,
    userMessage: input.message,
    currentTurnToolMessages: [],
    sceneContext,
    largeDescription: activeLargeDescription.descriptionText,
    nearbySmallDescriptions,
    promptSummaryMode,
    injectSyntheticSceneRefresh: true,
    syntheticSceneRefreshStage: 'initial',
  });
  await writeGameChatMessageSnapshot({
    direction: 'to-llm',
    sessionId: session.save.sessionId,
    message: input.message,
    messages: initialMessages,
  });

  console.log('[DEBUG] runGameChatTurn() - first runChatCompletionWithTools() call');
  let modelResponse = await runChatCompletionWithTools({
    messages: initialMessages,
    tools: GAME_CHAT_TOOLS,
  });
  console.log('[DEBUG] runGameChatTurn() - first runChatCompletionWithTools() return');

  const messagesToAppend: GameMessage[] = [userMessage];
  const currentTurnToolMessages: GameMessage[] = [];

  while (modelResponse.toolCall) {
    const assistantToolCallMessage = toStoredAssistantToolCallMessage(
      modelResponse.toolCall,
      modelResponse.assistantMessageForHistory,
    );
    currentTurnToolMessages.push(assistantToolCallMessage);

    if (modelResponse.toolCall.name === 'move_player') {
      console.log('[DEBUG] runGameChatTurn() - toolCall - move_player');
      // 工具调用只负责决定位移；真正的坐标计算、补洞和描述更新都由后端执行。
      const toolInput = parseMovePlayerArguments(modelResponse.toolCall.argumentsText);
      const nextPosition = movePosition({
        position: session.save.playerPosition,
        bearingDegrees: toolInput.bearingDegrees,
        distanceMeters: toolInput.distanceMeters,
      });

      const moveCoverageSyncTriggered = await ensureCoverageForPosition(nextPosition);
      sceneContext = await loadSceneContext(nextPosition);
      activeLargeDescription = await ensureLargeDescription(sceneContext, session);
      activeSmallDescription = await ensureSmallDescription(sceneContext, session);
      nearbySmallDescriptions = await mergeNearbySmallDescriptions(session, nextPosition, activeSmallDescription);

      const movementResult: MovePlayerToolResult = {
        previousPosition: session.save.playerPosition,
        nextPosition,
        bearingDegrees: toolInput.bearingDegrees,
        distanceMeters: toolInput.distanceMeters,
        reason: toolInput.reason || '根据用户输入执行移动。',
        targetLabel: toolInput.targetLabel,
        coverageSyncTriggered: moveCoverageSyncTriggered,
      };
      session.save.playerPosition = nextPosition;

      currentTurnToolMessages.push({
        role: 'tool',
        content: JSON.stringify(movementResult),
        toolCallId: assistantToolCallMessage.toolCallId,
        toolName: assistantToolCallMessage.toolName,
      });
    } else if (modelResponse.toolCall.name === 'look_far') {
      console.log('[DEBUG] runGameChatTurn() - toolCall - look_far');
      promptSummaryMode = 'concise_far';
      const lookFarResult: LookFarToolResult = await buildSceneContextSnapshotPayload({
        sceneContext,
        largeDescription: activeLargeDescription.descriptionText,
        nearbySmallDescriptions,
        summaryMode: promptSummaryMode,
      });

      currentTurnToolMessages.push({
        role: 'tool',
        content: JSON.stringify(lookFarResult),
        toolCallId: assistantToolCallMessage.toolCallId,
        toolName: assistantToolCallMessage.toolName,
      });
    } else {
      throw new Error(`Unsupported tool call: ${modelResponse.toolCall.name}`);
    }

    const shouldInjectSyntheticSceneRefresh = modelResponse.toolCall.name !== 'look_far';
    const followUpMessages = await buildModelMessages({
      history: session.save.messageHistory,
      userMessage: input.message,
      currentTurnToolMessages,
      sceneContext,
      largeDescription: activeLargeDescription.descriptionText,
      nearbySmallDescriptions,
      promptSummaryMode,
      injectSyntheticSceneRefresh: shouldInjectSyntheticSceneRefresh,
      syntheticSceneRefreshStage: `post_${modelResponse.toolCall.name}`,
    });
    // TODO 这个机制是否允许连续调用同一个工具？
    const remainingTools = GAME_CHAT_TOOLS.filter((tool) => tool.function.name !== modelResponse.toolCall?.name);

    await writeGameChatMessageSnapshot({
      direction: 'to-llm',
      sessionId: session.save.sessionId,
      message: input.message,
      messages: followUpMessages,
    });

    console.log('[DEBUG] runGameChatTurn() - toolCall runChatCompletionWithTools() call');
    modelResponse = await runChatCompletionWithTools({
      messages: followUpMessages,
      tools: remainingTools,
    });
    console.log('[DEBUG] runGameChatTurn() - toolCall runChatCompletionWithTools() return');
  }

  const assistantMessage = modelResponse.reply || activeLargeDescription.descriptionText;
  messagesToAppend.push(
    ...currentTurnToolMessages,
    {
      role: 'assistant',
      content: assistantMessage,
      reasoningContent: modelResponse.assistantMessageForHistory.reasoningContent,
    },
  );

  session.save.activeLargeDescriptionId = activeLargeDescription.id;
  session.save.visibleSmallDescriptionIds = nearbySmallDescriptions.map((record) => record.id);
  updateLastSceneContextMeta(session, {
    diagnostics: sceneContext.diagnostics,
  });
  const nextHistory: GameMessage[] = [
    ...session.save.messageHistory,
    ...messagesToAppend,
  ];
  session.save.messageHistory = trimMessageHistoryPreservingToolChains(nextHistory, MAX_STORED_TURNS);
  await updateSession(session);
  const finalMessages = await buildModelMessages({
    history: session.save.messageHistory,
    sceneContext,
    largeDescription: activeLargeDescription.descriptionText,
    nearbySmallDescriptions,
    promptSummaryMode,
    injectSyntheticSceneRefresh: false,
  });
  await writeGameChatMessageSnapshot({
    direction: 'from-llm',
    sessionId: session.save.sessionId,
    message: input.message,
    messages: finalMessages,
  });

  return {
    sessionId: session.save.sessionId,
    messages: toClientMessages(session.save.messageHistory),
    playerPosition: session.save.playerPosition,
    activeLargeDescription: toClientLargeDescription(activeLargeDescription),
    nearbySmallDescriptions: toClientSmallDescriptions(nearbySmallDescriptions),
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
    styleRule,
    '叙述视角：\n第二人称“你”，以玩家为中心进行描述，使用类似“你所在的位置”“在你附近”“更远处”等空间表达。',
    '不要在文本回复里暴露经纬度、网格、极坐标等内部实现。',
    '请优先保持空间连续性。',
    '如果消息流中出现 type 为 scene_context_snapshot 的 tool 返回，请将其视为该时刻最新的环境快照，只对最新对话负责，不要倒推覆盖更早历史。',
  ].join('\n');
}

async function buildModelMessages(input: {
  history: GameMessage[];
  sceneContext: SceneContext;
  largeDescription: string;
  nearbySmallDescriptions: SmallDescriptionRecord[];
  promptSummaryMode: SceneContextSummaryMode;
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
      payload: await buildSceneContextSnapshotPayload({
        sceneContext: input.sceneContext,
        largeDescription: input.largeDescription,
        nearbySmallDescriptions: input.nearbySmallDescriptions,
        summaryMode: input.promptSummaryMode,
      }),
    }));
  }

  return messages;
}

async function mergeNearbySmallDescriptions(
  session: LoadedGameSession,
  position: SceneContext['position'],
  activeSmallDescription: SmallDescriptionRecord,
): Promise<SmallDescriptionRecord[]> {
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

async function buildSceneContextSnapshotPayload(input: {
  sceneContext: SceneContext;
  largeDescription: string;
  nearbySmallDescriptions: SmallDescriptionRecord[];
  summaryMode: SceneContextSummaryMode;
}): Promise<SceneContextSnapshotPayload> {
  const farVisibleNotes = filterFarVisibleSmallDescriptions(input.nearbySmallDescriptions, input.sceneContext.position);

  return {
    type: 'scene_context_snapshot',
    summaryMode: input.summaryMode,
    largeDescription: input.largeDescription,
    activeSummary: await buildSceneSummaryForGamePosition(
      input.sceneContext.position,
      resolveSceneContextSummaryMode(input.summaryMode),
    ),
    nearbyFarVisibleDetails: farVisibleNotes.map((record) => ({
      distanceMeters: Math.round(record.distanceMeters || 0),
      notes: record.farVisibleNotes || '',
    })),
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

import { movePosition } from './gameMovement.js';
import { ensureCoverageForPosition, loadSceneContext } from './gameScene.js';
import { getOrCreateSession, updateLastSceneContextMeta, updateSession } from './gameSessionStore.js';
import {
  runChatCompletionWithTools,
  type AssistantHistoryMessage,
  type ChatRequestMessage,
  type ToolDefinition,
} from './llm.js';
import { writeGameChatMessageSnapshot } from './gameChatDebugLog.js';
import { findNearbySmallDescriptions } from './sceneDescriptionRepository.js';
import { ensureLargeDescription, ensureSmallDescription, filterFarVisibleSmallDescriptions } from './sceneDescriptionService.js';
import type {
  GameChatResponse,
  GameMessage,
  GameChatRequest,
  LookFarToolResult,
  LoadedGameSession,
  MovePlayerToolInput,
  MovePlayerToolResult,
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

type PromptSummaryMode = 'small' | 'large';

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
  let coverageSyncTriggered = await ensureCoverageForPosition(session.save.playerPosition);
  let sceneContext = await loadSceneContext(session.save.playerPosition);
  let activeLargeDescription = await ensureLargeDescription(sceneContext, session);
  let activeSmallDescription = await ensureSmallDescription(sceneContext, session);
  let nearbySmallDescriptions = await mergeNearbySmallDescriptions(session, session.save.playerPosition, activeSmallDescription);
  let promptSummaryMode: PromptSummaryMode = 'small';
  const userMessage: GameMessage = {
    role: 'user',
    content: input.message,
    isOpeningPrompt: input.isOpeningPrompt === true,
  };
  const initialSystemMessage: ChatRequestMessage = {
    role: 'system',
    content: buildGameSystemPrompt(sceneContext, activeLargeDescription.descriptionText, nearbySmallDescriptions, promptSummaryMode),
  };
  const initialMessages: ChatRequestMessage[] = [
    initialSystemMessage,
    ...buildHistoryMessages(session.save.messageHistory),
    { role: 'user', content: input.message },
  ];
  await writeGameChatMessageSnapshot({
    direction: 'from-frontend',
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

  let movementResult: MovePlayerToolResult | null = null;
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
      coverageSyncTriggered = coverageSyncTriggered || moveCoverageSyncTriggered;
      sceneContext = await loadSceneContext(nextPosition);
      activeLargeDescription = await ensureLargeDescription(sceneContext, session);
      activeSmallDescription = await ensureSmallDescription(sceneContext, session);
      nearbySmallDescriptions = await mergeNearbySmallDescriptions(session, nextPosition, activeSmallDescription);

      movementResult = {
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
      promptSummaryMode = 'large';
      const lookFarResult: LookFarToolResult = {
        mode: 'large_summary',
      };

      currentTurnToolMessages.push({
        role: 'tool',
        content: JSON.stringify(lookFarResult),
        toolCallId: assistantToolCallMessage.toolCallId,
        toolName: assistantToolCallMessage.toolName,
      });
    } else {
      throw new Error(`Unsupported tool call: ${modelResponse.toolCall.name}`);
    }

    const followUpMessages: ChatRequestMessage[] = [
      {
        role: 'system',
        content: buildGameSystemPrompt(
          sceneContext,
          activeLargeDescription.descriptionText,
          nearbySmallDescriptions,
          promptSummaryMode,
        ),
      },
      ...buildHistoryMessages(session.save.messageHistory),
      { role: 'user', content: input.message },
      ...buildHistoryMessages(currentTurnToolMessages),
    ];
    const remainingTools = GAME_CHAT_TOOLS.filter((tool) => tool.function.name !== modelResponse.toolCall?.name);

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
  // 仅保存最近12条历史对话。
  session.save.messageHistory = nextHistory.slice(-12);
  await updateSession(session);
  const finalMessages: ChatRequestMessage[] = [
    {
      role: 'system',
      content: buildGameSystemPrompt(
        sceneContext,
        activeLargeDescription.descriptionText,
        nearbySmallDescriptions,
        promptSummaryMode,
      ),
    },
    ...buildHistoryMessages(session.save.messageHistory),
  ];
  await writeGameChatMessageSnapshot({
    direction: 'to-frontend',
    sessionId: session.save.sessionId,
    message: input.message,
    messages: finalMessages,
  });

  return {
    sessionId: session.save.sessionId,
    messages: session.save.messageHistory,
    assistantMessage,
    playerPosition: session.save.playerPosition,
    movementResult,
    activeLargeDescription,
    nearbySmallDescriptions,
    debugSceneMeta: {
      diagnostics: sceneContext.diagnostics,
      coverageSyncTriggered,
    },
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
function buildGameSystemPrompt(
  sceneContext: SceneContext,
  largeDescription: string,
  nearbySmallDescriptions: SmallDescriptionRecord[],
  promptSummaryMode: PromptSummaryMode,
): string {
  // 这个 system prompt 不是直接给玩家看的文本，
  // 而是把“当前大描述 + 当前局部 summary + 周边小描述远距细节”重新组织成一轮会话上下文。
  const farVisibleNotes = filterFarVisibleSmallDescriptions(nearbySmallDescriptions, sceneContext.position);
  const nearbyText = farVisibleNotes.length > 0
    ? farVisibleNotes.map((record) => `- 距离约${Math.round(record.distanceMeters || 0)}m：${record.farVisibleNotes}`).join('\n')
    : '无';
  const activeSummary = promptSummaryMode === 'large' ? sceneContext.largeSummary : sceneContext.smallSummary;
  const summaryLabel = promptSummaryMode === 'large'
    ? '当前位置的程序生成的远眺摘要（1公里）：'
    : '当前位置的程序生成的局部摘要（约300米）：';

  return [
    '你是一个文字探索游戏的会话助手。',
    '如果用户要求真实移动，调用 move_player 工具；如果用户要求观察远处、确认远方情况，或准备前往远处前先看一眼，则调用 look_far 工具；否则直接自然回复。',
    '即使用户要求移动了，也需要结合周遭环境信息分析能否成功到达，是否有阻碍移动的要素。如果有，可以将移动的目的地截停在障碍前。',
    styleRule,
    '不要在文本回复里暴露经纬度、网格、极坐标等内部实现。',
    '请优先保持空间连续性，并参考当前区域的总体环境描述和附近其他地点的远距可见细节。',
    '',
    `当前总体环境描述：${largeDescription}`,
    '',
    summaryLabel,
    activeSummary,
    '',
    '200米内其他地点的远距可见细节：',
    nearbyText,
  ].join('\n');
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

import { movePosition } from './gameMovement.js';
import { ensureCoverageForPosition, loadSceneContext } from './gameScene.js';
import { getOrCreateSession, updateLastSceneContextMeta, updateSession } from './gameSessionStore.js';
import { generateReplyWithSystemPrompt, runChatCompletionWithTools, type ToolDefinition } from './llm.js';
import { findNearbySmallDescriptions } from './sceneDescriptionRepository.js';
import { ensureLargeDescription, ensureSmallDescription, filterFarVisibleSmallDescriptions } from './sceneDescriptionService.js';
import type {
  GameChatResponse,
  GameMessage,
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

export async function runGameChatTurn(input: {
  sessionId?: string;
  message: string;
}): Promise<GameChatResponse> {
  // 一次正式回合的主流程：
  // 1. 找或建 session
  // 2. 确保当前位置有覆盖数据
  // 3. 装载场景并复用/生成描述
  // 4. 让模型决定是否调用 move_player
  // 5. 若移动则刷新场景和描述，再生成最终自然语言回复
  const session = await getOrCreateSession(input.sessionId);
  let coverageSyncTriggered = await ensureCoverageForPosition(session.save.playerPosition);
  let sceneContext = await loadSceneContext(session.save.playerPosition);
  let activeLargeDescription = await ensureLargeDescription(sceneContext, session);
  let activeSmallDescription = await ensureSmallDescription(sceneContext, session);
  let nearbySmallDescriptions = await mergeNearbySmallDescriptions(session, session.save.playerPosition, activeSmallDescription);

  // 由于有提供了工具，modelResponse 可能为实际的文本回复，或者是一个工具调用请求
  // 类似 [sys, user, res] 或者 [sys, user, toolcall]
  console.log('[DEBUG] runGameChatTurn() - runChatCompletionWithTools() call');
  const modelResponse = await runChatCompletionWithTools({
    messages: [
      { role: 'system', content: buildGameSystemPrompt(sceneContext, activeLargeDescription.descriptionText, nearbySmallDescriptions) },
      ...buildHistoryMessages(session.save.messageHistory),
      { role: 'user', content: input.message },
    ],
    tools: [MOVE_PLAYER_TOOL],
  });
  console.log('[DEBUG] runGameChatTurn() - runChatCompletionWithTools() call');

  let movementResult: MovePlayerToolResult | null = null;
  // 这里先假设 modelResponse 为实际的文本回复，也就是 [sys, user, res] 结构。
  // 因此便可以顺利组装成 [sys, user, assist(来自res), <slot for next 'user'>]
  let assistantMessage = modelResponse.reply || activeLargeDescription.descriptionText;

  if (modelResponse.toolCall?.name === 'move_player') {
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

    // 由于已确认 modelResponse 是一个工具调用请求，结构为 [sys, user, toolcall]
    // toolcall 经过上面步骤的计算，变成了 movementResult 等信息
    // 下一步可以组装成 [sys, user, assist(来自movementResult, activeXxxDescription等), <slot for next 'user'>]
    // TODO:
    // 由于目前的结构非常简单，LLM 不用处理信息，只负责描述和判断移动，所以可以这么处理（把 toolreturn 种种全部打包伪装成 assistant）
    // 这是这一版的妥协，以后肯定得想办法改掉。
    console.log('[DEBUG] runGameChatTurn() - generateReplyWithSystemPrompt() call');
    assistantMessage = (
      await generateReplyWithSystemPrompt(
        [
          '你是一个文字探索游戏中的叙述助手。',
          '玩家已经完成一次移动。',
          '请根据新的环境上下文，输出自然语言回复。',
          '如果用户输入是移动指令，应确认移动后的所见环境。',
          '不要提及工具调用、经纬度或内部实现。',
        ].join('\n'),
        [
          `用户输入：${input.message}`,
          `移动过程：方位${Math.round(movementResult.bearingDegrees)}°，距离${Math.round(movementResult.distanceMeters)}m。`,
          `移动后总体描述：${activeLargeDescription.descriptionText}`,
          `移动后局部描述：\n${activeSmallDescription.descriptionText}\n${activeSmallDescription.farVisibleNotes}`,
        ].join('\n\n'),
      )
    ).reply;
    console.log('[DEBUG] runGameChatTurn() - generateReplyWithSystemPrompt() return');

    session.save.playerPosition = nextPosition;
  }

  session.save.activeLargeDescriptionId = activeLargeDescription.id;
  session.save.visibleSmallDescriptionIds = nearbySmallDescriptions.map((record) => record.id);
  updateLastSceneContextMeta(session, {
    diagnostics: sceneContext.diagnostics,
    largeSceneSignature: sceneContext.largeSceneSignature,
    smallSceneSignature: sceneContext.smallSceneSignature,
  });
  const nextHistory: GameMessage[] = [
    ...session.save.messageHistory,
    { role: 'user', content: input.message },
    { role: 'assistant', content: assistantMessage },
  ];
  session.save.messageHistory = nextHistory.slice(-12);
  await updateSession(session);

  return {
    sessionId: session.save.sessionId,
    assistantMessage,
    playerPosition: session.save.playerPosition,
    movementResult,
    activeLargeDescription,
    nearbySmallDescriptions,
    debugSceneMeta: {
      diagnostics: sceneContext.diagnostics,
      largeSceneSignature: sceneContext.largeSceneSignature,
      smallSceneSignature: sceneContext.smallSceneSignature,
      coverageSyncTriggered,
    },
  };
}

function buildHistoryMessages(history: GameMessage[]): Array<{ role: 'user' | 'assistant'; content: string }> {
  // 正式游戏回合只把 user/assistant 历史喂给模型，
  // system prompt 与 tool 结果则由当前回合显式重建。
  return history
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => ({
      role: message.role as 'user' | 'assistant',
      content: message.content,
    }));
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
): string {
  // 这个 system prompt 不是直接给玩家看的文本，
  // 而是把“当前大描述 + 当前局部 summary + 周边小描述远距细节”重新组织成一轮会话上下文。
  const farVisibleNotes = filterFarVisibleSmallDescriptions(nearbySmallDescriptions, sceneContext.position);
  const nearbyText = farVisibleNotes.length > 0
    ? farVisibleNotes.map((record) => `- 距离约${Math.round(record.distanceMeters || 0)}m：${record.farVisibleNotes}`).join('\n')
    : '无';

  return [
    '你是一个文字探索游戏的会话助手。',
    '如果用户要求移动，调用 move_player 工具；如果没有移动意图，则直接自然回复。',
    styleRule,
    '不要在文本回复里暴露经纬度、网格、极坐标等内部实现。',
    '请优先保持空间连续性，并参考当前区域的总体环境描述和附近其他地点的远距可见细节。',
    '',
    `当前总体环境描述：${largeDescription}`,
    '',
    '当前位置的程序生成的摘要：',
    sceneContext.smallSummary,
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

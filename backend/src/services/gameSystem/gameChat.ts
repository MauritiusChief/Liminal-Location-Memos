import { randomUUID } from 'node:crypto';
import {
  bearingBetweenCoordinates,
  distanceToPosition,
} from '@/services/geometry.js';
import { buildSceneFromRequest, SceneObject } from '../scene/sceneObject.js';
import { buildScenePrompt } from '../scene/scenePrompt.js';
import {
  BUILD_GAME_STATE_MANAGER_SYSTEM,
  INITIAL_BOOK_MESSAGE_SYSTEM,
  REGULAR_BOOK_MESSAGE_SYSTEM,
  VISUAL_DESCRIPTION_SYSTEM,
} from './systemPrompts.js';
import { writeGameDebugRequest, writeGameDebugResult } from './gameDebug.js';
import {
  generateJsonReplySingleMessage,
  streamReplyFullMessages,
  streamReplySingleMessage,
} from './llm.js';
import {
  cloneGameState,
  createRuntimeSession,
  GameClientSessionSnapshot,
  GameSession,
  GameState,
  getRuntimeSession,
  FieldVisualDescriptionRecord,
  Position,
  toClientGameSessionSnapshot,
  updateRuntimeSession,
} from './gameSessionStore.js';
import { applyMovePlayerTool } from './toolMovePlayer.js';
import { generateBuildingSchema } from './buildingClassifier.js';
import { formatRelativeDirection } from '../scene/polarViewPrompt.js';

interface GameStateToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

interface GameStateToolDef {
  name: string;
  description: string[];
  arguments: {
    [arg: string]: {
      type: string;
      optional: boolean;
      description: string;
    };
  };
}

export type GameStreamEvent =
  | { type: 'player_message_accepted'; text: string }
  | { type: 'book_reply_delta'; text: string }
  | { type: 'book_done' }
  | { type: 'session_committed'; session: GameClientSessionSnapshot }
  | { type: 'visual_description_started' }
  | { type: 'visual_description_done'; session: GameClientSessionSnapshot }
  | { type: 'queued_next_turn'; queuedMessage: string; session: GameClientSessionSnapshot }
  | { type: 'queue_rejected'; message: string; session: GameClientSessionSnapshot }
  | { type: 'error'; message: string };

type EmitGameEvent = (event: GameStreamEvent) => void | Promise<void>;

const INITIAL_SCENE_RADIUS_METERS = 1000;
const WORLD_STATE_RADIUS_METERS = 500;
const VISUAL_DESCRIPTION_RADIUS_METERS = 300;

//#region 游戏状态工具

type MovePlayerToolCall = {
  bearingDegrees: number;
  distanceMeters: number;
  reason: string;
};

const MOVE_PLAYER_TOOL: GameStateToolDef = {
  name: 'move_player',
  description: [
    '当用户明确或隐含地要求玩家移动或转向时，综合判断玩家自身状态以及周遭的环境信息，然后使用此工具更改游戏角色的朝向与经纬度。',
    '注意：即使用户要求移动了，也需要分析是否有阻碍移动的障碍、玩家状态是否足以支持此次移动等条件。如果分析表明这次移动没法完整执行，可以将移动的目的地修改在近处。',
    '（比如如果因存在障碍而无法移动，可以将目的地设置在障碍物面前）',
  ],
  arguments: {
    bearingDegrees: { type: 'number', optional: false, description: '以正前方为0度，顺时针增加。' },
    distanceMeters: { type: 'number', optional: false, description: '移动距离，单位米。' },
    reason: { type: 'string', optional: true, description: '简短说明为何这样移动。' },
  },
};

//#region 出口函数

/**
 * 开局主流程。
 *
 * 可以把它理解成“新游戏版的一回合”：
 * - 先创建运行时 session；
 * - 再根据当前位置生成第一条 Book Message；
 * - Book 正文一边生成，一边通过 emit 流式发给前端；
 * - Book 完成后立刻提交存档；
 * - 最后再补做 Visual Description。
 */
export async function streamGameStart(emit: EmitGameEvent): Promise<GameSession> {
  console.log(`[${new Date().toISOString()}] 开始游戏`);

  const session = await createRuntimeSession();
  const workingState = cloneGameState(session.gameState);

  const openingMessage = await streamInitialBookMessage(workingState, emit);

  workingState.messageHistory.push({
    role: 'book',
    content: openingMessage,
  });

  await commitBookMessage(session, workingState, openingMessage, emit);
  return session;
}

/**
 * 正式回合入口。
 *
 * 这个函数额外处理了“后台准备态”：
 * - 若上一回合的 Visual Description 还没做完，则先尝试把本条消息塞进单槽队列；
 * - 若队列已满，则直接拒绝；
 * - 若可以排队，则等待上一回合后台任务结束，再继续执行本回合。
 *
 * 换句话说，它不只是“跑一回合”，还承担了回合之间的串行化与排队控制。
 */
export async function streamGameTurn(
  sessionId: string,
  playerMessage: string,
  emit: EmitGameEvent,
): Promise<GameSession | undefined> {
  console.log(`[${new Date().toISOString()}] 运行回合...`);

  const session = await getRuntimeSession(sessionId);
  if (!session) {
    return undefined;
  }

  if (session.runtime.activeTurnId) {
    // activeTurnId 代表当前已有一条请求正在实际生成 Book，
    // 这时不能再并发进入下一条，否则 messageHistory 和状态更新顺序会乱掉。
    await emit({
      type: 'queue_rejected',
      message: 'Another turn is already in progress.',
      session: toClientGameSessionSnapshot(session),
    });
    return session;
  }

  if (session.runtime.pendingVisualDescription) {
    if (session.runtime.queuedPlayerMessage) {
      // 设计上只允许积压 1 条下一回合消息，避免无限排队带来的状态复杂度。
      await emit({
        type: 'queue_rejected',
        message: 'A queued player message is already waiting.',
        session: toClientGameSessionSnapshot(session),
      });
      return session;
    }

    session.runtime.queuedPlayerMessage = playerMessage;
    await emit({
      type: 'queued_next_turn',
      queuedMessage: playerMessage,
      session: toClientGameSessionSnapshot(session),
    });

    if (session.runtime.pendingVisualDescriptionTask) {
      // 这里故意等待上一回合的后台收尾完成，再真正进入本回合。
      await session.runtime.pendingVisualDescriptionTask;
    }

    // 当前请求接管这条排队消息并继续执行；若中途被别处清空，则退回当前入参。
    if (session.runtime.queuedPlayerMessage === playerMessage) {
      session.runtime.queuedPlayerMessage = null;
    }
  }

  await emit({ type: 'player_message_accepted', text: playerMessage });
  await executeTurnStream(session, playerMessage, emit);
  return session;
}

//#region 内部逻辑函数

/**
 * 执行“真正的一回合”。
 *
 * 注意这里先复制一份 workingState 再修改，
 * 这样如果中途抛错，就不会把 session 里的正式状态改脏。
 *
 * 流程是：
 * 1. 写入玩家消息；
 * 2. 让 Game State Manager 判断需要做哪些状态变化；
 * 3. 应用这些变化；
 * 4. 流式生成 Book；
 * 5. 进入 commitBookMessage() 做提交与后台收尾。
 */
async function executeTurnStream(
  session: GameSession,
  playerMessage: string,
  emit: EmitGameEvent,
): Promise<void> {
  const activeTurnId = randomUUID();
  session.runtime.activeTurnId = activeTurnId;

  try {
    const workingState = cloneGameState(session.gameState);
    workingState.playerIndoorLocation = null;
    workingState.messageHistory.push({
      role: 'player',
      content: playerMessage,
    });

    // 先让专门的 agent 决定“这句玩家输入会触发哪些状态操作”。
    const toolCalls = await gameStateManager(workingState);
    applyGameStateToolCalls(workingState, toolCalls);
    // 玩家位置可能改变，因此需要重新计算当前哪些 Field Visual Description 生效。
    syncActiveFieldVisualDescriptions(workingState);

    const bookMessage = await streamRegularBookMessage(workingState, emit);
    workingState.messageHistory.push({
      role: 'book',
      content: bookMessage,
    });

    await commitBookMessage(session, workingState, bookMessage, emit);
  } finally {
    if (session.runtime.activeTurnId === activeTurnId) {
      session.runtime.activeTurnId = null;
    }
  }
}

/**
 * Book Message 已经完整生成后的收尾阶段。
 *
 * 这里的顺序非常关键：
 * 1. 先把包含最新 Book Message 的 GameState 写入 session；
 * 2. 立刻落盘，让“Book 已提交”成为可恢复状态；
 * 3. 再通知前端 `book_done` / `session_committed`；
 * 4. 然后才开始后台补 Visual Description。
 *
 * 这样即便后面的 Visual Description 失败，玩家已经看到并提交的 Book 也不会丢。
 */
async function commitBookMessage(
  session: GameSession,
  nextState: GameState,
  bookMessage: string,
  emit: EmitGameEvent,
): Promise<void> {
  session.gameState = nextState;
  session.runtime.pendingVisualDescription = true;
  await updateRuntimeSession(session);

  await emit({ type: 'book_done' });
  await emit({
    type: 'session_committed',
    session: toClientGameSessionSnapshot(session),
  });

  // 到这一步，Book 对应的正式状态已经提交完成，
  // 因此可以释放 activeTurnId，让下一个请求有机会进入“排队等待后台准备”的阶段。
  session.runtime.activeTurnId = null;
  await emit({ type: 'visual_description_started' });

  const backgroundTask = finalizeVisualDescription(session, bookMessage);
  session.runtime.pendingVisualDescriptionTask = backgroundTask;

  try {
    await backgroundTask;
    await emit({
      type: 'visual_description_done',
      session: toClientGameSessionSnapshot(session),
    });
  } finally {
    if (session.runtime.pendingVisualDescriptionTask === backgroundTask) {
      session.runtime.pendingVisualDescriptionTask = null;
    }
  }
}

/**
 * 后台补做 Visual Description。
 *
 * 它基于“刚刚已提交的 session.gameState”再复制一份状态，
 * 然后把提炼出的事实性细节写回去。
 *
 * finally 中一定会清掉 pendingVisualDescription，
 * 否则 session 会永久停留在“后台准备中”的假死状态。
 */
async function finalizeVisualDescription(session: GameSession, bookMessage: string): Promise<void> {
  try {
    const nextState = cloneGameState(session.gameState);
    await upsertVisualDescriptions(nextState, bookMessage);
    session.gameState = nextState;
    await updateRuntimeSession(session);
  } finally {
    session.runtime.pendingVisualDescription = false;
  }
}

/**
 * 根据 request 生成 Scene Prompt，然后 stream 第一条 Book Message
 * @param state
 * @param emit
 * @returns 整个游戏的第一条描述周遭状况的 Book Message
 */
async function streamInitialBookMessage(
  state: GameState,
  emit: EmitGameEvent,
): Promise<string> {
  console.log(`[${new Date().toISOString()}] initialBookMessage() 触发`);

  const { lat, lon } = state.playerPosition;
  const sceneObject = await buildSceneFromRequest({ lat, lon, radius: INITIAL_SCENE_RADIUS_METERS }, state.playerOrientation);
  const worldStatePrompt = await toWorldStatePrompt(state, sceneObject);
  // TODO 自动生成可生成的 Building Schema（当前仅完成 Category 和 Pattern 打印）
  // const {microGrid, polarView} = sceneObject
  // const featureIds = [
  //   ...microGrid.cells.flatMap(cell => cell).flatMap(cell => cell.sourceFeatureIds),
  //   ...(polarView?.levels.flatMap( l => l.clusters.flatMap( c => c.features.flatMap( f => f.featureId))) ?? [])
  // ]
  // featureIds.forEach( async id => await generateBuildingSchema(id, state.buildingSchemas)) // TODO 当前仅打印
  await writeGameDebugRequest({
    mode: 'user-message',
    functionName: 'streamInitialBookMessage',
    systemPrompt: INITIAL_BOOK_MESSAGE_SYSTEM,
    userMessage: worldStatePrompt,
  });

  let reply = '';
  let reasoning = '';

  try {
    for await (const event of streamReplySingleMessage(
      INITIAL_BOOK_MESSAGE_SYSTEM,
      worldStatePrompt,
    )) {
      if (event.replyDelta) {
        reply += event.replyDelta;
        await emit({ type: 'book_reply_delta', text: event.replyDelta });
      }
      if (event.reasoningDelta) {
        reasoning += event.reasoningDelta;
      }
    }

    await writeGameDebugResult({
      functionName: 'streamInitialBookMessage',
      reply,
      reasoning,
    });
    return reply;
  } catch (error) {
    await writeGameDebugResult({
      functionName: 'initialBookMessage',
      error,
    });
    throw error;
  }
}

/**
 * 流式输送常规回合 Book Message。
 * 过程中会用到传统的 sys, user, assist, tool, assist... 这样的 messages 结构。
 *
 * 和开场消息不同，这里会把最近一段 messageHistory 与 worldStatePrompt 一起发给模型，
 * 因此它代表的是“承接上下文的正式回合输出”。
 * @param state
 * @param emit
 * @returns
 */
async function streamRegularBookMessage(
  state: GameState,
  emit: EmitGameEvent,
): Promise<string> {
  console.log(`[${new Date().toISOString()}] generateBookMessage() 触发`);

  const { lat, lon } = state.playerPosition;
  const sceneObject = await buildSceneFromRequest({ lat, lon, radius: WORLD_STATE_RADIUS_METERS}, state.playerOrientation);
  const worldStatePrompt = await toWorldStatePrompt(state, sceneObject);
  // TODO 自动生成可生成的 Building Schema（当前仅完成 Category 和 Pattern 打印）
  // const {microGrid, polarView} = sceneObject
  // const featureIds = [
  //   ...microGrid.cells.flatMap(cell => cell).flatMap(cell => cell.sourceFeatureIds),
  //   ...(polarView?.levels.flatMap( l => l.clusters.flatMap( c => c.features.flatMap( f => f.featureId))) ?? [])
  // ]
  // featureIds.forEach( async id => await generateBuildingSchema(id, state.buildingSchemas)) // TODO 当前仅打印
  // 组装消息历史
  const messageHistory = state.messageHistory.slice(Math.max(0, state.messageHistory.length - 12));
  await writeGameDebugRequest({
    mode: 'full-messages',
    functionName: 'streamRegularBookMessage',
    systemPrompt: REGULAR_BOOK_MESSAGE_SYSTEM,
    gameMessages: messageHistory,
    worldStatePrompt,
  });

  let reply = '';
  let reasoning = '';

  try {
    for await (const event of streamReplyFullMessages(
      REGULAR_BOOK_MESSAGE_SYSTEM,
      messageHistory,
      worldStatePrompt,
    )) {
      if (event.replyDelta) {
        reply += event.replyDelta;
        await emit({ type: 'book_reply_delta', text: event.replyDelta });
      }
      if (event.reasoningDelta) {
        reasoning += event.reasoningDelta;
      }
    }

    await writeGameDebugResult({
      functionName: 'streamRegularBookMessage',
      reply,
      reasoning,
    });
    return reply;
  } catch (error) {
    await writeGameDebugResult({
      functionName: 'streamRegularBookMessage',
      error,
    });
    throw error;
  }
}

//#region 游戏状态函数

/**
 * 从 Game State 获取所需信息，尤其是玩家最新的消息，然后单独给一个 agent，令其返回该玩家行为将导致的游戏状态变化
 *
 * 它的职责只是“决定要做什么”，而不直接改状态。
 * 真正执行这些变化的是 applyGameStateToolCalls()。
 * @param state 保证 messageHistory 最新一条为 player Message 的 GameState
 * @returns 需要改变的游戏状态，各自需要改变的值等等，如果出错则返回空列表
 */
async function gameStateManager(state: GameState): Promise<GameStateToolCall[]> {
  console.log(`[${new Date().toISOString()}] gameStateManager() 触发`);

  const toolDefs = [MOVE_PLAYER_TOOL].map((def) => toToolPrompt(def));
  const systemPrompt = BUILD_GAME_STATE_MANAGER_SYSTEM(toolDefs);
  const messageHistory = state.messageHistory;
  const latestPlayerMessage = messageHistory[messageHistory.length - 1];
  // 组装 world state 提示词
  const { lat, lon } = state.playerPosition;
  const sceneObject = await buildSceneFromRequest({ lat, lon, radius: WORLD_STATE_RADIUS_METERS}, state.playerOrientation);
  const worldStatePrompt = await toWorldStatePrompt(state, sceneObject);
  // 组装背景消息提示词
  const message = [
    '玩家发送的消息：',
    `> ${latestPlayerMessage?.content ?? ''}\n`,
    '近期对话历史：',
    messageHistory
      .slice(Math.max(0, messageHistory.length - 6), messageHistory.length - 1)
      .map((messageEntry) => {
        const hint = messageEntry.role === 'book' ? '**游戏输出**' : '**玩家输入**';
        const contentLines = messageEntry.content.split('\n')
        return `> ${hint}：\n${contentLines.map(line => `> ${line}`).join('\n')}\n>`;
      })
      .join('\n'),
    '---',
    worldStatePrompt,
  ].join('\n');
  await writeGameDebugRequest({
    mode: 'user-message',
    functionName: 'gameStateManager',
    systemPrompt,
    userMessage: message,
  });

  try {
    // 获取 LLM 返回
    const response = await generateJsonReplySingleMessage(systemPrompt, message);
    // 解析返回
    const unparsedToolCall: any = JSON.parse(response.reply);
    let parsedToolCall: GameStateToolCall[]
    // 以防只回一个单独的 object
    if (Array.isArray(unparsedToolCall)) {
      parsedToolCall = unparsedToolCall
    } else {
      parsedToolCall = [unparsedToolCall]
    }
    await writeGameDebugResult({
      functionName: 'gameStateManager',
      reply: parsedToolCall,
      reasoning: response.reasoning,
    });
    return parsedToolCall;
  } catch (error) {
    await writeGameDebugResult({
      functionName: 'gameStateManager',
      error,
    });
    console.error(error);
    return [];
  }
}

/**
 * 把当前 GameState 转成可消费的 world-state 提示词。
 * 过程中会从数据库请求信息以组建 Scene Object
 * 消费者：
 * - Book 消息生成者
 * - Game State Manager
 *
 * TODO 添加更多信息，比如 Building Schema 乃至天气、物品、玩家状态等信息
 * @param state
 * @param scene 已按照合理半径获取的 Scene Object
 * @returns TODO 目前仅包含 scenePrompt 和 VisualDescription 的提示词
 */
async function toWorldStatePrompt(state: GameState, scene: SceneObject): Promise<string> {
  const scenePrompt = buildScenePrompt(scene, state.playerOrientation);
  syncActiveFieldVisualDescriptions(state);
  syncActiveExteriorVisualDescriptions(state, collectSceneBuildingIds(scene));

  const fieldVisualDescriptions = Object.entries(state.fieldVisualDescriptions)
    .filter(([id]) => state.activeFieldVisualDescriptions.includes(id))
    .map(([, record]) => formatFieldVisualDescriptionForPrompt(state, record))
    .join('\n\n');
  const exteriorVisualDescriptions = state.activeExteriorVisualDescriptions
    .map((buildingId) => state.exteriorVisualDescriptions[buildingId])
    .filter((record): record is NonNullable<typeof record> => Boolean(record))
    .map((record) => [`buildingId=${record.buildingId}`, record.content].join('\n'))
    .join('\n');

  return [
    '玩家周遭环境数据：',
    scenePrompt,
    '---',
    '玩家周遭环境场地细节记录：',
    fieldVisualDescriptions || '（暂无）',
    '---',
    '玩家周遭建筑外观细节记录：',
    exteriorVisualDescriptions || '（暂无）',
  ].join('\n');
}

/**
 * 执行 Game State Manager 给出的工具调用。
 *
 * 当前只支持 move_player：
 * - 参数合法才会执行；
 * - 成功移动后，玩家朝向也会改成这次移动方向；
 */
export function applyGameStateToolCalls(state: GameState, toolCalls: GameStateToolCall[]): void {
  for (const toolCall of toolCalls) {
    console.log(`[${new Date().toISOString()}] 开始解析 ${toolCall.name} 工具参数：`, toolCall.arguments);

    const args = toolCall.arguments;

    switch (toolCall.name) {
      case MOVE_PLAYER_TOOL.name:
        applyMovePlayerTool(state, args)
        break
    }

  }
}

//#region VD 函数
// Field Visual Description
// Exterior Visual Description

interface ExtractedVisualDescriptions {
  field: string;
  exteriors: Array<{
    buildingId: string;
    content: string;
  }>;
}

/**
 * 为当前位置补写或更新 Field Visual Description 与 Exterior Visual Description。
 *
 * Field VD 的规则是：
 * - 若 300m 范围内已有最近的一条记录，则更新它；
 * - 否则创建一条新的记录。
 *
 * Exterior VD 的规则是：
 * - 只更新当前 300m Scene Object 中可引用的建筑；
 * - 每个建筑以 featureId 作为记录主键。
 */
async function upsertVisualDescriptions(state: GameState, bookMessage: string): Promise<void> {
  const { lat, lon } = state.playerPosition;
  const sceneObject = await buildSceneFromRequest({ lat, lon, radius: VISUAL_DESCRIPTION_RADIUS_METERS }, state.playerOrientation);
  const visibleBuildingIds = collectSceneBuildingIds(sceneObject);
  const matchedFieldRecord = findNearestFieldVisualDescription(state, state.playerPosition);
  syncActiveExteriorVisualDescriptions(state, visibleBuildingIds);

  const extracted = await extractVisualDescriptions(
    bookMessage,
    state.playerOrientation,
    sceneObject,
    matchedFieldRecord?.content,
    state.activeExteriorVisualDescriptions.map((buildingId) => state.exteriorVisualDescriptions[buildingId]),
  );
  const now = new Date().toISOString();

  if (matchedFieldRecord) {
    matchedFieldRecord.content = extracted.field;
    matchedFieldRecord.center = { ...state.playerPosition };
    matchedFieldRecord.updatedAt = now;
  } else {
    const newRecord: FieldVisualDescriptionRecord = {
      id: randomUUID(),
      center: { ...state.playerPosition },
      content: extracted.field,
      createdAt: now,
      updatedAt: now,
    };
    state.fieldVisualDescriptions[newRecord.id] = newRecord;
  }

  for (const exterior of extracted.exteriors) {
    if (!visibleBuildingIds.includes(exterior.buildingId) || !exterior.content.trim()) {
      continue;
    }

    const existing = state.exteriorVisualDescriptions[exterior.buildingId];
    state.exteriorVisualDescriptions[exterior.buildingId] = {
      buildingId: exterior.buildingId,
      content: exterior.content,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
  }

  syncActiveFieldVisualDescriptions(state);
  syncActiveExteriorVisualDescriptions(state, visibleBuildingIds);
}

/**
 * 从某个 Book Message 里提取事实性细节供记录，以维持事实一致性。
 *
 * 这里的目标是把 Book 里已经说出的、之后应该继续视为事实的细节抽出来，
 * 并根据是否绑定建筑拆成 Field VD 与 Exterior VD。
 * @param bookMessage
 * @returns
 */
async function extractVisualDescriptions(
  bookMessage: string,
  playerOrientation: number,
  sceneObject: SceneObject,
  oldFieldVisualDescription?: string,
  oldExteriorVisualDescriptions: Array<GameState['exteriorVisualDescriptions'][string] | undefined> = [],
): Promise<ExtractedVisualDescriptions> {
  console.log(`[${new Date().toISOString()}] 开始 extractVisualDescriptions()`);

  const scenePrompt = buildScenePrompt(sceneObject, playerOrientation);
  const visibleBuildingIds = collectSceneBuildingIds(sceneObject);
  const oldExteriorRecords = oldExteriorVisualDescriptions
    .filter((record): record is NonNullable<typeof record> => Boolean(record))
    .map((record) => [`buildingId=${record.buildingId}`, record.content].join('\n'))
    .join('\n\n');

  const message = [
    'OpenStreetMap 数据摘要：',
    scenePrompt,
    '---',
    '当前可写入 Exterior Visual Description 的建筑 id：',
    visibleBuildingIds.length ? visibleBuildingIds.join(', ') : '（暂无）',
    '---',
    '旧的 Field Visual Description：',
    oldFieldVisualDescription ?? '（暂无）',
    '---',
    '旧的 Exterior Visual Description：',
    oldExteriorRecords || '（暂无）',
    '---',
    '文本描述：',
    bookMessage,
  ].join('\n');
  await writeGameDebugRequest({
    mode: 'user-message',
    functionName: 'extractVisualDescriptions',
    systemPrompt: VISUAL_DESCRIPTION_SYSTEM,
    userMessage: message,
  });

  try {
    const response = await generateJsonReplySingleMessage(
      VISUAL_DESCRIPTION_SYSTEM,
      message,
    );
    const extracted = parseExtractedVisualDescriptions(response.reply);
    await writeGameDebugResult({
      functionName: 'extractVisualDescriptions',
      reply: extracted,
      reasoning: response.reasoning,
    });
    return extracted;
  } catch (error) {
    await writeGameDebugResult({
      functionName: 'extractVisualDescriptions',
      error,
    });
    throw error;
  }
}

/**
 * 根据当前玩家位置，重新计算哪些 Field Visual Description 处于激活状态。
 *
 * 当前最小规则很直白：只要中心点在玩家 300m 范围内，就算 active。
 */
function syncActiveFieldVisualDescriptions(state: GameState): void {
  const records = Object.values(state.fieldVisualDescriptions)
    .filter((record) => distanceToPosition(record.center, state.playerPosition) <= VISUAL_DESCRIPTION_RADIUS_METERS)
    .sort(
      (left, right) =>
        distanceToPosition(left.center, state.playerPosition) - distanceToPosition(right.center, state.playerPosition),
    );

  state.activeFieldVisualDescriptions = records.map((record) => record.id);
}

/**
 * 根据当前 Scene Object 中出现的建筑 id，重新计算哪些 Exterior Visual Description 处于激活状态。
 */
function syncActiveExteriorVisualDescriptions(state: GameState, visibleBuildingIds: string[]): void {
  state.activeExteriorVisualDescriptions = visibleBuildingIds.filter((buildingId) =>
    Boolean(state.exteriorVisualDescriptions[buildingId]),
  );
}

/**
 * 查找“距离当前位置最近，且仍在 300m 生效范围内”的 Field Visual Description。
 *
 * 这个函数的结果决定 upsertVisualDescriptions() 是复用旧 Field 记录还是新建记录。
 */
function findNearestFieldVisualDescription(
  state: GameState,
  position: Position,
): FieldVisualDescriptionRecord | null {
  const records = Object.values(state.fieldVisualDescriptions)
    .map((record) => ({
      record,
      distanceMeters: distanceToPosition(record.center, position),
    }))
    .filter((entry) => entry.distanceMeters <= VISUAL_DESCRIPTION_RADIUS_METERS)
    .sort((left, right) => left.distanceMeters - right.distanceMeters);

  return records[0]?.record || null;
}

function parseExtractedVisualDescriptions(reply: string): ExtractedVisualDescriptions {
  const parsed = JSON.parse(reply) as Partial<ExtractedVisualDescriptions>;
  return {
    field: (Array.isArray(parsed.field) && parsed.field.every(item => typeof item === "string")) ?
      parsed.field.join('\n') : parsed.field ?? '', // 兼容 string 或 string[]
    exteriors: Array.isArray(parsed.exteriors)
      ? parsed.exteriors.flatMap((entry) => {
          if (!entry || typeof entry !== 'object') {
            return [];
          }

          const { buildingId, content } = entry as Partial<ExtractedVisualDescriptions['exteriors'][number]>;
          const contentToReturn = (Array.isArray(content) && content.every(item => typeof item === "string")) ?
            content.join('\n') : content ?? '';
          return typeof buildingId === 'string'
            ? [{ buildingId, content: contentToReturn }]
            : [];
        })
      : [],
  };
}

function collectSceneBuildingIds(scene: SceneObject): string[] {
  const microGridBuildingIds = scene.microGrid.cells
    .flatMap((row) => row)
    .flatMap((cell) => cell.baseKind === 'building' && cell.baseFeatureId ? [cell.baseFeatureId] : []);
  const polarBuildingIds = scene.polarView?.levels
    .flatMap((level) => level.clusters)
    .flatMap((cluster) => cluster.features)
    .flatMap((feature) => feature.category === 'building' ? [feature.featureId] : []) ?? [];

  return [...new Set([...microGridBuildingIds, ...polarBuildingIds])];
}

function formatFieldVisualDescriptionForPrompt(state: GameState, record: FieldVisualDescriptionRecord): string {
  const distanceMeters = distanceToPosition(state.playerPosition, record.center);
  const bearingDegrees = bearingBetweenCoordinates(
    [state.playerPosition.lon, state.playerPosition.lat],
    [record.center.lon, record.center.lat],
  );

  return [
    `* 距离${Math.round(distanceMeters)}m / ${formatRelativeDirection(bearingDegrees, state.playerOrientation)}`,
    record.content,
  ].join('\n');
}

function formatRelativeDirectionLabel(relativeBearingDegrees: number): string {
  const labels = ['正前', '右前', '右', '右后', '正后', '左后', '左', '左前'];
  const index = Math.round(relativeBearingDegrees / 45) % labels.length;
  return labels[index]!;
}

//#region 帮助函数

/**
 * 把工具定义转成提示词中的纯文本说明，供 Game State Manager 阅读。
 */
function toToolPrompt(toolDef: GameStateToolDef): string {
  const argsStringArray = Object.entries(toolDef.arguments).map(([name, definition]) => [
    `\`${name}\``,
    `- 类型：${definition.type}`,
    `- ${definition.optional ? '可选参数' : '必要参数'}`,
    `- 描述：${definition.description}`,
  ].join('\n'));

  return [
    `**工具名**: \`${toolDef.name}\``,
    '介绍：',
    toolDef.description.join('\n'),
    '参数：',
    argsStringArray.join('\n'),
  ].join('\n');
}

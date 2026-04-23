import { randomUUID } from 'node:crypto';
import {
  bearingBetweenCoordinates,
  distanceToPosition,
} from '@/services/geometry.js';
import { buildSceneFromRequest, SceneObject } from '../scene/sceneObject.js';
import { buildScenePrompt } from '../scene/scenePrompt.js';
import {
  BUILD_GAME_STATE_MANAGER_SYSTEM,
  INDOOR_INITIAL_BOOK_MESSAGE_SYSTEM,
  OUTDOOR_INITIAL_BOOK_MESSAGE_SYSTEM,
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
import { formatRelativeDirection } from '../scene/polarViewPrompt.js';
import {
  chooseInitialIndoorLocation,
  ensureBuildingSchema,
  fillBasicActiveIndoorLocations,
  findContainingBuildingFeatureId,
  findIndoorLocationContext,
  findVisibleLocationContext,
  generateBuildingRecord,
} from './toolIndoorPosition.js';

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
/**
 * 需要在 World State Prompt 中提示所在建筑的结构，如果在建筑当中的话
 */
const SET_PLAYER_INDOOR_LOCATION_TOOL: GameStateToolDef = {
  name: 'set_player_indoor_location',
  description: [
    '当用户明确或隐含地要求玩家进入或离开建筑，或者在建筑的房间之间移动时，使用此工具改变游戏角色在建筑中的位置。'
  ],
  arguments: {
    move: { type: 'string', optional: false, description: '玩家行动的类型，必须为`enter`(进入建筑), `leave`(离开建筑), `move`(在建筑中移动)这三者之一。'},
    buildingId: { type: 'string', optional: true, description: '玩家移动的目标建筑物体，为该建筑物的 featureId，仅在 `leave` 行动类型下为非必须参数。'},
    level: { type: 'number', optional: true, description: '玩家移动的目标楼层，为该楼层的层号数，仅在 `move` 行动类型下为必须参数。'},
    suiteId: { type: 'string', optional: true, description: '若目标位置位于某套房内部，则填写该套房的 id。'},
    roomId: { type: 'string', optional: true, description: '玩家移动的目标房间的 id，仅在同一楼层间移动时为必须参数。'},
  }
}
/**
 * 注意：只负责单个 indoor location 更新。
 * 玩家进入建筑、跨越楼层时，基板 active visible locations 会由程序生成。
 * 默认只暴露当前 Sector 内的普通房间与 suite 表层，不自动暴露 suite 内 subRoom。
 */
const SYNC_ACTIVE_INDOOR_LOCATIONS_TOOL: GameStateToolDef = {
  name: 'sync_active_indoor_locations',
  description: [
    '结合玩家所在建筑的信息、玩家当前的可视建筑位置以及玩家的行动，判断是否需要更新现有的可视建筑位置列表。',
    '如果需要更新，则使用此工具将需要添加或者删除的可视建筑位置写入游戏状态机。'
  ],
  arguments: {
    edit: { type: 'string', optional: false, description: '更新的类型，必须为`reveal`(揭露可视位置), `hide`(隐藏可视位置)二者之一。'},
    level: { type: 'number', optional: false, description: '被揭露或者隐藏的建筑位置的楼层层号数。'},
    suiteId: { type: 'string', optional: true, description: '若操作的目标是某个套房表层或套房内部子房间，则填写该套房 id。'},
    roomId: { type: 'string', optional: true, description: '被揭露或者隐藏的具体房间 id；若只操作 suite 表层则留空。'},
  }
}

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
  await initializeOpeningIndoorState(workingState);
  fillBasicActiveIndoorLocations(workingState);

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
    workingState.messageHistory.push({
      role: 'player',
      content: playerMessage,
    });

    // 先让专门的 agent 决定“这句玩家输入会触发哪些状态操作”。
    const toolCalls = await gameStateManager(workingState);
    applyGameStateToolCalls(workingState, toolCalls);
    // 以防玩家位置更新了，需要更新一下位置会影响激活效果的 VD 的 id
    fillBasicActiveIndoorLocations(workingState);
    syncActiveFieldVisualDescriptions(workingState);
    syncActiveExteriorVisualDescriptions(workingState);
    syncActiveSectorVisualDescriptions(workingState);

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

  const isIndoorOpening = Boolean(state.playerIndoorLocation);
  const sceneObject = isIndoorOpening
    ? undefined
    : await buildSceneFromRequest(
        { lat: state.playerPosition.lat, lon: state.playerPosition.lon, radius: INITIAL_SCENE_RADIUS_METERS },
        state.playerOrientation,
      );
  const worldStatePrompt = await toWorldStatePrompt(state, sceneObject);
  const systemPrompt = isIndoorOpening
    ? INDOOR_INITIAL_BOOK_MESSAGE_SYSTEM
    : OUTDOOR_INITIAL_BOOK_MESSAGE_SYSTEM;
  await writeGameDebugRequest({
    mode: 'user-message',
    functionName: 'streamInitialBookMessage',
    systemPrompt,
    userMessage: worldStatePrompt,
  });

  let reply = '';
  let reasoning = '';

  try {
    for await (const event of streamReplySingleMessage(
      systemPrompt,
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

  const toolDefs = [MOVE_PLAYER_TOOL, SET_PLAYER_INDOOR_LOCATION_TOOL, SYNC_ACTIVE_INDOOR_LOCATIONS_TOOL].map((def) => toToolPrompt(def));
  const systemPrompt = BUILD_GAME_STATE_MANAGER_SYSTEM(toolDefs);
  const messageHistory = state.messageHistory;
  const latestPlayerMessage = messageHistory[messageHistory.length - 1];
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
 * TODO：
 * - 添加把 state 中的 active visible locations 转化为提示词（玩家可视的建筑位置数据）
 * - 根据玩家是否在室内切换是否启用 scenePrompt、field VD、 exterior VD（室外时才启用）、sector VD（玩家周遭室内场景细节记录）（室内时才启用）
 *
 * 把当前 GameState 转成可消费的 world-state 提示词。
 * world-state 提示词消费者：
 * - Book 消息生成者
 * - Game State Manager
 * @param state
 * @param scene 已按照合理半径获取的 Scene Object；室内开局时可留空
 * @returns 同时兼容室内与室外上下文的提示词
 */
async function toWorldStatePrompt(state: GameState, scene?: SceneObject): Promise<string> {
  // 室外相关的信息
  const scenePrompt = scene ? buildScenePrompt(scene, state.playerOrientation) : null;
  const fieldVisualDescriptions = Object.entries(state.fieldVisualDescriptions)
    .filter(([id]) => state.activeFieldVisualDescriptions.includes(id))
    .map(([, record]) => formatFieldVisualDescriptionForPrompt(state, record))
    .join('\n\n');
  const exteriorVisualDescriptions = state.activeExteriorVisualDescriptions
    .map((buildingId) => state.exteriorVisualDescriptions[buildingId])
    .filter((record): record is NonNullable<typeof record> => Boolean(record))
    .map((record) => [`buildingId=${record.buildingId}`, record.content].join('\n'))
    .join('\n');
  // 室内相关的信息
  const indoorPrompt = formatIndoorWorldStatePrompt(state);
  const sectorVisualDescriptions = state.activeSectorVisualDescriptions
    .map((id) => state.sectorVisualDescriptions[id])
    .filter((record): record is NonNullable<typeof record> => Boolean(record))
    .map((record) => [
      `buildingId=${record.buildingId}`,
      `level=${record.level}`,
      `sector=${record.sectorName}`,
      record.content,
    ].join('\n'))
    .join('\n\n');

  const sections = [
    '玩家周遭环境数据：',
    scenePrompt || '（当前未提供室外场景摘要）',
    '---',
    '玩家周遭环境场地细节记录：',
    fieldVisualDescriptions || '（暂无）',
    '---',
    '玩家周遭建筑外观细节记录：',
    exteriorVisualDescriptions || '（暂无）',
    '---',
    '玩家当前室内场景摘要：',
    indoorPrompt || '（当前未提供室内场景摘要）',
    '---',
    '玩家当前激活的室内 Sector 细节记录：',
    sectorVisualDescriptions || '（暂无）',
  ];

  return sections.join('\n');
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
 * TODO 添加 Sector Visual Description 更新逻辑
 *
 * BOOK MESSAGE 已发送出去之后，根据此 BOOK MESSAGE 为最新的玩家位置
 * 补写或更新 Field Visual Description 与 Exterior Visual Description。
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

  const extracted = await extractVisualDescriptions(
    bookMessage,
    state.playerOrientation,
    sceneObject,
    matchedFieldRecord?.content,
    state.activeExteriorVisualDescriptions.map((buildingId) => state.exteriorVisualDescriptions[buildingId]),
  );
  const now = new Date().toISOString();

  // 更新 Field Visual Description 的文案
  if (matchedFieldRecord) {
    matchedFieldRecord.content = extracted.field;
    // matchedFieldRecord.center = { ...state.playerPosition };
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

  // 更新 Exterior Visual Description 的文案
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

}

/**
 * TODO 重命名为 extractFieldExteriorVisualDescriptions
 *
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
 * TODO 完成提取 Sector VD 的逻辑
 * - 比对的固定式细节是 Building Record (以及未来可能的存储的物品细节等)，而非 Field/Exterior VD 使用的 OSM 数据
 * @param bookMessage
 */
async function extractSectorVisualDescriptions(bookMessage: string) {

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
 * TODO 添加建筑的范围过滤逻辑，避免整个 Scene Object 中的建筑全都可以看清外观细节
 * 可利用 Building Record 中的 centerPosition 信息
 */
function syncActiveExteriorVisualDescriptions(state: GameState): void {
  state.activeExteriorVisualDescriptions = Object.keys(state.exteriorVisualDescriptions)
}

/**
 * 只激活玩家当前所处 building + level + sector 对应的 Sector VD。
 * @param state
 */
function syncActiveSectorVisualDescriptions(state: GameState): void {
  const location = state.playerIndoorLocation;
  if (!location) {
    state.activeSectorVisualDescriptions = [];
    return;
  }

  const record = state.buildingRecords[location.buildingId];
  if (!record) {
    throw new Error(`Missing building record for ${location.buildingId}.`);
  }

  const roomContext = findIndoorLocationContext(record, location);
  if (!roomContext) {
    throw new Error(`Room ${location.roomId} is not present in building ${location.buildingId}.`);
  }

  state.activeSectorVisualDescriptions = Object.entries(state.sectorVisualDescriptions)
    .filter(([, sectorRecord]) => (
      sectorRecord.buildingId === location.buildingId
      && sectorRecord.level === location.level
      && sectorRecord.sectorName === roomContext.sectorName
    ))
    .map(([id]) => id);
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
/**
 * TODO 也许可以用来一次性给所有建筑都生成 Building Schema
 * @param scene
 * @returns
 */
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

async function initializeOpeningIndoorState(state: GameState): Promise<void> {
  const buildingId = await findContainingBuildingFeatureId(state.playerPosition);
  if (!buildingId) {
    state.playerIndoorLocation = null;
    state.activeVisibleLocations = [];
    return;
  }

  // 开局命中建筑后必须把整条室内链路跑通，避免后续 prompt 看到半成品状态。
  const schema = await ensureBuildingSchema(buildingId, state);
  const record = generateBuildingRecord(schema);
  state.buildingRecords[record.featureId] = record;
  state.playerIndoorLocation = chooseInitialIndoorLocation(record);
}

function formatIndoorWorldStatePrompt(state: GameState): string | null {
  const location = state.playerIndoorLocation;
  if (!location) {
    return null;
  }

  const record = state.buildingRecords[location.buildingId];
  if (!record) {
    throw new Error(`Missing building record for ${location.buildingId}.`);
  }

  const roomContext = findIndoorLocationContext(record, location);
  if (!roomContext) {
    throw new Error(`Room ${location.roomId} is not present in building ${location.buildingId}.`);
  }

  const visibleLocations = state.activeVisibleLocations
    .map((entry) => {
      const visibleContext = findVisibleLocationContext(record, entry);
      if (!visibleContext) {
        return null;
      }

      if (visibleContext.locationType === 'suite') {
        return [
          `* level=${visibleContext.level}`,
          `sector=${visibleContext.sectorName}`,
          `suite=${visibleContext.suiteId} / （仅表层可见） / ${visibleContext.suiteDescription}`,
        ].join(' / ');
      }

      return [
        `* level=${visibleContext.level}`,
        `sector=${visibleContext.sectorName}`,
        visibleContext.suiteId
          ? `suite=${visibleContext.suiteId} / roomId=${visibleContext.roomId} / ${visibleContext.roomDescription}`
          : `roomId=${visibleContext.roomId} / ${visibleContext.roomDescription}`,
      ].join(' / ');
    })
    .filter((entry): entry is string => Boolean(entry))
    .join('\n');

  return [
    `buildingId=${record.featureId}`,
    `buildingCategory=${record.category}`,
    `buildingCenter=(${record.centerPosition.lat}, ${record.centerPosition.lon})`,
    `currentLevel=${location.level}`,
    `currentSector=${roomContext.sectorName}`,
    roomContext.suiteId
      ? `currentRoom=suite ${roomContext.suiteId} / subRoom ${roomContext.roomId} / ${roomContext.roomDescription}`
      : `currentRoom=room ${roomContext.roomId} / ${roomContext.roomDescription}`,
    '当前可见的室内位置：',
    visibleLocations || '（暂无）',
  ].join('\n');
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

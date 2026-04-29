import { randomUUID } from 'node:crypto';
import { SceneObject } from '../scene/sceneObject.js';
import {
  cloneGameState,
  createRuntimeSession,
  GameClientSessionSnapshot,
  GameSession,
  GameState,
  getRuntimeSession,
  toClientGameSessionSnapshot,
  updateRuntimeSession,
} from './gameSessionStore.js';
import {chooseRandomIndoorLocation} from './toolIndoorPosition.js';
import { streamInitialBookMessage, streamRegularBookMessage } from './agentBookComposer.js';
import { updateActiveVisualDescriptionRefs, upsertVisualDescriptions } from './agentVisualDescriber.js';
import { fillBasicActiveIndoorLocations } from './toolActiveIndoorLocations.js';
import { applyGameStateToolCalls, gameStateManager } from './agentStateManager.js';
import { ensureBuildingRecord, findContainingBuildingFeatureId } from '../buildingGeneration/buildingRecord.js';

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

export type EmitGameEvent = (event: GameStreamEvent) => void | Promise<void>;

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
    await applyGameStateToolCalls(workingState, toolCalls);
    // 在生成当前回合 Book 之前，刷新 prompt 依赖的指向 Xxx Visual Description 的索引
    updateActiveVisualDescriptionRefs(workingState);
    // 把 toolCalls 作为玩家输入的附带信息写入
    const lastMessage = workingState.messageHistory[workingState.messageHistory.length - 1]
    if (lastMessage.role === "player" && toolCalls.length > 0) lastMessage.stateChange = toolCalls

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
    // 后台新写入 VD 记录之后，刷新提交给前端快照的 active 列表
    updateActiveVisualDescriptionRefs(nextState);
    session.gameState = nextState;
    await updateRuntimeSession(session);
  } finally {
    session.runtime.pendingVisualDescription = false;
  }
}


//#region 帮助函数

async function initializeOpeningIndoorState(state: GameState): Promise<void> {
  const containingBuilding = await findContainingBuildingFeatureId(state.playerPosition);
  if (!containingBuilding) {
    state.playerIndoorLocation = null;
    state.activeVisibleLocations = [];
    return;
  }

  // 开局命中建筑后必须把整条室内链路跑通，避免后续 prompt 看到半成品状态。
  const record = await ensureBuildingRecord(containingBuilding.featureId, state);
  // 建筑命中查询拿到的 tags 需要稳定保留在 record 中，供开局与后续回合复用。
  record.tags = containingBuilding.tags;
  state.playerIndoorLocation = chooseRandomIndoorLocation(record);
  fillBasicActiveIndoorLocations(state)
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



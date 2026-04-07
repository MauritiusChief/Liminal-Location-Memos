import { randomUUID } from 'node:crypto';
import { RangedPosition } from '@/routes/apiTypes.js';
import { degreesToRadians, distanceBetweenCoordinates, distanceToPosition, EARTH_RADIUS_METERS, normalizeLongitude, radiansToDegrees } from '@/services/geometry.js';
import { buildSceneFromRequest } from '../scene/sceneObject.js';
import { buildScenePrompt } from '../scene/scenePrompt.js';
import {
  buildGameStateManagerSystemPrompt,
  INITIAL_BOOK_MESSAGE_SYSTEM,
  OUTDOOR_VISUAL_DESCRIPTION_SYSTEM,
  REGULAR_BOOK_MESSAGE_SYSTEM,
} from './systemPrompts.js';
import { writeGameDebugMarkdown } from './gameDebug.js';
import { generateJsonReplySingleMessage, generateReplyFullMessages, generateReplySingleMessage } from './llm.js';
import {
  createSession,
  GameSession,
  getSession,
  OutdoorVisualDescriptionRecord,
  Position,
  updateSession,
} from './gameSessionStore.js';

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

const INITIAL_SCENE_RADIUS_METERS = 1000;
const REGULAR_SCENE_RADIUS_METERS = 500;
const VISUAL_DESCRIPTION_RADIUS_METERS = 300;

//#region 游戏状态工具

type MovePlayerToolCall = {
  bearingDegrees: number,
  distanceMeters: number,
  reason: string,
}

const MOVE_PLAYER_TOOL: GameStateToolDef = {
  name: 'move_player',
  description: [
    '当用户明确或隐含地要求玩家移动时，综合判断玩家自身状态以及周遭的环境信息，然后使用此工具更改游戏角色的经纬度。',
    '注意：即使用户要求移动了，也需要分析是否有阻碍移动的障碍、玩家状态是否足以支持此次移动等条件。如果分析表明这次移动没法完整执行，可以将移动的目的地修改在近处。',
    '（比如如果因存在障碍而无法移动，可以将目的地设置在障碍物面前）',
  ],
  arguments: {
    bearingDegrees: { type: 'number', optional: false, description: '以正北为0度，顺时针增加。' },
    distanceMeters: { type: 'number', optional: false, description: '移动距离，单位米。' },
    reason: { type: 'string', optional: true, description: '简短说明为何这样移动。' },
  },
};

//#region 主函数

/**
 * 根据 request 生成 Scene Prompt，然后生成第一条 Book Message
 * @param request
 * @returns 整个游戏的第一条描述周遭状况的 Book Message
 */
async function initialBookMessage(request: RangedPosition): Promise<string> {
  console.log(`[${new Date().toISOString()}] initialBookMessage() 触发`);

  const sceneObject = await buildSceneFromRequest(request);
  const scenePrompt = buildScenePrompt(sceneObject);
  const generated = await generateReplySingleMessage(
    INITIAL_BOOK_MESSAGE_SYSTEM,
    scenePrompt,
  );
  await writeGameDebugMarkdown({
    functionName: 'initialBookMessage',
    systemPrompt: INITIAL_BOOK_MESSAGE_SYSTEM,
    input: scenePrompt,
    reply: generated.reply,
    reasoning: generated.reasoning,
  });

  return generated.reply;
}

/**
 * 从某个 Book Message 里提取事实性细节供记录，以维持事实一致性
 * @param bookMessage
 * @returns
 */
async function extractOutdoorVisualDescription(
  bookMessage: string,
  pos: Position,
  oldVisualDescription?: string,
): Promise<string> {
  console.log(`[${new Date().toISOString()}] 开始 extractOutdoorVisualDescription()`);

  const { lat, lon } = pos;
  const sceneObject = await buildSceneFromRequest({ lat, lon, radius: VISUAL_DESCRIPTION_RADIUS_METERS });
  const scenePrompt = buildScenePrompt(sceneObject);

  const message = [
    'OpenStreetMap 数据摘要：',
    scenePrompt,
    '---',
    '旧的事实性细节记录：',
    oldVisualDescription ?? '（暂无）',
    '---',
    '文本描述：',
    bookMessage,
  ].join('\n');

  const response = await generateReplySingleMessage(
    OUTDOOR_VISUAL_DESCRIPTION_SYSTEM,
    message,
  );
  await writeGameDebugMarkdown({
    functionName: 'extractOutdoorVisualDescription',
    systemPrompt: OUTDOOR_VISUAL_DESCRIPTION_SYSTEM,
    input: message,
    reply: response.reply,
    reasoning: response.reasoning,
  });
  return response.reply;
}

/**
 * 从 Game Session 获取所需信息，尤其是玩家最新的消息，然后单独给一个 agent，令其返回该玩家行为将导致的游戏状态变化
 * @param session 保证 messageHistory 最新一条为 player Message 的 GameSession
 * @returns 需要改变的游戏状态，各自需要改变的值等等，如果出错则返回空列表
 */
async function gameStateManager(session: GameSession): Promise<GameStateToolCall[]> {
  console.log(`[${new Date().toISOString()}] gameStateManager() 触发`);

  const toolDefs = [MOVE_PLAYER_TOOL].map((def) => toToolPrompt(def));
  const systemPrompt = buildGameStateManagerSystemPrompt(toolDefs);
  const messageHistory = session.messageHistory;
  const latestPlayerMessage = messageHistory[messageHistory.length - 1]; // 盲目取最后一个，因此输入时 session 得保证最新一个确实是 Player Message
  const worldStatePrompt = await toWorldStatePrompt(session);
  const message = [
    '玩家发送的消息：',
    `> ${latestPlayerMessage?.content ?? ''}`,
    '近期对话历史：', // 保留最近 3 轮 / 6 次对话
    messageHistory
      .slice(Math.max(0, messageHistory.length - 6), messageHistory.length - 1) // 最新对话已经由 latestPlayerMessage 表示，所以这里其实是 5 个对话
      .map((message) => {
        const hint = message.role === 'book' ? '**游戏输出**' : '**玩家输入**';
        return `> ${hint}：${message.content}\n>`;
      })
      .join('\n'),
    '---',
    worldStatePrompt,
  ].join('\n');

  try {
    // 获取 LLM 返回
    const response = await generateJsonReplySingleMessage(
      systemPrompt,
      message,
    );
    let replyForDebug: GameStateToolCall[] | string = response.reply;
    // 解析返回
    const parsedToolCall: GameStateToolCall[] = JSON.parse(response.reply);
    replyForDebug = parsedToolCall;
    await writeGameDebugMarkdown({
      functionName: 'gameStateManager',
      systemPrompt,
      input: message,
      worldStatePrompt,
      reply: replyForDebug,
      reasoning: response.reasoning,
    });
    return parsedToolCall;

  } catch(e) {
    console.error(e)
    return []
  }
}

/**
 * 以传统的 system, user, assist... 格式。以及虚拟的 tool calling 生成最新的回复
 * @param session
 * @returns
 */
async function generateBookMessage(session: GameSession): Promise<string> {
  console.log(`[${new Date().toISOString()}] generateBookMessage() 触发`);

  const worldStatePrompt = await toWorldStatePrompt(session);
  const messageHistory = session.messageHistory;
  const response = await generateReplyFullMessages(
    REGULAR_BOOK_MESSAGE_SYSTEM,
    messageHistory.slice(Math.max(0, messageHistory.length - 12)),
    worldStatePrompt,
  );
  await writeGameDebugMarkdown({
    functionName: 'generateBookMessage',
    systemPrompt: REGULAR_BOOK_MESSAGE_SYSTEM,
    input: messageHistory.slice(Math.max(0, messageHistory.length - 12)),
    worldStatePrompt,
    reply: response.reply,
    reasoning: response.reasoning,
  });
  return response.reply;
}

//#region 出口函数

/**
 * 开始游戏，生成新的 Game Session，并写入第一条 Book Message 与对应的 Outdoor Visual Description。
 * @returns 完整初始化后的 Game Session
 */
export async function startGame(): Promise<GameSession> {
  console.log(`[${new Date().toISOString()}] 开始游戏`);

  const session = await createSession();
  const { lat, lon } = session.playerPosition;
  const openingMessage = await initialBookMessage({
    lat,
    lon,
    radius: INITIAL_SCENE_RADIUS_METERS,
  });

  session.messageHistory.push({
    role: 'book',
    content: openingMessage,
  });

  await upsertOutdoorVisualDescription(session, openingMessage);
  await updateSession(session);
  return session;
}

/**
 * 输入玩家发送的消息，经过完整的一轮处理（包括更新游戏状态等）后，最终输出最新的 Game Session。
 * @param sessionId
 * @param playerMessage
 * @returns 包含最终 Book Message 在内的整个 GameSession，或者表示失败的 undefined
 */
export async function runGameTurn(sessionId: string, playerMessage: string): Promise<GameSession | undefined> {
  console.log(`[${new Date().toISOString()}] 运行回合...`);

  const session = await getSession(sessionId);
  if (!session) {
    return undefined;
  }

  session.playerIndoorLocation = null;
  session.messageHistory.push({
    role: 'player',
    content: playerMessage,
  });

  const toolCalls = await gameStateManager(session);
  applyGameStateToolCalls(session, toolCalls);
  syncActiveOutdoorVisualDescriptions(session);

  const bookMessage = await generateBookMessage(session);
  session.messageHistory.push({
    role: 'book',
    content: bookMessage,
  });

  console.log(`[${new Date().toISOString()}] 回合即将结束，将要更新存档并返回前端数据`);
  await upsertOutdoorVisualDescription(session, bookMessage);
  await updateSession(session);
  return session;
}

//#region 帮助函数

/**
 * TODO 目前只输入基本信息，建筑内部相关内容后续再加
 * 系统性把 Game State 中除开对话的部分转化为当前状态的提示词描述
 * @param state
 * @returns
 */
async function toWorldStatePrompt(state: GameSession): Promise<string> {
  const { lat, lon } = state.playerPosition;
  const sceneObject = await buildSceneFromRequest({ lat, lon, radius: REGULAR_SCENE_RADIUS_METERS });
  const scenePrompt = buildScenePrompt(sceneObject);
  const outdoorVisualDescriptions = Object.entries(state.outdoorVisualDescriptions)
    .filter(([id]) => state.activeOutdoorVisualDescriptions.includes(id))
    .map(([, record]) => record.content)
    .join('\n');

  return [
    '玩家周遭环境数据：',
    scenePrompt,
    '---',
    '玩家周遭环境细节记录：',
    outdoorVisualDescriptions || '（暂无）',
  ].join('\n');
}

/**
 * 执行 Game State Manager 给出的工具调用。
 * 最小可跑阶段只接 move_player，其他工具名一律忽略。
 */
function applyGameStateToolCalls(session: GameSession, toolCalls: GameStateToolCall[]): void {
  for (const toolCall of toolCalls) {
    console.log(`[${new Date().toISOString()}] 开始解析 ${toolCall.name} 工具参数：`, toolCall.arguments);

    if (toolCall.name !== MOVE_PLAYER_TOOL.name) {
      continue;
    }
    // 清洗 arguments
    const args = toolCall.arguments
    const bearingDegrees = Number(args.bearingDegrees);
    const distanceMeters = Number(args.distanceMeters);
    if (!Number.isFinite(bearingDegrees) || !Number.isFinite(distanceMeters) || distanceMeters < 0) {
      continue;
    }
    // 实际转移位置函数
    const nextPosition = movePosition(session.playerPosition, bearingDegrees, distanceMeters);
    if (!nextPosition) {
      continue;
    }

    console.log(`[${new Date().toISOString()}] 移动玩家工具完成`);

    session.playerPosition = nextPosition;
    session.playerIndoorLocation = null;
  }
}

/**
 * 把 move_player 工具参数转换为新的玩家坐标。
 */
function movePosition(
  position: Position,
  bearingDegrees: number,
  distanceMeters: number,
): Position {
  const bearingRadians = degreesToRadians(bearingDegrees);
  const latRadians = degreesToRadians(position.lat);
  const lonRadians = degreesToRadians(position.lon);
  const angularDistance = distanceMeters / EARTH_RADIUS_METERS;

  const nextLat = Math.asin(
    Math.sin(latRadians) * Math.cos(angularDistance)
      + Math.cos(latRadians) * Math.sin(angularDistance) * Math.cos(bearingRadians),
  );
  const nextLon = lonRadians + Math.atan2(
    Math.sin(bearingRadians) * Math.sin(angularDistance) * Math.cos(latRadians),
    Math.cos(angularDistance) - Math.sin(latRadians) * Math.sin(nextLat),
  );

  return {
    lat: radiansToDegrees(nextLat),
    lon: normalizeLongitude(radiansToDegrees(nextLon)),
  };
}

/**
 * 根据当前 Book Message 为玩家当前位置补写或更新 Outdoor Visual Description。
 * 若 300m 内已有记录，则就近复用；否则新建一条以当前位置为中心的记录。
 */
async function upsertOutdoorVisualDescription(session: GameSession, bookMessage: string): Promise<void> {
  const matchedRecord = findNearestOutdoorVisualDescription(session, session.playerPosition);
  const extracted = await extractOutdoorVisualDescription(
    bookMessage,
    session.playerPosition,
    matchedRecord?.content,
  );
  const now = new Date().toISOString();

  if (matchedRecord) {
    matchedRecord.content = extracted;
    matchedRecord.center = { ...session.playerPosition };
    matchedRecord.updatedAt = now;
  } else {
    const newRecord: OutdoorVisualDescriptionRecord = {
      id: randomUUID(),
      center: { ...session.playerPosition },
      content: extracted,
      createdAt: now,
      updatedAt: now,
    };
    session.outdoorVisualDescriptions[newRecord.id] = newRecord;
  }

  syncActiveOutdoorVisualDescriptions(session);
}

/**
 * 重新计算当前应当对 LLM 生效的 Outdoor Visual Description 列表。
 * 最小可跑阶段采用简单距离规则：只激活玩家 300m 范围内的记录。
 */
function syncActiveOutdoorVisualDescriptions(session: GameSession): void {
  const records = Object.values(session.outdoorVisualDescriptions)
    .filter((record) => distanceToPosition(record.center, session.playerPosition) <= VISUAL_DESCRIPTION_RADIUS_METERS)
    .sort(
      (left, right) =>
        distanceToPosition(left.center, session.playerPosition) - distanceToPosition(right.center, session.playerPosition),
    );

  session.activeOutdoorVisualDescriptions = records.map((record) => record.id);
}

/**
 * 查找距离当前位置最近、且仍在 300m 生效半径内的 Outdoor Visual Description。
 * @param session
 * @param position
 * @returns
 */
function findNearestOutdoorVisualDescription(
  session: GameSession,
  position: Position,
): OutdoorVisualDescriptionRecord | null {
  const records = Object.values(session.outdoorVisualDescriptions)
    .map((record) => ({
      record,
      distanceMeters: distanceToPosition(record.center, position),
    }))
    .filter((entry) => entry.distanceMeters <= VISUAL_DESCRIPTION_RADIUS_METERS)
    .sort((left, right) => left.distanceMeters - right.distanceMeters);

  return records[0]?.record || null;
}


/**
 * 把 GameStateToolDef 转化为可直接排入提示词的字符串
 * @param toolDef
 * @returns
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

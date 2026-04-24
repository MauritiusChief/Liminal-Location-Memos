import { buildSceneFromRequest } from "../scene/sceneObject.js";
import { writeGameDebugRequest, writeGameDebugResult } from "./gameDebug.js";
import { GameState } from "./gameSessionStore.js";
import { generateJsonReplySingleMessage } from "./llm.js";
import { BUILD_GAME_STATE_MANAGER_SYSTEM } from "./systemPrompts.js";
import { applySyncActiveIndoorLocationsTool } from "./toolActiveIndoorLocations.js";
import { applySetPlayerIndoorLocationTool } from "./toolIndoorPosition.js";
import { applyMovePlayerTool } from "./toolMovePlayer.js";

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

const WORLD_STATE_RADIUS_METERS = 500;

//#region 游戏状态工具

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

//#region 主函数

/**
 * 从 Game State 获取所需信息，尤其是玩家最新的消息，然后单独给一个 agent，令其返回该玩家行为将导致的游戏状态变化
 *
 * 它的职责只是“决定要做什么”，而不直接改状态。
 * 真正执行这些变化的是 applyGameStateToolCalls()。
 * @param state 保证 messageHistory 最新一条为 player Message 的 GameState
 * @returns 需要改变的游戏状态，各自需要改变的值等等，如果出错则返回空列表
 */
export async function gameStateManager(state: GameState): Promise<GameStateToolCall[]> {
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
 * 拆分为给 Game State Manager 用的完整版 world state，
 * 和 Book 消息生成者使用的只关心可见部分的 world state
 *
 * 把当前 GameState 转成可消费的 world-state 提示词。
 * world-state 提示词消费者：
 * - Book 消息生成者
 * - Game State Manager
 * @param state
 * @param scene 已按照合理半径获取的 Scene Object；室内开局时可留空
 * @param onlyVisible 是否只包含可见部分（给 Book 消息生成者用）
 * @returns 同时兼容室内与室外上下文的提示词
 */
export async function toWorldStatePrompt(
  state: GameState,
  scene?: SceneObject,
  onlyVisible: boolean = true,
): Promise<string> {
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
      `楼层：level ${record.level}`,
      `区域：${record.sectorName}`,
      record.content,
    ].join('\n'))
    .join('\n\n');
  const buildingLocation = state.playerIndoorLocation;
  const currentBuildingRecord = buildingLocation
    ? state.buildingRecords[buildingLocation.buildingId]
    : null;
  const buildingRecordPrompt = !onlyVisible && currentBuildingRecord
    ? formatBuildingRecordPrompt(currentBuildingRecord)
    : null;

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
  if (buildingRecordPrompt) {
    sections.push('---', '当前建筑的 Building Record：', buildingRecordPrompt);
  }

  return sections.join('\n');
}

/**
 * 执行 Game State Manager 给出的工具调用。
 *
 * 当前只支持 move_player：
 * - 参数合法才会执行；
 * - 成功移动后，玩家朝向也会改成这次移动方向；
 */
export async function applyGameStateToolCalls(state: GameState, toolCalls: GameStateToolCall[]): Promise<void> {
  for (const toolCall of toolCalls) {
    console.log(`[${new Date().toISOString()}] 开始解析 ${toolCall.name} 工具参数：`, toolCall.arguments);

    const args = toolCall.arguments;

    switch (toolCall.name) {
      case MOVE_PLAYER_TOOL.name:
        applyMovePlayerTool(state, args);
        break;
      case SET_PLAYER_INDOOR_LOCATION_TOOL.name:
        await applySetPlayerIndoorLocationTool(state, args);
        break;
      case SYNC_ACTIVE_INDOOR_LOCATIONS_TOOL.name:
        applySyncActiveIndoorLocationsTool(state, args);
        break;
    }

  }
}

//#region 辅助函数

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

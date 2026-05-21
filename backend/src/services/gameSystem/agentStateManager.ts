import { distanceBetweenCoordinates } from "../geometry.js";
import { buildSceneFromRequest, SceneObject } from "../scene/sceneObject.js";
import { buildScenePrompt } from "../scene/scenePrompt.js";
import { formatFieldVisualDescriptionPrompt, formatIndoorLocationPrompt, formatVisibleLocationPrompt } from "./agentBookComposer.js";
import { findRoomInBuilding, type BuildingLevel, type BuildingRecord, type BuildingRoom, type BuildingSector } from "../buildingGeneration/buildingRecord.js";
import { writeGameDebugRequest, writeGameDebugResult } from "./gameDebug.js";
import { ExteriorVisualDescriptionRecord, FieldVisualDescriptionRecord, GameMessage, GameState, PlayerIndoorLocation, PlayerVisibleLocation, Position, RoomVisualDescriptionRecord } from "./gameSessionStore.js";
import { generateJsonReplyWithSource } from "./llm.js";
import { BUILD_GAME_STATE_MANAGER_SYSTEM } from "./systemPrompts.js";
import { applySetPlayerIndoorLocationTool } from "./toolIndoorPosition.js";
import { applyMovePlayerTool } from "./toolMovePlayer.js";
import type { AgentStateRouteCandidate } from "./agentStateRouter.js";
import { buildPlayerActionContextPrompt } from "./agentUtils.js";
import { applySyncPlayerIndoorLocationsTool } from "./toolActiveIndoorLocations.js";
import { CARDBOARD_TEMPLATES, GeneralContent, type CardboardObjectRecord, type ObjectRecord } from "../objectGeneration/objectGeneraterShared.js";
import { type PartRecord } from "../objectGeneration/itemTemplates.js";
import { applyCreateCardboardObject } from "./toolCreateCardboard.js";

export interface GameStateToolCall {
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

export interface LlmToolDef {
  name: string
  description?: string
  parameters: {
    type: "object"
    properties: Record<string, any>
    required?: string[]
  }
}

/**
 * TODO 似乎和 Player State 差异不大？
 * 专门给 Game State Manager 用的，略去无关消息但全面的游戏状态，聚焦于焦点内容。
 * 随后会被直接转为 World State Prompt
 */
export interface WorldState {
  playerPosition: Position;
  playerOrientation: number;
  playerIndoorLocation: PlayerIndoorLocation | null;
  playerVisionRange: number;
  recentMessageHistory: GameMessage[];
  // 下列内容经过筛选，只包含玩家可见部分
  playerBuildingRecords: Record<string, BuildingRecord>;
  playerVisibleLocations: PlayerVisibleLocation[];
  // 只包含玩家可见的 Visual Description
  activeFieldVisualDescriptions: Record<string, FieldVisualDescriptionRecord>;
  activeExteriorVisualDescriptions: Record<string, ExteriorVisualDescriptionRecord>
  activeRoomVisualDescriptions: Record<string, RoomVisualDescriptionRecord>;
}

const WORLD_STATE_RADIUS_METERS = 500;

//#region 游戏状态工具（方案）

const MOVE_PLAYER_TOOL: GameStateToolDef = {
  name: 'move_player',
  description: [
    '当用户明确或隐含地要求玩家移动或转向时，综合判断玩家自身状态以及周遭的环境信息，然后使用此方案令状态机更改游戏角色的朝向与经纬度。',
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
    '当用户明确或隐含地要求玩家进入或离开建筑，或者在建筑的房间之间移动时，使用此方案令状态机改变游戏角色在建筑中的位置。',
    '此方案允许特定条件下在缺失参数时自动补全参数，因此在特定条件下时可以省略某些参数（比如进入建筑时，此方案会令状态机自动补全目标位置为建筑的入口），具体哪些参数在何种情况下可省略参见参数的描述。',
    '注意：',
    '- 即使用户要求了行动，也要分析是否有阻碍行动的障碍、玩家状态是否支持此次行动等条件。如果分析表明这次行动无法进行，可以不使用此方案（令玩家在建筑中的位置不变）或者将行动的类型/目的位置改为逻辑上更合理的地方（比如试图离开建筑发现大门被锁而变为移动到大堂）。',
    '- 行动的类型为进入或离开建筑时，以及在楼层内长距离跨区域(sector)移动时，需要同步调用 move_player 方案来改变玩家的实际经纬度；不用考虑是否真实落在建筑内/外的问题，实际落盘时会微调到合理的临近位置。'
  ],
  arguments: {
    move: { type: 'string', optional: false, description: '玩家行动的类型，必须为`enter`(进入建筑), `leave`(离开建筑), `move`(在建筑中移动)这三者之一。'},
    buildingId: { type: 'string', optional: true, description: '玩家移动的目标建筑物体，为该建筑物的 featureId，仅在 `leave` 行动类型下为非必须参数。'},
    level: { type: 'number', optional: true, description: '玩家移动的目标楼层，为该楼层的层号数，仅在 `move` 行动类型下为必须参数。'},
    sectorName: { type: 'string', optional: true, description: '玩家移动的目标房间所在的区域，仅在同一楼层间移动时为必须参数。'},
    suiteId: { type: 'string', optional: true, description: '若玩家移动的目标房间位于某套房内部，则填写该套房的 id。'},
    roomId: { type: 'string', optional: true, description: '玩家移动的目标房间的 id，仅在同一楼层间移动时为必须参数。'},
  }
}
/**
 * 注意：只负责单个 indoor location 微调。
 * 玩家进入建筑、跨越楼层时，基板 player visible locations 会由程序生成。刻意在新基板生成时不保留旧的微调结果。
 * 默认只暴露当前 Sector 内的普通房间与 suite 表层，不自动暴露 suite 内 subRoom。
 */
const ADJUST_PLAYER_VISIBLE_LOCATION_TOOL: GameStateToolDef = {
  name: 'adjust_player_visible_location',
  description: [
    '结合玩家所在建筑的信息、玩家当前的可视建筑位置以及玩家的行动，判断是否需要更新现有的可视建筑位置列表。',
    '如果需要更新，则使用此方案将需要添加或者删除的可视建筑位置写入游戏状态机。此方案一次只能令状态机更新一处位置，如需更新多处则需使用多次。'
  ],
  arguments: {
    edit: { type: 'string', optional: false, description: '更新的类型，必须为`reveal`(揭露可视位置), `hide`(隐藏可视位置)二者之一。'},
    level: { type: 'number', optional: false, description: '被揭露或者隐藏的建筑位置的楼层层号数。'},
    suiteId: { type: 'string', optional: true, description: '若操作的目标是某个套房表层或套房内部子房间，则填写该套房 id。'},
    roomId: { type: 'string', optional: true, description: '被揭露或者隐藏的具体房间 id；若只操作 suite 表层则留空。'},
  }
}

/**
 * TODO：改名或者细化描述，让模型不要误以为细化时也使用此方案
 * 
 * 创建 Cardboard XXX 的游戏工具，来源必须是完全可见的信息（不能创建看不到的东西）
 * 暴露给 Book Composer 时不能说是草稿/Cardboard, 就说是 xxx info 好了
 * 
 * 其特性决定了，创建的一定是房间中/户外地上的“表层” Cardboard xxx。
 * 因为任何内部的 Cardboard 都是在“表层”Cardboard xxx 细化得来的。
 * 
 * 创建 Cardboard Furniture 时：
 * 此工具会根据模板与变种自动决定包含哪些功能并设置对应的 Cardboard Item
 * 而 Cardboard Loots 有些会被自动设置，有些需要 LLM 指定
 * 
 * 创建 Cardboard Item 时:
 * 不用来创建 Cardboard Furniture/Vehicle 的功能物品
 */
const DRAFT_OBJECT_TOOL: GameStateToolDef = {
  name: "draft_object_tool",
  description: [
    '如果用户的行动需要与物体互动，但现有游戏状态机没有可供互动的对象，或者互动对象仅存在于细节记录中，则使用此方案在游戏状态机中创建可互动的对象。',
    '可通过`query_template`函数获取例子来理解有哪些东西模板可用。',
  ],
  arguments: {
    template: { type: 'string', optional: false, description: '创建时所使用的模板的id, 可通过`query_template`函数输入中文关键字查询可使用的模板(以及变种)。'},
    varient: { type: 'string', optional: true, description: '创建时使用模板的哪种变种的id，`query_template`函数查询模板时会附上其所有可用变种。'},
    content: { type: 'JSON array of string', optional: true, description: '创建时填充哪个或哪些内容物表的id，`query_template`函数查询模板时会附上其所有可用内容物表。'},
    note: { type: 'string', optional: true, description: '该可互动对象的其他外观细节。'},
  }
}

/**
 * TODO
 * 需要新增的方案：
 * - 直接移动 Cardboard Object（到地上或者到背包里等）的方案
 * - 从 Cardboard Loots 里拿单独 Cardboard Item 的方案（Cardboard Loots 的质量、体积随之减小）
 * - 模板细化 Cardboard Loots 的方案
 *   - 仅用作对没有直观描述的 Cardboard 直接细化。如果从已有直观描述的 Cardboard Loots 拿东西，用上一个方案。
 *   - 仅可套模板，程序随机生成东西。
 *   - 细化完成后，Cardboard Loots 直接消失。
 *   - 每次细化都会动态更新外部的 MVL。
 * - 模板细化 Cardboard Item/Furniture/Vehicle 的方案
 *   - 套模板得到其材料、形状信息，或者其内部组成部分。
 *   - MVL 信息根据材料、形状，或者其内部组成部分的 MVL 计算得出。
 *   - 每次细化都会动态更新外部的 MVL（换言之，此方案可用于细化内部的 Cardboard Item）。
 * - 创新细化 Cardboard Item/Furniture/Vehicle 的方案
 *   - 与模板细化完全一致，除了其材料、形状信息或者其内部组成部分由 LLM 填写。
 * - 直接创建 Item/Furniture/Vehicle 的方案
 *   - 从环境信息直接创建的方案，不经过先创建 Cardboard 再细化的过程
 */

//#region 渐进式披露工具

// const LIST_TEMPLATE_LLM_TOOL: LlmToolDef = {
//   name: "list_template",
//   description: "列举某个大类的或者全部的，创建‘供用户行动用的对象’的模板。",
//   parameters: {
//     type: "object",
//     properties: {
//       "kind": {
//         type: "string",
//         description: "需要列举模板的大类（目前仅`Furniture`可用），留空以列举所有大类的模板。",
//       }
//     },
//   }
// }

const QUERY_TEMPLATE_LLM_TOOL: LlmToolDef = {
  name: "query_template",
  description: "输入中文关键字，查找匹配的创建‘供用户行动用的对象’的模板。",
  parameters: {
    type: "object",
    properties: {
      "query": {
        type: "array",
        items: {type: "string", description: "一个中文关键字"},
        description: "一个或多个简略中文关键字，返回结果仅有包含全部关键字的模板，无需附加'模板'等冗余字段。",
      }
    },
  }
}

//#region 主函数

/**
 * TODO 做成可反复对话的形式，然后添加渐进式披露
 *
 * 先让 Router 基于对话做行为类型初筛，再让 Manager 结合 worldState 决定最终工具调用。
 *
 * 它的职责只是“决定要做什么以及参数是什么”，而不直接改状态。
 * 真正执行这些变化的是 applyGameStateToolCalls()。
 * @param state 保证 messageHistory 最新一条为 player Message 的 GameState
 * @returns 需要改变的游戏状态，各自需要改变的值等等，如果出错则返回空列表
 */
export async function gameStateManager(
  state: GameState,
  routeCandidates: AgentStateRouteCandidate[],
): Promise<GameStateToolCall[]> {
  console.log(`[${new Date().toISOString()}] gameStateManager() 触发`);

  const toolDefs = [
    MOVE_PLAYER_TOOL,
    SET_PLAYER_INDOOR_LOCATION_TOOL,
    ADJUST_PLAYER_VISIBLE_LOCATION_TOOL,
    DRAFT_OBJECT_TOOL,
  ].map((def) => toToolPrompt(def));
  const systemPrompt = BUILD_GAME_STATE_MANAGER_SYSTEM(toolDefs);
  const { lat, lon } = state.playerPosition;
  const sceneObject = await buildSceneFromRequest({ lat, lon, radius: WORLD_STATE_RADIUS_METERS}, state.playerOrientation);
  const worldState = pickWorldState(state)
  const worldStatePrompt = await toWorldStatePrompt(worldState, sceneObject);
  // Manager 使用 Router 的初筛结果缩小判断范围，但最终仍以完整 worldState 为准。
  const message = [
    buildPlayerActionContextPrompt(state),
    '---',
    '行为类型初筛候选：',
    formatRouteCandidatesPrompt(routeCandidates),
    '---',
    worldStatePrompt,
  ].join('\n');
  await writeGameDebugRequest({
    mode: 'user-message',
    functionName: 'gameStateManager',
    systemPrompt,
    userMessage: message,
  });

  const tools = [
    QUERY_TEMPLATE_LLM_TOOL,
  ]

  try {
    // 获取 LLM 返回（支持工具调用循环）
    const response = await generateJsonReplyWithSource(
      systemPrompt,
      message,
      tools,
      CARDBOARD_TEMPLATES
    );
    // // MOCK
    // const response = {reply: '[]', reasoning: ''}
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
 * 执行 Game State Manager 给出的工具调用。
 *
 * 当前只支持 move_player：
 * - 参数合法才会执行；
 * - 成功移动后，玩家朝向也会改成这次移动方向；
 */
export async function applyGameStateToolCalls(state: GameState, toolCalls: GameStateToolCall[]): Promise<void> {
  const isMoveIntendedIndoor = isIntendedIndoor(toolCalls);

  for (const toolCall of toolCalls) {
    console.log(`[${new Date().toISOString()}] 开始解析 ${toolCall.name} 工具参数：`, toolCall.arguments);

    const args = toolCall.arguments;

    switch (toolCall.name) {
      case MOVE_PLAYER_TOOL.name:
        await applyMovePlayerTool(state, args, isMoveIntendedIndoor);
        break;
      case SET_PLAYER_INDOOR_LOCATION_TOOL.name:
        await applySetPlayerIndoorLocationTool(state, args);
        break;
      case ADJUST_PLAYER_VISIBLE_LOCATION_TOOL.name:
        applySyncPlayerIndoorLocationsTool(state, args);
        break;
      case DRAFT_OBJECT_TOOL.name:
        applyCreateCardboardObject(state, args);
        break
    }

  }
}

//#region 内部逻辑

/**
 * 检查一下最终目的是不是室内移动
 * @param toolCalls
 * @returns 目的地是否应该在室内
 */
export function isIntendedIndoor(toolCalls: GameStateToolCall[]): boolean | undefined {
  const finalIndoorToolCall = [...toolCalls]
    .reverse()
    .find((toolCall) => toolCall.name === SET_PLAYER_INDOOR_LOCATION_TOOL.name);
  const move = finalIndoorToolCall?.arguments?.move;

  if (move === "enter" || move === "move") return true

  if (move === "leave") return false

  return undefined;
}

function formatRouteCandidatesPrompt(routeCandidates: AgentStateRouteCandidate[]): string {
  if (!routeCandidates.length) {
    return '[]（初筛为空；可能代表无状态变化，也可能代表初筛失败，请仍结合完整游戏状态判断。）';
  }

  const sanitized = routeCandidates.map(c => ({
    candidate_type: c.action,
    confidence: c.confidence,
    reason: c.reason,
  }));
  return JSON.stringify(sanitized, null, 2);
}

export function pickWorldState(state: GameState): WorldState {
  const {playerPosition, playerOrientation, playerIndoorLocation, playerVisionRange, playerVisibleLocations} = state
  // TODO 也许需要动用数据库，判断建筑的最近点而非建筑的中心
  const playerBuildingRecords = Object.fromEntries(Object.entries(state.buildingRecords).filter(
    ([featureId, record]) => {
      const {lon: recordLon, lat: recordLat} = record.centerPosition
      const {lon: playerLon, lat: playerLat} = state.playerPosition
      return distanceBetweenCoordinates([recordLon, recordLat], [playerLon, playerLat]) < state.playerVisionRange
      // return featureId === state.playerIndoorLocation?.buildingId
    }
  ))
  const activeFieldVisualDescriptions = Object.fromEntries(Object.entries(state.fieldVisualDescriptions).filter(
    ([uuid, _]) => state.activeFieldVisualDescriptions.includes(uuid)
  ))
  const activeExteriorVisualDescriptions = Object.fromEntries(Object.entries(state.exteriorVisualDescriptions).filter(
    ([featureId, _]) => state.activeExteriorVisualDescriptions.includes(featureId)
  ))
  const activeRoomVisualDescriptions = Object.fromEntries(Object.entries(state.roomVisualDescriptions).filter(
    ([uuid, _]) => state.activeRoomVisualDescriptions.includes(uuid)
  ))
  return {
    playerPosition,
    playerOrientation,
    playerIndoorLocation,
    playerVisionRange,
    recentMessageHistory: state.messageHistory.slice(-12),
    playerVisibleLocations,
    playerBuildingRecords,
    activeFieldVisualDescriptions,
    activeExteriorVisualDescriptions,
    activeRoomVisualDescriptions,
  }
}

/**
 * 把当前 GameState 转成可消费的 world-state 提示词。
 * 消费者为 Game State Manager。相比 Player State 多了相关建筑完整结构
 * @param state
 * @param scene 已按照合理半径获取的 Scene Object
 * @returns
 */
export async function toWorldStatePrompt(state: WorldState, scene?: SceneObject): Promise<string> {
  // 室外相关的信息
  const scenePrompt = scene ? buildScenePrompt(scene, state.playerOrientation) : null;
  const fieldVisualDescriptionPrompt =  Object.values(state.activeFieldVisualDescriptions)
    .map(record => formatFieldVisualDescriptionPrompt(state, record))
    .join('\n\n')
  const exteriorVisualDescriptionPrompt =  Object.values(state.activeExteriorVisualDescriptions)
    .map((record) => [`建筑ID：${record.buildingId}`, record.content].join('\n'))
    .join('\n');
  // 室内相关的信息——分离后：位置基础信息（formatIndoorLocationPrompt）+ 详细物体信息（面向 Game State Manager）
  const indoorLocationPrompt = formatIndoorLocationPrompt(state)
  const location = state.playerIndoorLocation;
  const record = location ? state.playerBuildingRecords[location.buildingId] : undefined;
  const room = record && location ? findRoomInBuilding(record, location) : null;
  const contentEntries = room?.content ? Object.values(room.content) : [];
  const worldStateRoomContentPrompt = formatWorldStateRoomContentPrompt(contentEntries);
  const fullIndoorPrompt = [indoorLocationPrompt, worldStateRoomContentPrompt].filter(Boolean).join('\n');

  const roomVisualDescriptionPrompt = Object.values(state.activeRoomVisualDescriptions)
    .map((record) => [`建筑ID：${record.buildingId}`, `房间：level ${record.level} - ${record.roomId}`, record.content].join('\n'))
    .join('\n\n');
  const visibleLocationPrompt = state.playerIndoorLocation
    ? state.playerVisibleLocations.map(location => formatVisibleLocationPrompt(location)).join('\n')
    : null;
  const buildingRecordPrompt = Object.values(state.playerBuildingRecords)
    .map(record => formatBuildingRecordPrompt(record, state.playerIndoorLocation))
    .join('\n\n')

  const sections = [
    '玩家周遭室外环境摘要：',
    scenePrompt || '（当前未提供室外摘要）',
    '---',
    '玩家周遭地点细节记录：',
    fieldVisualDescriptionPrompt || '（暂无）',
    '---',
    '玩家周遭建筑外观细节记录：',
    exteriorVisualDescriptionPrompt || '（暂无）',
    '---',
    '玩家所处房间：',
    fullIndoorPrompt || '（当前未提供室内位置）',
    '---',
    '相关建筑结构：',
    buildingRecordPrompt || '（暂无）',
    '---',
    '玩家可见室内场景摘要：',
    visibleLocationPrompt || '（当前未提供室内摘要）',
    '---',
    '玩家所处房间细节记录：',
    roomVisualDescriptionPrompt || '（暂无）',
  ];

  return sections.join('\n');
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
    `**方案名**: \`${toolDef.name}\``,
    '介绍：',
    toolDef.description.join('\n'),
    '参数：',
    argsStringArray.join('\n'),
  ].join('\n');
}

//#region 建筑细节函数

/**
 * 描述某一建筑裁剪过的细节
 * @param record
 * @returns
 */
function formatBuildingRecordPrompt(record: BuildingRecord, location: PlayerIndoorLocation | null): string {
  const isCurrentBuilding = location?.buildingId === record.featureId;
  const levelLines = Object.values(record.levels)
    .sort((left, right) => left.level - right.level)
    .flatMap((level) => {
      if (!isCurrentBuilding) {
        return renderLevelWithAccessRooms(level, (access) => access === "entrance" || access === "internal");
      }

      if (level.level !== location?.level) {
        return renderLevelWithAccessRooms(level, () => true);
      }

      return [
        `- 楼层 ${level.level}: ${level.description}`,
        ...Object.values(level.sectors).flatMap((sector) => {
          if (sector.name === location.sectorName) {
            return renderFullSector(sector);
          }

          return renderSectorWithAccessRooms(sector, () => true);
        }),
      ];
    });

  return [
    `建筑ID：${record.featureId}`,
    `建筑类别：${record.category}`,
    `建筑几何中心：(${record.centerPosition.lat}, ${record.centerPosition.lon})`,
    `建筑附带标签：${JSON.stringify(record.tags)}`,
    "楼层：",
    ...levelLines,
  ].join("\n");
}

function renderFullSector(sector: BuildingSector): string[] {
  const roomLines = Object.values(sector.rooms).flatMap((room) => {
    if ("subRooms" in room) {
      const subRoomLines = Object.values(room.subRooms)
        .map((subRoom) => `      - 子房间 ${subRoom.roomId}: ${subRoom.description}`);
      return [
        `    - 套房 ${room.suiteId}: ${room.description}`,
        ...subRoomLines,
      ];
    }

    return [renderRoomLine(room, "    ")];
  });

  return [
    formatSectorHeader(sector),
    ...roomLines,
  ];
}

function renderSectorWithAccessRooms(
  sector: BuildingSector,
  accessFilter: (access: BuildingRoom["access"]) => boolean,
): string[] {
  const roomLines = listSectorAccessRoomLines(sector, accessFilter).map((line) => `    - ${line}`);
  return [
    formatSectorHeader(sector),
    ...roomLines,
  ];
}

function renderLevelWithAccessRooms(
  level: BuildingLevel,
  accessFilter: (access: BuildingRoom["access"]) => boolean,
): string[] {
  return [
    `- 楼层 ${level.level}: ${level.description}`,
    ...listLevelAccessRoomLines(level, accessFilter).map((line) => `  - ${line}`),
  ];
}

function listSectorAccessRoomLines(
  sector: BuildingSector,
  accessFilter: (access: BuildingRoom["access"]) => boolean,
): string[] {
  return Object.values(sector.rooms)
    .flatMap((room) => {
      if ("subRooms" in room || !room.access || !accessFilter(room.access)) {
        return [];
      }

      return [`房间 ${room.roomId}: ${room.description} [通道类型：${room.access}]`];
    });
}

function listLevelAccessRoomLines(
  level: BuildingLevel,
  accessFilter: (access: BuildingRoom["access"]) => boolean,
): string[] {
  return Object.values(level.sectors)
    .flatMap((sector) => listSectorAccessRoomLines(sector, accessFilter).map((line) => `区域 ${sector.name} - ${line}`));
}

function formatSectorHeader(sector: BuildingSector): string {
  return `  - 区域 ${sector.name} [面积：${sector.area}, 几何中心：(${sector.centerPosition.lat}, ${sector.centerPosition.lon})]`;
}

function renderRoomLine(room: BuildingRoom, indent: string): string {
  const access = room.access ? ` [通道类型：${room.access}]` : "";
  return `${indent}- 房间 ${room.roomId}: ${room.description}${access}`;
}

//#region 房间内物体提示词（面向 Game State Manager）

/**
 * 组装面向 Game State Manager 的房间内物体提示词。
 * 相比 formatRoomContentPrompt，这里为每个物体提供 UUID、质量/体积/长度（明确或粗略）、材料、形状等详细信息，
 * 供状态机在决定工具调用时参考。
 *
 * 不按"家具"/"物品"分类——物体名称已足矣表达类别。
 * @param contentEntries 按 uuid 索引的房间内物体记录
 * @returns
 */
function formatWorldStateRoomContentPrompt(contentEntries: GeneralContent[]): string {
  if (contentEntries.length === 0) {
    return "房间内对象：（无）";
  }
  return [
    "房间内对象：",
    ...contentEntries.map(formatWorldStateRoomContentLine),
    "（其他物体只是不可互动，并非不存在）",
  ].join('\n');
}

/**
 * 格式化单个房间内物体，附带 UUID 与质量/体积/长度等详细物理信息。
 */
function formatWorldStateRoomContentLine(item: GeneralContent): string {
  // Cardboard 对象用粗略值（带"约"），真实对象用精算值
  const isCardboard = 'aprxMass' in item;
  const card = isCardboard ? (item as CardboardObjectRecord) : null;
  const real = !isCardboard ? (item as ObjectRecord) : null;

  const massStr = isCardboard
    ? `质量：约${card!.aprxMass}kg`
    : `质量：${real!.mass}kg`;
  const volumeStr = isCardboard
    ? `体积：约${card!.aprxVolume}L`
    : `体积：${real!.volume}L`;
  const lengthStr = isCardboard
    ? `长度：约${card!.aprxLength}cm`
    : `长度：${real!.length}cm`;

  // 材料与形状仅 ItemRecord 具备（FurnitureRecord 无此字段）
  const materialStr = ('material' in item && item.material)
    ? `材料：${item.material}` : '';
  const shapeStr = ('shape' in item && item.shape)
    ? `形状：${item.shape}` : '';

  // 零件信息（CardboardFurnitureRecord 和 FurnitureRecord 具备 parts）
  let partsStr = '';
  if ('parts' in item) {
    const parts = item.parts as Record<string, string | PartRecord>;
    const partEntries = Object.values(parts);
    if (partEntries.length > 0) {
      const partNames = partEntries.map((pv) => {
        if (typeof pv === "string") {
          return pv;
        }
        const content = pv.content;
        if (typeof content === "string") {
          return content;
        }
        return content?.name ?? "?";
      });
      partsStr = `零件(${partNames.length})：${partNames.join("、")}`;
    }
  }

  const physLine = `${massStr} / ${volumeStr} / ${lengthStr}`;
  const extras = [materialStr, shapeStr, partsStr].filter(Boolean);
  const extrasLine = extras.length > 0 ? '\n  ' + extras.join('；') : '';

  return `* ${item.name} [UUID: ${item.uuid}] — ${item.description}\n  ${physLine}${extrasLine}`;
}

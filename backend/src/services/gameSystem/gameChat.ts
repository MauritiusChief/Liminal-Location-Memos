import { RangedPosition } from "@/routes/apiTypes.js";
import { buildSceneFromRequest } from "../scene/sceneObject.js";
import { buildScenePrompt } from "../scene/scenePrompt.js";
import { buildGameStateManagerSystemPrompt, INITIAL_BOOK_MESSAGE_SYSTEM, OUTDOOR_VISUAL_DESCRIPTION_SYSTEM } from "./systemPrompts.js";
import { generateReplySingleMessage } from "./llm.js";
import { GameSession, getSession } from "./gameSessionStore.js";
import { GamePosition } from "@/types/game.js";

interface GameStateToolCall {
  name: string
  arguments: Record<string, string>
}

interface GameStateToolDef {
  name: string
  description: string[]
  arguments: {
    [arg: string]: {
      type: string
      optional: boolean
      description: string
    }
  }
}


//#region 游戏状态工具

const MOVE_PLAYER_TOOL: GameStateToolDef = {
  name: 'move_player',
  description: [
    '当用户明确或隐含地要求玩家移动时，综合判断玩家自身状态以及周遭的环境信息，然后使用此工具更改游戏角色的经纬度。',
    '注意：即使用户要求移动了，也需要分析是否有阻碍移动的障碍、玩家状态是否足以支持此次移动等条件。如果分析表明这次移动没法完整执行，可以将移动的目的地修改在近处。',
    '（比如如果因存在障碍而无法移动，可以将目的地设置在障碍物面前）'
  ],
  arguments: {
    bearingDegrees: { type: 'number', optional: false, description: '以正北为0度，顺时针增加。' },
    distanceMeters: { type: 'number', optional: false, description: '移动距离，单位米。' },
    reason: { type: 'string', optional: true, description: '简短说明为何这样移动。' },
  }

}


//#region 主函数

/**
 * 根据 request 生成 Scene Prompt，然后生成第一条 Book Message
 * @param request
 * @returns 整个游戏的第一条描述周遭状况的 Book Message
 */
async function initialBookMessage(request: RangedPosition): Promise<string> {

  const sceneObject = await buildSceneFromRequest(request)
  const sceenPrompt = buildScenePrompt(sceneObject)

  const generated = await generateReplySingleMessage(
    INITIAL_BOOK_MESSAGE_SYSTEM,
    sceenPrompt
  )

  return generated.reply
}

/**
 * 从某个 Book Message 里提取事实性细节供记录，以维持事实一致性
 * @param bookMessage
 * @returns
 */
async function extractOutdoorVisualDescription(bookMessage: string, pos: GamePosition, oldVisualDescription?: string): Promise<string> {
  const {lat, lon} = pos
  const sceneObject = await buildSceneFromRequest({lat, lon, radius: 300})
  const sceenPrompt = buildScenePrompt(sceneObject)

  const message = [
    'OpenStreetMap 数据摘要：',
    sceenPrompt,
    '---',
    '旧的事实性细节记录：',
    oldVisualDescription ?? "（暂无）",
    '---',
    '文本描述：',
    bookMessage
  ].join('\n')

  const response = await generateReplySingleMessage(
    OUTDOOR_VISUAL_DESCRIPTION_SYSTEM,
    message
  )
  return response.reply
}

/**
 * 从 Game Session 获取所需信息，尤其是玩家最新的消息，然后单独给一个 agent，令其返回该玩家行为将导致的游戏状态变化
 * @param session 保证 messageHistory 最新一条为 player Message 的 GameSession
 * @returns 需要改变的游戏状态，各自需要改变的值等等
 */
async function gameStateManager(session: GameSession): Promise<GameStateToolCall[]> {
  const tooDefs = [MOVE_PLAYER_TOOL].map( def => toToolPrompt(def))
  const systemPrompt = buildGameStateManagerSystemPrompt(tooDefs)

  // 获取所需信息
  const {lat, lon} = session.playerPosition
  const sceneObject = await buildSceneFromRequest({lat, lon, radius: 500})
  const sceenPrompt = buildScenePrompt(sceneObject)
  const messageHistory = session.messageHistory
  // TODO 需要用经纬度算出极坐标方位吗？
  const outdoorVisualDescriptions = Object.entries(session.outdoorVisualDescriptions)
    .filter(record => session.activeOutdoorVisualDescriptions.includes(record[0]))
    .map(record => record[1].content).join('\n')

  // 组装 message
  // TODO 目前只输入基本信息，建筑内部相关内容后续再加
  const message = [
    '玩家发送的消息：',
    `> ${messageHistory[messageHistory.length - 1]}`, // 盲目取最后一个，因此输入时 session 得保证最新一个确实是 Player Message
    '近期对话历史：', // 保留最近 3 轮 / 6 次对话，因此这里会出现 5 个 message
    messageHistory.slice(Math.max(0, messageHistory.length - 6), messageHistory.length - 2)
      .map(m => {
        const hint = m.role === 'book' ? "**游戏输出**" : "**玩家输入**"
        return `> ${hint}：${m.content}\n>`
      }).join('\n'),
    '---',
    '玩家周遭环境数据：',
    sceenPrompt,
    '---',
    '玩家周遭环境细节记录：',
    outdoorVisualDescriptions,
  ].join('\n')

  const response = await generateReplySingleMessage(
    systemPrompt,
    message
  )
  const parsedToolCall: GameStateToolCall[] = JSON.parse(response.reply)
  return parsedToolCall
}

//#region 出口函数

/**
 * 输入玩家发送的消息，经过完整的一轮处理（包括更新游戏状态等）后，最终输出 Book Message
 * @param sessionId
 * @param playerMessage
 * @returns 包含最终 Book Message 在内的整个 GameSession，或者表示失败的 undefined
 */
export async function runGameChatTurn(sessionId: string, playerMessage: string): Promise<GameSession | undefined> {
  const session = await getSession(sessionId)
  if (!session) return
  return session
}

//#region 帮助函数

/**
 * 把 GameStateToolDef 转化为可直接排入提示词的字符串
 * @param tooDef
 * @returns
 */
function toToolPrompt(tooDef: GameStateToolDef): string {
  const argsStringArray = Object.entries(tooDef.arguments).map( argEntry => {
    return [
      `\`${argEntry[0]}\``, // 参数名
      `- 类型：${argEntry[1].type}`,
      `- ${argEntry[1].optional ? '可选参数' : '必要参数'}`,
      `- 描述：${argEntry[1].description}`,
    ]
  })
  const prompt = [
    `**工具名**: \`${tooDef.name}\``,
    '介绍：',
    tooDef.description.join('\n'),
    '参数：',
    argsStringArray.join('\n')
  ].join('\n')
  return prompt
}
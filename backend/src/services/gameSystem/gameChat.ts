import { RangedPosition } from "@/routes/apiTypes.js";
import { buildSceneFromRequest } from "../scene/sceneObject.js";
import { buildScenePrompt } from "../scene/scenePrompt.js";
import { INITIAL_BOOK_MESSAGE_SYSTEM, OUTDOOR_VISUAL_DESCRIPTION_SYSTEM } from "./systemPrompts.js";
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
 * @param session
 * @returns 需要改变的游戏状态，各自需要改变的值等等
 */
async function gameStateManager(session: GameSession): Promise<GameStateToolCall[]> {
  return []
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
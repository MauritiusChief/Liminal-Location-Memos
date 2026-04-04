import { RangedPosition } from "@/routes/apiTypes.js";
import { buildSceneFromRequest } from "../scene/sceneObject.js";
import { buildScenePrompt } from "../scene/scenePrompt.js";
import { INITIAL_BOOK_MESSAGE_SYSTEM } from "./systemPrompts.js";
import { generateReplySingleMessage } from "./llm.js";


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
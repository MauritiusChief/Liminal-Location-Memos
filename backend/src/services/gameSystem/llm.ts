import { config } from "@/config.js";
import { DeepSeekChatRequest, DeepSeekChatResponse, DeepSeekMessage } from "./llmTypes.js";
import { GameMessage } from "./gameSessionStore.js";

type ResponseWithReasoning = {
  reply: string;
  reasoning?: string;
}

//#region 主函数

// TODO 添加其他模型供应商支持，比如 Openrouter

/**
 * 仅输入 system prompt 和单个 use message 的单一回合 LLM call
 * @param systemPrompt
 * @param message
 * @returns
 */
export async function generateReplySingleMessage(
  systemPrompt: string,
  message: string,
): Promise<ResponseWithReasoning> {
  const requestBody: DeepSeekChatRequest = {
    model: config.llmModel,
    messages: [
      {role: 'system', content: systemPrompt},
      {role: 'user', content: message}
    ]
  }
  const payload = await chatCompletionDeepSeek(requestBody);
  return {
    reply: payload.choices[0].message.content ?? '[错误] 模型返回空内容！',
    reasoning: payload.choices[0].message.reasoning_content
  };
}

/**
 * 专门给 generateBookMessage() 用的，生成常规回合 Book Message 的函数。
 * 构造传统 messages 数组，并把 Game State 以虚拟 tool call/return 的方式插入。
 * @param systemPrompt
 * @param gameMessages
 * @param worldState
 * @returns
 */
export async function generateReplyFullMessages(
  systemPrompt: string,
  gameMessages: GameMessage[],
  worldState: string,
): Promise<ResponseWithReasoning> {
  const messages: DeepSeekMessage[] = [{role: 'system', content: systemPrompt}]
  gameMessages.forEach( m => {
    m.role === 'book' ?
      messages.push({role: 'assistant', content: m.content}) :
      messages.push({role: 'user', content: m.content})
  })

  const syntheticToolId = 'synthetic_get_world_state'
  // 填充虚假 tool call
  messages.push({
    role: 'assistant',
    content: '',
    reasoning_content: '',
    tool_calls: [{
      id: syntheticToolId, type: "function", function: {name: "refresh_world_state", arguments: "{}"}
    }]
  })
  // 填充虚假 tool return
  messages.push({
    role: 'tool',
    tool_call_id: syntheticToolId,
    content: worldState,
  })
  const requestBody: DeepSeekChatRequest = {
    model: config.llmModel,
    messages
  }
  // 真正发送给模型
  const payload = await chatCompletionDeepSeek(requestBody);
  return {
    reply: payload.choices[0].message.content ?? '[错误] 模型返回空内容！',
    reasoning: payload.choices[0].message.reasoning_content
  };
}

//#region 帮助函数

// TODO 添加其他模型供应商支持，比如 Openrouter

/**
 * 通用的 Deepseek 沟通函数
 * @param messages
 * @returns
 */
async function chatCompletionDeepSeek(requestBody: DeepSeekChatRequest): Promise<DeepSeekChatResponse> {
  const response = await fetch(`${config.llmBaseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.llmApiKey}`,
    },
    body: JSON.stringify(requestBody),
  });

  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload?.error?.message || 'LLM request failed.');
  }

  return payload;
}
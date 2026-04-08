import { config } from "@/config.js";
import {
  DeepSeekChatRequest,
  DeepSeekChatResponse,
  DeepSeekMessage,
  NormalizedLlmResponse,
  OpenRouterChatRequest,
  OpenRouterChatResponse,
  OpenRouterMessage,
} from "./llmTypes.js";
import { GameMessage } from "./gameSessionStore.js";

type ResponseWithReasoning = {
  reply: string;
  reasoning?: string;
}

type ReplyFormat = 'text' | 'json';

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
  const payload = await chatCompletion(buildSingleMessageRequest(
    systemPrompt,
    message,
    'text',
  ));
  return extractResponseWithReasoning(payload);
}

export async function generateJsonReplySingleMessage(
  systemPrompt: string,
  message: string,
): Promise<ResponseWithReasoning> {
  const payload = await chatCompletion(buildSingleMessageRequest(
    systemPrompt,
    message,
    'json',
  ));
  return extractResponseWithReasoning(payload);
}

function buildSingleMessageRequest(
  systemPrompt: string,
  message: string,
  replyFormat: ReplyFormat,
): DeepSeekChatRequest | OpenRouterChatRequest {
  return buildReasoningRequest([
    {role: 'system', content: systemPrompt},
    {role: 'user', content: message}
  ], replyFormat);
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
  const messages: DeepSeekMessage[] | OpenRouterMessage[] = [{role: 'system', content: systemPrompt}]
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
  const requestBody = buildReasoningRequest(messages, 'text')
  // 真正发送给模型
  const payload = await chatCompletion(requestBody);
  console.log('generateReplyFullMessages() 函数中 Deepseek 返回 message：',payload.choices[0].message);

  return extractResponseWithReasoning(payload);
}

//#region 帮助函数

// TODO 添加其他模型供应商支持，比如 Openrouter

/**
 * 通用的 Deepseek 沟通函数
 * @param messages
 * @returns
 */
async function chatCompletion(requestBody: DeepSeekChatRequest | OpenRouterChatRequest): Promise<NormalizedLlmResponse> {
  if (config.llmProvider === 'deepseek') {
    const payload = await chatCompletionDeepSeek(requestBody as DeepSeekChatRequest);
    return normalizeDeepSeekResponse(payload);
  }

  const payload = await chatCompletionOpenRouter(requestBody as OpenRouterChatRequest);
  return normalizeOpenRouterResponse(payload);
}

async function chatCompletionDeepSeek(requestBody: DeepSeekChatRequest): Promise<DeepSeekChatResponse> {
  const response = await fetch(`${config.llmBaseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.llmApiKey}`,
      'X-OpenRouter-Title': 'Liminal Location Memo',
    },
    body: JSON.stringify(requestBody),
  });

  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload?.error?.message || 'LLM request failed.');
  }

  return payload;
}

async function chatCompletionOpenRouter(requestBody: OpenRouterChatRequest): Promise<OpenRouterChatResponse> {
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

function buildReasoningRequest(
  messages: DeepSeekMessage[] | OpenRouterMessage[],
  replyFormat: ReplyFormat,
): DeepSeekChatRequest | OpenRouterChatRequest {
  if (config.llmProvider === 'deepseek') {
    const requestBody: DeepSeekChatRequest = {
      model: config.llmModel,
      messages: messages as DeepSeekMessage[],
      thinking: { type: 'enabled' }
    };

    if (replyFormat === 'json') {
      requestBody.response_format = { type: 'json_object' };
    }

    return requestBody;
  }

  const requestBody: OpenRouterChatRequest = {
    model: config.llmModel,
    messages: messages as OpenRouterMessage[],
    reasoning: { enabled: true },
    include_reasoning: true
  };

  if (replyFormat === 'json') {
    requestBody.response_format = { type: 'json_object' };
  }

  return requestBody;
}

function normalizeDeepSeekResponse(payload: DeepSeekChatResponse): NormalizedLlmResponse {
  return {
    choices: payload.choices.map((choice) => ({
      message: {
        role: choice.message.role,
        content: choice.message.content,
        reasoning_content: choice.message.reasoning_content,
        tool_calls: choice.message.tool_calls,
      },
      finish_reason: choice.finish_reason,
    })),
  };
}

function normalizeOpenRouterResponse(payload: OpenRouterChatResponse): NormalizedLlmResponse {
  return {
    choices: payload.choices.map((choice) => ({
      message: {
        role: choice.message.role,
        content: choice.message.content,
        reasoning_content: choice.message.reasoning_content ?? choice.message.reasoning,
        tool_calls: choice.message.tool_calls,
      },
      finish_reason: choice.finish_reason,
    })),
  };
}

function extractResponseWithReasoning(payload: NormalizedLlmResponse): ResponseWithReasoning {
  return {
    reply: payload.choices[0]?.message.content ?? '[错误] 模型返回空内容！',
    reasoning: payload.choices[0]?.message.reasoning_content
  };
}

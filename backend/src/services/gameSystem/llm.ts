import { config } from "@/config.js";
import {
  DeepSeekChatRequest,
  DeepSeekChatResponse,
  DeepSeekMessage,
  NormalizedLlmResponse,
  NormalizedLlmStreamEvent,
  OpenRouterChatRequest,
  OpenRouterChatResponse,
  OpenRouterMessage,
} from "./llmTypes.js";
import { GameMessage } from "./gameSessionStore.js";

type PlayerGameMessage = Extract<GameMessage, { role: 'player' }>;

type ResponseWithReasoning = {
  reply: string;
  reasoning?: string;
}

type ReplyFormat = 'text' | 'json';
type ChatRequestBody = DeepSeekChatRequest | OpenRouterChatRequest;
type ChatMessage = DeepSeekMessage[] | OpenRouterMessage[];

type RawStreamChunk = {
  choices?: Array<{
    delta?: {
      content?: string;
      reasoning?: string;
      reasoning_content?: string;
    };
    finish_reason?: string | null;
  }>;
};

//#region 主函数

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

/**
 * 组装单个 request，必定是 Reasoning Request
 * @param systemPrompt
 * @param message
 * @param replyFormat
 * @returns
 */
export function buildSingleMessageRequestMessages(
  systemPrompt: string,
  message: string,
): ChatMessage {
  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: message },
  ];
}

function buildSingleMessageRequest(
  systemPrompt: string,
  message: string,
  replyFormat: ReplyFormat,
): ChatRequestBody {
  return buildReasoningRequest(
    buildSingleMessageRequestMessages(systemPrompt, message),
    replyFormat,
  );
}

/**
 * LLM DEBUG 以及未来 game turn stream 会共用这个出口。
 * 这里故意只暴露 reply / reasoning 两路文本增量，而不把 provider 原始事件暴露出去，
 * 这样 route 层与前端都只依赖项目自己的稳定接口，后续切换供应商时影响范围才会最小。
 */
export async function* streamReplySingleMessage(
  systemPrompt: string,
  message: string,
): AsyncGenerator<NormalizedLlmStreamEvent> {
  const requestBody = buildSingleMessageRequest(systemPrompt, message, 'text');
  yield* streamChatCompletion(requestBody);
}

export async function* streamReplyFullMessages(
  systemPrompt: string,
  gameMessages: GameMessage[],
  worldState: string,
): AsyncGenerator<NormalizedLlmStreamEvent> {
  const messages = buildFullMessagesRequestMessages(systemPrompt, gameMessages, worldState);
  const requestBody = buildReasoningRequest(messages, 'text');
  yield* streamChatCompletion(requestBody);
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
  const messages = buildFullMessagesRequestMessages(systemPrompt, gameMessages, worldState);
  const requestBody = buildReasoningRequest(messages, 'text');
  const payload = await chatCompletion(requestBody);

  return extractResponseWithReasoning(payload);
}

/**
 * 组装 generateReplyFullMessages() 所用的传统 messages 数组以及插入虚拟 refresh_world_state 函数的 call/return
 * @param systemPrompt
 * @param gameMessages 被用于构造的 GameMessage 列，不一定是全部 message
 * @param statePrompt
 * @returns
 */
export function buildFullMessagesRequestMessages(
  systemPrompt: string,
  gameMessages: GameMessage[],
  statePrompt: string,
): ChatMessage {
  const messages: DeepSeekMessage[] | OpenRouterMessage[] = [{ role: 'system', content: systemPrompt }];
  gameMessages.forEach((message, index) => {
    if (message.role === 'book') {
      messages.push({ role: 'assistant', content: message.content });
      return;
    }

    pushPlayerMessageWithStateChange(messages, message, index);
  });

  const syntheticToolId = 'synthetic_get_game_state';
  // 填充虚假 tool call
  messages.push({
    role: 'assistant',
    content: '',
    reasoning_content: '',
    tool_calls: [{
      id: syntheticToolId, type: "function", function: { name: "refresh_game_state", arguments: "{}" }
    }]
  });
  // 填充虚假 tool return
  messages.push({
    role: 'tool',
    tool_call_id: syntheticToolId,
    content: statePrompt,
  });

  return messages;
}

function pushPlayerMessageWithStateChange(
  messages: DeepSeekMessage[] | OpenRouterMessage[],
  message: PlayerGameMessage,
  index: number,
): void {
  messages.push({ role: 'user', content: message.content });

  if (!message.stateChange?.length) {
    return;
  }

  const syntheticToolId = `synthetic_player_state_change_${index}`;
  messages.push({
    role: 'assistant',
    content: '',
    reasoning_content: '',
    tool_calls: [{
      id: syntheticToolId, type: "function", function: { name: "apply_player_state_changes", arguments: "{}" }
    }]
  });
  messages.push({
    role: 'tool',
    tool_call_id: syntheticToolId,
    content: JSON.stringify(message.stateChange, null, 2),
  });
}

//#region Provider 分支

/**
 * 通用的沟通函数
 * @param requestBody
 * @returns
 */
async function chatCompletion(requestBody: ChatRequestBody): Promise<NormalizedLlmResponse> {
  if (config.llmProvider === 'deepseek') {
    const payload = await chatCompletionDeepSeek(requestBody as DeepSeekChatRequest);
    return normalizeDeepSeekResponse(payload);
  }

  const payload = await chatCompletionOpenRouter(requestBody as OpenRouterChatRequest);
  return normalizeOpenRouterResponse(payload);
}

/**
 * stream 版本与普通 request 共用同一个 request builder，只在这里额外打开 stream 开关。
 * 这样现有同步调用路径不需要跟着重写，未来 game turn 若改成流式，也只需要复用本层即可。
 */
async function* streamChatCompletion(requestBody: ChatRequestBody): AsyncGenerator<NormalizedLlmStreamEvent> {
  if (config.llmProvider === 'deepseek') {
    yield* streamChatCompletionDeepSeek({
      ...(requestBody as DeepSeekChatRequest),
      stream: true,
    });
    return;
  }

  yield* streamChatCompletionOpenRouter({
    ...(requestBody as OpenRouterChatRequest),
    stream: true,
  });
}

async function chatCompletionDeepSeek(requestBody: DeepSeekChatRequest): Promise<DeepSeekChatResponse> {
  const response = await fetch(`${config.llmBaseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
    method: 'POST',
    headers: buildRequestHeaders(),
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
    headers: buildRequestHeaders(),
    body: JSON.stringify(requestBody),
  });

  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload?.error?.message || 'LLM request failed.');
  }

  return payload;
}

async function* streamChatCompletionDeepSeek(requestBody: DeepSeekChatRequest): AsyncGenerator<NormalizedLlmStreamEvent> {
  const response = await fetch(`${config.llmBaseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
    method: 'POST',
    headers: buildRequestHeaders(),
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    throw new Error(await parseErrorResponse(response));
  }

  yield* streamSseResponse(response);
}

async function* streamChatCompletionOpenRouter(requestBody: OpenRouterChatRequest): AsyncGenerator<NormalizedLlmStreamEvent> {
  const response = await fetch(`${config.llmBaseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
    method: 'POST',
    headers: buildRequestHeaders(),
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    throw new Error(await parseErrorResponse(response));
  }

  yield* streamSseResponse(response);
}

//#region 共用帮助函数

function buildRequestHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.llmApiKey}`,
  };

  // DeepSeek 也接受这个标题头；统一放在这里能避免两条路径后续再出现细小分叉。
  headers['X-OpenRouter-Title'] = 'Liminal Location Memo';
  return headers;
}

async function parseErrorResponse(response: Response): Promise<string> {
  const payload = await response.json().catch(() => ({ error: { message: 'LLM request failed.' } }));
  return payload?.error?.message || 'LLM request failed.';
}

/**
 * 上游 provider 的 streaming 都是 SSE 形态，但字段名并不完全一致。
 * 我们把“读取 SSE 外壳”和“理解 provider JSON 内容”拆成两步，
 * 就能把供应商差异集中在 normalizeProviderStreamPayload() 这一层，而不是散落到 route/UI。
 */
async function* streamSseResponse(response: Response): AsyncGenerator<NormalizedLlmStreamEvent> {
  if (!response.body) {
    throw new Error('LLM stream response body is empty.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let doneEmitted = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const segments = buffer.split('\n\n');
    buffer = segments.pop() ?? '';

    for (const segment of segments) {
      const event = parseProviderStreamSegment(segment);
      if (!event) {
        continue;
      }

      if (event.done && doneEmitted) {
        continue;
      }

      if (event.done) {
        doneEmitted = true;
      }

      yield event;
    }
  }

  buffer += decoder.decode();
  const trailingEvent = parseProviderStreamSegment(buffer);
  if (trailingEvent) {
    if (trailingEvent.done && doneEmitted) {
      return;
    }

    if (trailingEvent.done) {
      doneEmitted = true;
    }
    yield trailingEvent;
  }

  if (!doneEmitted) {
    yield { done: true };
  }
}

/**
 * 解析单个 SSE segment。
 * segment 里可能有 event:/data: 多行，我们只关心 data 行，并兼容 [DONE] 这种结束标记。
 */
export function parseProviderStreamSegment(segment: string): NormalizedLlmStreamEvent | null {
  const dataLines = segment
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim());

  if (!dataLines.length) {
    return null;
  }

  const data = dataLines.join('\n');
  if (!data) {
    return null;
  }

  if (data === '[DONE]') {
    return { done: true };
  }

  const payload = JSON.parse(data) as RawStreamChunk;
  return normalizeProviderStreamPayload(payload);
}

/**
 * 这里故意只抽取 content / reasoning 两类文本。
 * 对当前 debug 页与未来 game turn 来说，这两路文本才是稳定的业务数据；
 * tool call、usage 等供应商细节以后若真要用，再额外扩展标准事件即可。
 */
export function normalizeProviderStreamPayload(payload: RawStreamChunk): NormalizedLlmStreamEvent | null {
  const choice = payload.choices?.[0];
  const replyDelta = choice?.delta?.content;
  const reasoningDelta = choice?.delta?.reasoning_content ?? choice?.delta?.reasoning;
  const done = Boolean(choice?.finish_reason);

  if (!replyDelta && !reasoningDelta && !done) {
    return null;
  }

  return {
    replyDelta,
    reasoningDelta,
    done,
  };
}

/**
 * 组装 reasoning request
 * @param messages
 * @param replyFormat 生成纯文本或者 json
 * @returns
 */
function buildReasoningRequest(
  messages: ChatMessage,
  replyFormat: ReplyFormat,
): ChatRequestBody {
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

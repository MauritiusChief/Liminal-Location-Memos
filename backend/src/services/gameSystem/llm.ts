import { config } from "@/config.js";
import {
  DeepSeekChatRequest,
  DeepSeekChatResponse,
  DeepSeekMessage,
  DeepSeekTool,
  DeepSeekToolCall,
  GeneralSource,
  NormalizedLlmResponse,
  NormalizedLlmStreamEvent,
  OpenRouterChatRequest,
  OpenRouterChatResponse,
  OpenRouterMessage,
  OpenRouterTool,
  OpenRouterToolCall,
} from "./llmTypes.js";
import { GameMessage } from "./gameSessionStore.js";
import { LlmToolDef } from "./agentStateManager.js";

type PlayerGameMessage = Extract<GameMessage, { role: 'player' }>;

type ResponseWithReasoning = {
  reply: string;
  reasoning?: string;
}

export type JsonReplyWithToolsResponse =
  | {
      type: 'tool_call';
      reply: string;
      toolCalls: DeepSeekToolCall[] | OpenRouterToolCall[];
      reasoning?: string;
    }
  | {
      type: 'final_response';
      reply: string;
      reasoning?: string;
    };

export type ReplyFormat = 'text' | 'json';
export type ChatRequestBody = DeepSeekChatRequest | OpenRouterChatRequest;
export type ChatMessage = DeepSeekMessage[] | OpenRouterMessage[];

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
 * 要求：
 * - 单个 user prompt
 * - 输出字符串
 * - 默认开启 reasoning
 * @param systemPrompt
 * @param message
 * @returns
 */
export async function generateReplySingleMessage(
  systemPrompt: string,
  message: string,
): Promise<ResponseWithReasoning> {
  const messages = buildSingleMessageRequestMessages(systemPrompt, message)
  const requestBody = buildSingleMessageRequest(messages, 'text')
  const payload = await chatCompletion(requestBody);
  return extractResponseWithReasoning(payload);
}

/**
 * 要求：
 * - 单个 user prompt
 * - 输出 JSON
 * - 可选是否开启 reasoning (是否用 chat)
 * @param systemPrompt
 * @param message
 * @param fast 是否改用 chat 来加速过程
 * @returns
 */
export async function generateJsonReplySingleMessage(
  systemPrompt: string,
  message: string,
  fast = false,
): Promise<ResponseWithReasoning> {
  const messages = buildSingleMessageRequestMessages(systemPrompt, message);
  const payload = await chatCompletion(
    fast
      ? buildChatRequest(messages, 'json')
      : buildReasoningRequest(messages, 'json'),
  );
  return extractResponseWithReasoning(payload);
}

/**
 * 要求：
 * - 单个 user prompt + 工具调用能力
 * - 循环处理工具调用，工具返回内容为 source（占位）
 * - 输出最终 JSON 答案
 * - 默认开启 reasoning
 * @param systemPrompt
 * @param message 单个用户消息
 * @param tools
 * @param source 工具返回的内容的来源
 * @returns
 */
export async function generateJsonReplyWithSource(
  systemPrompt: string,
  message: string,
  tools: LlmToolDef[],
  source: GeneralSource[],
): Promise<ResponseWithReasoning> {
  // 单消息模式初始化
  const messages = buildSingleMessageRequestMessages(systemPrompt, message);

  // 循环处理工具调用
  while (true) {
    const response = await respondReplyOrTool(messages, tools);

    if (response.type === 'final_response') {
      return {
        reply: response.reply,
        reasoning: response.reasoning,
      };
    }

    // 处理工具调用：真实记录 tool_calls
    if (response.toolCalls?.length > 0) {
      messages.push({
        role: 'assistant',
        content: response.reply,
        reasoning_content: response.reasoning,
        tool_calls: response.toolCalls,
      });

      response.toolCalls.forEach( toolCall => {
        // TODO 兼容多种 toolCall
        const toolArgs: {query: string[]} = JSON.parse(toolCall.function.arguments)
        const query = toolArgs["query"]
        const filteredSource = source.filter( s => {
          return query.every( q => s.keyword.includes(q))
        })

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(filteredSource, null, 2),
        });
      })

    }
  }
}

/**
 * 内部函数：单次 LLM 调用，可能返回工具调用或最终答案
 * @param messages
 * @param tools
 * @returns
 */
async function respondReplyOrTool(
  messages: ChatMessage,
  tools: LlmToolDef[],
): Promise<JsonReplyWithToolsResponse> {
  const requestBody = buildReasoningRequest(messages, 'json');

  if (config.llmProvider === 'deepseek') {
    const deepSeekTools: DeepSeekTool[] = tools.map(tool => ({
      type: "function",
      function: tool
    }));
    (requestBody as DeepSeekChatRequest).tools = deepSeekTools;
    (requestBody as DeepSeekChatRequest).tool_choice = 'auto';
  } else {
    const openRouterTools: OpenRouterTool[] = tools.map(tool => ({
      type: "function",
      function: tool
    }));
    (requestBody as OpenRouterChatRequest).tools = openRouterTools;
    (requestBody as OpenRouterChatRequest).tool_choice = 'auto';
  }

  const payload = await chatCompletion(requestBody);

  console.log(JSON.stringify(payload, null, 2))
  /*
  从控制台粘贴的打印结果
  {
    "choices": [
      {
        "message": {
          "role": "assistant",
          "content": "[{\"name\": \"query_template\", \"arguments\": {\"query\": [\"冰箱\"]}}]",
          "reasoning_content": "玩家想要执行的动作是：“检查冰箱是否有电”。\n当前玩家位于：level 1 - main - 套房 standard_suite_lvl1_idx7 - 房间 standard_suite_lvl1_idx7/kitchen - 厨房。\n房间内可互动物体显示：（所有物体均属于场景一部分，不可互动）。\n这意味着厨房里的冰箱目前不是可互动的对象。\n为了执行“检查冰箱是否有电”这个动作，我需要先使用 `draft_object_tool` 创建一个冰箱作为可互动对象。\n\n查询模板：\n关键词：冰箱\n调用 `query_template` with `[\"冰箱\"]`.\n\n接下来我需要用工具创建对象。\n根据初筛候选，这是一个 `surrounding_interact` 类型的行为。\n\n先调用函数查询冰箱模板。然后基于查询结果输出 JSON。\n\n函数调用：\n`query_template([\"冰箱\"])`\n\n然后等待返回结果，再决定具体的 `draft_object_tool` 参数，或者如果没有合适的模板则可能需要调整。\n\n现在先发送函数调用。"
        },
        "finish_reason": "stop"
      }
    ]
  }
   */

  const message = payload.choices[0]?.message;
  const reply = message?.content ?? '[错误] 模型返回空内容！';
  const reasoning = message?.reasoning_content;

  if (message?.tool_calls?.length) {
    return {
      type: 'tool_call',
      reply,
      reasoning,
      toolCalls: message.tool_calls,
    };
  }

  return {
    type: 'final_response',
    reply,
    reasoning,
  };
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
  messages: ChatMessage,
  replyFormat: ReplyFormat,
): ChatRequestBody {
  return buildReasoningRequest(messages, replyFormat);
}

/**
 * 要求：
 * - 单个 user prompt
 * - 流式输出字符串
 * - 默认开启 reasoning
 * @param systemPrompt
 * @param message
 */
export async function* streamReplySingleMessage(
  systemPrompt: string,
  message: string,
): AsyncGenerator<NormalizedLlmStreamEvent> {
  const messages = buildSingleMessageRequestMessages(systemPrompt, message)
  const requestBody = buildSingleMessageRequest(messages, 'text');
  yield* streamChatCompletion(requestBody);
}

/**
 * 要求：
 * - 完整的允许 tool call 的 messages 输入
 * - 流式输出字符串
 * - 默认开启 reasoning
 * @param systemPrompt
 * @param gameMessages
 * @param playerState
 */
export async function* streamReplyFullMessages(
  systemPrompt: string,
  gameMessages: GameMessage[],
  playerState: string,
): AsyncGenerator<NormalizedLlmStreamEvent> {
  const messages = buildFullMessagesRequestMessages(systemPrompt, gameMessages, playerState);
  const requestBody = buildReasoningRequest(messages, 'text');
  yield* streamChatCompletion(requestBody);
}

/**
 * 组装 streamReplyFullMessages() 所用的传统 messages 数组以及插入虚拟 refresh_world_state 函数的 call/return
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

  const syntheticToolId = 'synthetic_get_world_state';
  // 填充虚假 tool call
  messages.push({
    role: 'assistant',
    content: '',
    reasoning_content: '',
    tool_calls: [{
      id: syntheticToolId, type: "function", function: { name: "refresh_world_state", arguments: "{}" }
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
  // // MOCK
  // message.stateChange = [{name: "move_player", arguments: {bearingDegrees: 3, distanceMeters: 5}}]

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

/**
 * 组装 chat request
 * @param messages
 * @param replyFormat 生成纯文本或者 json
 * @returns
 */
function buildChatRequest(
  messages: ChatMessage,
  replyFormat: ReplyFormat,
): ChatRequestBody {
  if (config.llmProvider === 'deepseek') {
    const requestBody: DeepSeekChatRequest = {
      model: config.llmModel,
      messages: messages as DeepSeekMessage[],
      thinking: { type: 'disabled' },
    };

    if (replyFormat === 'json') {
      requestBody.response_format = { type: 'json_object' };
    }

    return requestBody;
  }

  const requestBody: OpenRouterChatRequest = {
    model: config.llmModel,
    messages: messages as OpenRouterMessage[],
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

import { config } from '../config.js';

interface ChatCompletionContentPart {
  type?: string;
  text?: string;
  reasoning?: string;
  reasoning_text?: string;
  content?: string;
}

interface ChatCompletionToolCall {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface ChatCompletionMessage {
  content?: string | ChatCompletionContentPart[];
  reasoning?: string | ChatCompletionContentPart[];
  reasoning_content?: string | ChatCompletionContentPart[];
  tool_calls?: ChatCompletionToolCall[];
}

interface ChatCompletionChoice {
  message?: ChatCompletionMessage;
}

interface ChatCompletionResponse {
  choices?: ChatCompletionChoice[];
  error?: {
    message?: string;
  };
}

export interface LlmDebugResponse {
  reply: string;
  reasoning: string | null;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolCallResult {
  id: string;
  name: string;
  argumentsText: string;
}

export interface ToolEnabledChatResponse extends LlmDebugResponse {
  toolCall: ToolCallResult | null;
  assistantMessageForHistory: AssistantHistoryMessage;
}

export type AssistantHistoryMessage =
  | { role: 'assistant'; content: string; reasoningContent?: string; isToolCallMessage?: false }
  | {
      role: 'assistant';
      content: string;
      reasoningContent?: string;
      isToolCallMessage: true;
      toolCallId: string;
      toolName: string;
      toolArgumentsText: string;
    };

export type ChatRequestMessage =
  | { role: 'system' | 'user'; content: string }
  | {
      role: 'assistant';
      content: string;
      reasoning_content?: string;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: {
          name: string;
          arguments: string;
        };
      }>;
    }
  | { role: 'tool'; content: string; tool_call_id: string };

export async function generateReplyWithSystemPrompt(systemPrompt: string, message: string): Promise<LlmDebugResponse> {
  const messages: ChatRequestMessage[] = [];

  if (systemPrompt.trim()) {
    messages.push({
      role: 'system',
      content: systemPrompt.trim(),
    });
  }

  messages.push({
    role: 'user',
    content: message,
  });

  const payload = await requestChatCompletion({ messages });
  return extractLlmDebugResponse(payload?.choices?.[0]?.message);
}

export async function runChatCompletionWithTools(input: {
  messages: ChatRequestMessage[];
  tools: ToolDefinition[];
}): Promise<ToolEnabledChatResponse> {
  const payload = await requestChatCompletion({
    messages: input.messages,
    tools: input.tools,
  });
  const message = payload?.choices?.[0]?.message;

  return {
    ...extractLlmDebugResponse(message),
    toolCall: extractToolCall(message),
    assistantMessageForHistory: extractAssistantMessageForHistory(message),
  };
}

async function requestChatCompletion(input: {
  messages: ChatRequestMessage[];
  tools?: ToolDefinition[];
}): Promise<ChatCompletionResponse | null> {
  const response = await fetch(`${config.llmBaseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.llmApiKey}`,
    },
    body: JSON.stringify({
      model: config.llmModel,
      messages: input.messages,
      tools: input.tools,
    }),
  });

  const payload = (await response.json().catch(() => null)) as ChatCompletionResponse | null;

  if (!response.ok) {
    throw new Error(payload?.error?.message || 'LLM request failed.');
  }

  return payload;
}

function extractLlmDebugResponse(message: ChatCompletionMessage | undefined): LlmDebugResponse {
  const reasoning = extractReasoningText(message);
  const reply = extractReplyText(message);

  return {
    reply,
    reasoning,
  };
}

function extractReplyText(message: ChatCompletionMessage | undefined): string {
  const content = message?.content;

  if (typeof content === 'string') {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .filter((part) => !isReasoningContentType(part.type))
    .map((part) => extractTextFromContentPart(part))
    .filter((text) => text.length > 0)
    .join('')
    .trim();
}

function extractToolCall(message: ChatCompletionMessage | undefined): ToolCallResult | null {
  const toolCall = message?.tool_calls?.find((item) => item.type === 'function' && item.function?.name);

  if (!toolCall?.function?.name) {
    return null;
  }

  return {
    id: toolCall.id || toolCall.function.name,
    name: toolCall.function.name,
    argumentsText: toolCall.function.arguments || '{}',
  };
}

function extractAssistantMessageForHistory(message: ChatCompletionMessage | undefined): AssistantHistoryMessage {
  const toolCall = extractToolCall(message);
  const content = extractReplyText(message);
  const reasoningContent = extractReasoningContent(message) || undefined;

  if (!toolCall) {
    return {
      role: 'assistant',
      content,
      reasoningContent,
    };
  }

  return {
    role: 'assistant',
    content,
    reasoningContent,
    isToolCallMessage: true,
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    toolArgumentsText: toolCall.argumentsText,
  };
}

function extractReasoningText(message: ChatCompletionMessage | undefined): string | null {
  const explicitReasoning = collectTextFromUnknownContent(message?.reasoning)
    || collectTextFromUnknownContent(message?.reasoning_content);

  if (explicitReasoning) {
    return explicitReasoning;
  }

  if (!Array.isArray(message?.content)) {
    return null;
  }

  const reasoningText = message.content
    .filter((part) => isReasoningContentType(part.type))
    .map((part) => extractTextFromContentPart(part))
    .filter((text) => text.length > 0)
    .join('\n\n')
    .trim();

  return reasoningText || null;
}

function extractReasoningContent(message: ChatCompletionMessage | undefined): string | null {
  return collectTextFromUnknownContent(message?.reasoning_content)
    || collectTextFromUnknownContent(message?.reasoning)
    || null;
}

function collectTextFromUnknownContent(content: string | ChatCompletionContentPart[] | undefined): string | null {
  if (typeof content === 'string') {
    return content.trim() || null;
  }

  if (!Array.isArray(content)) {
    return null;
  }

  const text = content
    .map((part) => extractTextFromContentPart(part))
    .filter((item) => item.length > 0)
    .join('\n\n')
    .trim();

  return text || null;
}

function extractTextFromContentPart(part: ChatCompletionContentPart): string {
  return (part.text || part.reasoning || part.reasoning_text || part.content || '').trim();
}

function isReasoningContentType(type: string | undefined): boolean {
  const normalizedType = (type || '').trim().toLowerCase();
  return normalizedType === 'reasoning'
    || normalizedType === 'reasoning_text'
    || normalizedType === 'thinking';
}

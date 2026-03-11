import { config } from '../config.js';

interface ChatCompletionContentPart {
  type?: string;
  text?: string;
  reasoning?: string;
  reasoning_text?: string;
  content?: string;
}

interface ChatCompletionMessage {
  content?: string | ChatCompletionContentPart[];
  reasoning?: string | ChatCompletionContentPart[];
  reasoning_content?: string | ChatCompletionContentPart[];
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

export async function generateReply(message: string): Promise<LlmDebugResponse> {
  return generateReplyWithSystemPrompt('', message);
}

export async function generateReplyWithSystemPrompt(systemPrompt: string, message: string): Promise<LlmDebugResponse> {
  const messages: Array<{ role: 'system' | 'user'; content: string }> = [];

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

  const response = await fetch(`${config.llmBaseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.llmApiKey}`,
    },
    body: JSON.stringify({
      model: config.llmModel,
      messages,
    }),
  });

  const payload = (await response.json().catch(() => null)) as ChatCompletionResponse | null;

  if (!response.ok) {
    throw new Error(payload?.error?.message || 'LLM request failed.');
  }

  return extractLlmDebugResponse(payload?.choices?.[0]?.message);
}

function extractLlmDebugResponse(message: ChatCompletionMessage | undefined): LlmDebugResponse {
  const reasoning = extractReasoningText(message);
  const reply = extractReplyText(message);

  if (!reply) {
    throw new Error('LLM response did not include a reply.');
  }

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

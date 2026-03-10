import { config } from '../config.js';

interface ChatCompletionChoice {
  message?: {
    content?: string | Array<{ type: string; text?: string }>;
  };
}

interface ChatCompletionResponse {
  choices?: ChatCompletionChoice[];
  error?: {
    message?: string;
  };
}

export async function generateReply(message: string): Promise<string> {
  return generateReplyWithSystemPrompt('', message);
}

export async function generateReplyWithSystemPrompt(systemPrompt: string, message: string): Promise<string> {
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

  const content = payload?.choices?.[0]?.message?.content;

  if (typeof content === 'string' && content.trim()) {
    return content;
  }

  if (Array.isArray(content)) {
    const text = content
      .map((item) => item.text || '')
      .join('')
      .trim();

    if (text) {
      return text;
    }
  }

  throw new Error('LLM response did not include a reply.');
}

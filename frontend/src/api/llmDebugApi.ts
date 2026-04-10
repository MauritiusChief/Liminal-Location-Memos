import { streamNdjson } from './http';

export interface DebugLlmRequest {
  systemPrompt: string;
  message: string;
}

export type DebugLlmStreamEvent =
  | {
      type: 'reply_delta';
      text: string;
    }
  | {
      type: 'reasoning_delta';
      text: string;
    }
  | {
      type: 'done';
    }
  | {
      type: 'error';
      message: string;
    };

/**
 * 浏览器端不能继续复用 postJson，因为 postJson 会等到整段响应结束后才 resolve。
 * 这里改成直接消费 NDJSON stream，让页面能边收到边渲染 reply / reasoning。
 */
export async function streamDebugLlm(
  input: DebugLlmRequest,
  onEvent: (event: DebugLlmStreamEvent) => void,
): Promise<void> {
  await streamNdjson<DebugLlmStreamEvent>('/api/debug/llm', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  }, onEvent);
}

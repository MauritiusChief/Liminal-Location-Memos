export interface HealthResponse {
  ok: boolean;
  service: string;
}

export interface ChatResponse {
  reply: string;
}

interface ErrorResponse {
  error: string;
}

/**
 * fetch 后端的状态
 * @returns
 */
export async function fetchHealth(): Promise<HealthResponse> {
  const response = await fetch('/api/health');

  if (!response.ok) {
    throw new Error('Failed to fetch backend health.');
  }

  return response.json() as Promise<HealthResponse>;
}

/**
 * post 一个消息
 * @param message
 * @returns
 */
export async function postChatMessage(message: string): Promise<ChatResponse> {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message }),
  });

  if (!response.ok) {
    const errorPayload = (await response.json().catch(() => ({ error: 'Request failed.' }))) as ErrorResponse;
    throw new Error(errorPayload.error || 'Request failed.');
  }

  return response.json() as Promise<ChatResponse>;
}


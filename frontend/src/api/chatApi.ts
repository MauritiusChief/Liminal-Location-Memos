import { postJson } from './http';

export interface ChatResponse {
  reply: string;
}

export function submitChat(input: { message: string }): Promise<ChatResponse> {
  return postJson<ChatResponse, { message: string }>('/api/chat', input);
}

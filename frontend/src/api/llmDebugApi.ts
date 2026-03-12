import { postJson } from './http';

export interface DebugLlmResponse {
  reply: string;
  reasoning: string | null;
}

export interface DebugLlmRequest {
  systemPrompt: string;
  message: string;
}

export function submitDebugLlm(input: DebugLlmRequest): Promise<DebugLlmResponse> {
  return postJson<DebugLlmResponse, DebugLlmRequest>('/api/debug/llm', input);
}

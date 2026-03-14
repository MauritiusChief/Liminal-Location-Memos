import { postJson } from './http';
import type { GameChatRequest, GameChatResponse, GameSessionSnapshotResponse } from './sceneTypes';

export function submitGameChat(input: GameChatRequest): Promise<GameChatResponse> {
  // 首页正式会话只走这个接口，不再走旧的 /api/chat 占位接口。
  return postJson<GameChatResponse, GameChatRequest>('/api/game/chat', input);
}

export async function fetchGameSessionSnapshot(sessionId: string): Promise<GameSessionSnapshotResponse> {
  const response = await fetch(`/api/game/session/${encodeURIComponent(sessionId)}`);

  if (!response.ok) {
    const errorPayload = (await response.json().catch(() => ({ error: 'Request failed.' }))) as { error?: string };
    throw new Error(errorPayload.error || 'Request failed.');
  }

  return response.json() as Promise<GameSessionSnapshotResponse>;
}

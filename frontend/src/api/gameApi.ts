import { postJson } from './http';
import type { GameChatRequest, GameChatResponse } from './sceneTypes';

export function submitGameChat(input: GameChatRequest): Promise<GameChatResponse> {
  // 首页正式会话只走这个接口，不再走旧的 /api/chat 占位接口。
  return postJson<GameChatResponse, GameChatRequest>('/api/game/chat', input);
}

import { getJson, postJson } from './http';
import type { GameSession, GameTurnRequest } from './gameTypes';

export function startGame(): Promise<GameSession> {
  return postJson<GameSession, Record<string, never>>('/api/game/start', {});
}

export function submitGameTurn(input: GameTurnRequest): Promise<GameSession> {
  return postJson<GameSession, GameTurnRequest>('/api/game/turn', input);
}

export function fetchGameSession(sessionId: string): Promise<GameSession> {
  return getJson<GameSession>(`/api/game/session/${encodeURIComponent(sessionId)}`);
}

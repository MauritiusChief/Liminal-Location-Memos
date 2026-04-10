import { getJson, streamNdjson } from './http';
import type { GameSessionSnapshot, GameStreamEvent, GameTurnRequest } from './gameTypes';

export async function streamGameStart(
  onEvent: (event: GameStreamEvent) => void,
): Promise<void> {
  await streamNdjson<GameStreamEvent>('/api/game/start', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
  }, onEvent);
}

export async function streamGameTurn(
  input: GameTurnRequest,
  onEvent: (event: GameStreamEvent) => void,
): Promise<void> {
  await streamNdjson<GameStreamEvent>('/api/game/turn', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  }, onEvent);
}

export function fetchGameSession(sessionId: string): Promise<GameSessionSnapshot> {
  return getJson<GameSessionSnapshot>(`/api/game/session/${encodeURIComponent(sessionId)}`);
}

import type { GameMessage, MovePlayerToolResult } from '../../api/sceneTypes';

export function shouldDisplayGameMessage(message: GameMessage): boolean {
  return message.role === 'user'
    || message.role === 'assistant'
    || (message.role === 'tool' && (message.toolName === 'move_player' || message.toolName === 'look_far'));
}

export function parseMovePlayerToolMessage(message: GameMessage): MovePlayerToolResult | null {
  if (message.role !== 'tool' || message.toolName !== 'move_player') {
    return null;
  }

  try {
    const parsed = JSON.parse(message.content) as Partial<MovePlayerToolResult>;

    if (!Number.isFinite(parsed.bearingDegrees) || !Number.isFinite(parsed.distanceMeters)) {
      return null;
    }

    return parsed as MovePlayerToolResult;
  } catch {
    return null;
  }
}

export function findLatestMovementFromMessages(messages: GameMessage[]): MovePlayerToolResult | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const movement = parseMovePlayerToolMessage(messages[index]!);
    if (movement) {
      return movement;
    }
  }

  return null;
}

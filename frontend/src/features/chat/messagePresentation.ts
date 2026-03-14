import type { GameMessage, MovePlayerToolResult } from '../../api/sceneTypes';

export function shouldDisplayGameMessage(message: GameMessage): boolean {
  if (message.role === 'user' && message.isOpeningPrompt) {
    return false;
  }

  if (message.role === 'assistant' && message.isToolCallMessage) {
    return false;
  }

  return message.role === 'user' || message.role === 'assistant' || (message.role === 'tool' && message.toolName === 'move_player');
}

export function parseMovePlayerToolMessage(message: GameMessage): MovePlayerToolResult | null {
  if (message.role !== 'tool' || message.toolName !== 'move_player') {
    return null;
  }

  try {
    const parsed = JSON.parse(message.content) as { movementResult?: unknown };
    if (!parsed.movementResult || typeof parsed.movementResult !== 'object') {
      return null;
    }

    const movementResult = parsed.movementResult as Partial<MovePlayerToolResult>;
    if (
      !movementResult.previousPosition
      || !movementResult.nextPosition
      || !Number.isFinite(movementResult.bearingDegrees)
      || !Number.isFinite(movementResult.distanceMeters)
    ) {
      return null;
    }

    return movementResult as MovePlayerToolResult;
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

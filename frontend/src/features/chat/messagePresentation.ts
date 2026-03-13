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

export function formatMovePlayerToolMessage(movement: MovePlayerToolResult): string {
  const bearingLabel = formatBearing(movement.bearingDegrees);
  const distanceText = `${Math.round(movement.distanceMeters)} 米`;
  const targetText = movement.targetLabel ? `，朝着 ${movement.targetLabel} 的方向` : '';

  return `你${targetText}向${bearingLabel}移动了约 ${distanceText}。`;
}

function formatBearing(bearingDegrees: number): string {
  const normalized = ((bearingDegrees % 360) + 360) % 360;
  if (normalized >= 337.5 || normalized < 22.5) {
    return '北';
  }
  if (normalized < 67.5) {
    return '东北';
  }
  if (normalized < 112.5) {
    return '东';
  }
  if (normalized < 157.5) {
    return '东南';
  }
  if (normalized < 202.5) {
    return '南';
  }
  if (normalized < 247.5) {
    return '西南';
  }
  if (normalized < 292.5) {
    return '西';
  }

  return '西北';
}

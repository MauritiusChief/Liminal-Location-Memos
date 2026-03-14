import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import type { ChatRequestMessage } from './llm.js';

const DEBUG_DIRECTORY = path.resolve(process.cwd(), 'data', 'game-chat-debug');
export type SceneSnapshotType = 'scene-large' | 'scene-small';

export async function writeGameChatMessageSnapshot(input: {
  direction: 'from-llm' | 'to-llm';
  sessionId: string;
  message?: string;
  messages: ChatRequestMessage[];
}): Promise<void> {
  if (!config.gameChatDebugLogEnabled) {
    return;
  }

  await mkdir(DEBUG_DIRECTORY, { recursive: true });
  const timestamp = buildTimestampForFilename(new Date());
  const filePath = path.join(DEBUG_DIRECTORY, `${timestamp}_${input.direction}.json`);
  const payload = {
    timestamp,
    direction: input.direction,
    sessionId: input.sessionId,
    message: input.message,
    messages: input.messages,
  };

  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

export async function writeSceneDescriptionSnapshot(input: {
  type: SceneSnapshotType;
  messages: ChatRequestMessage[];
  content: string;
  reasoning: string | null;
}): Promise<void> {
  if (!config.gameChatDebugLogEnabled) {
    return;
  }

  await mkdir(DEBUG_DIRECTORY, { recursive: true });
  const timestamp = buildTimestampForFilename(new Date());
  const filePath = path.join(DEBUG_DIRECTORY, `${timestamp}_${input.type}.json`);
  const payload = {
    timestamp,
    type: input.type,
    messages: input.messages,
    response: {
      content: input.content,
      reasoning: input.reasoning,
    },
  };

  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function buildTimestampForFilename(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  const milliseconds = String(date.getMilliseconds()).padStart(3, '0');
  return `${year}${month}${day}T${hours}${minutes}${seconds}${milliseconds}`;
}

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import type { ChatRequestMessage } from './llm.js';

const DEBUG_DIRECTORY = path.resolve(process.cwd(), 'data', 'game-chat-debug');
export type SceneSnapshotType = 'scene-large' | 'scene-small';

interface SnapshotGroup {
  timestamp: string;
  baseName: string;
}

interface DerivedSnapshotFile {
  suffix: string;
  extension: 'json' | 'md';
  content: string;
}

export async function writeGameChatMessageSnapshot(input: {
  direction: 'from-llm' | 'to-llm' | 'llm-use-tool';
  sessionId: string;
  message?: string;
  messages: ChatRequestMessage[];
}): Promise<void> {
  if (!config.gameChatDebugLogEnabled) {
    return;
  }

  const group = await createSnapshotGroup(input.direction);
  const payload = {
    timestamp: group.timestamp,
    direction: input.direction,
    sessionId: input.sessionId,
    message: input.message,
    messages: input.messages,
  };

  await writeSnapshotJson(group, '', payload);
  await writeDerivedSnapshots(group, collectGameChatDerivedFiles(input.messages));
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

  const group = await createSnapshotGroup(input.type);
  const payload = {
    timestamp: group.timestamp,
    type: input.type,
    messages: input.messages,
    response: {
      content: input.content,
      reasoning: input.reasoning,
    },
  };

  await writeSnapshotJson(group, '', payload);
  await writeDerivedSnapshots(group, collectSceneDescriptionDerivedFiles(input));
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

async function createSnapshotGroup(label: string): Promise<SnapshotGroup> {
  await mkdir(DEBUG_DIRECTORY, { recursive: true });
  const timestamp = buildTimestampForFilename(new Date());

  return {
    timestamp,
    baseName: `${timestamp}_${label}`,
  };
}

async function writeSnapshotJson(group: SnapshotGroup, suffix: string, payload: unknown): Promise<void> {
  const filePath = path.join(DEBUG_DIRECTORY, `${group.baseName}${suffix}.json`);
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function writeDerivedSnapshots(group: SnapshotGroup, files: DerivedSnapshotFile[]): Promise<void> {
  for (const file of files) {
    const filePath = path.join(DEBUG_DIRECTORY, `${group.baseName}_${file.suffix}.${file.extension}`);
    const normalizedContent = file.extension === 'json'
      ? `${file.content.trimEnd()}\n`
      : normalizeMarkdownFileContent(file.content);
    await writeFile(filePath, normalizedContent, 'utf8');
  }
}

function normalizeMarkdownFileContent(content: string): string {
  return `${content.replace(/\r\n/g, '\n').trimEnd()}\n`;
}

function collectGameChatDerivedFiles(messages: ChatRequestMessage[]): DerivedSnapshotFile[] {
  const files: DerivedSnapshotFile[] = [];

  for (const message of messages) {
    if (message.role === 'assistant') {
      const toolCalls = message.tool_calls || [];

      for (const toolCall of toolCalls) {
        if (toolCall.function.name !== 'move_player') {
          continue;
        }

        const parsedArguments = tryParseJsonObject(toolCall.function.arguments);
        if (!parsedArguments) {
          continue;
        }

        files.push(buildJsonDerivedFile('move-player_arguments', parsedArguments));
      }

      continue;
    }

    if (message.role !== 'tool') {
      continue;
    }

    const parsedContent = tryParseJsonObject(message.content);
    if (!parsedContent) {
      continue;
    }

    if (isSceneContextSnapshotPayload(parsedContent)) {
      files.push(buildJsonDerivedFile('scene-context_snapshot', parsedContent));
      files.push(buildMarkdownDerivedFile('scene-context_activeSummary', parsedContent.activeSummary));
      continue;
    }

    if (isMovePlayerToolResult(parsedContent)) {
      files.push(buildJsonDerivedFile('move-player_result', parsedContent));
    }
  }

  return dedupeDerivedFiles(files);
}

function collectSceneDescriptionDerivedFiles(input: {
  type: SceneSnapshotType;
  messages: ChatRequestMessage[];
  content: string;
}): DerivedSnapshotFile[] {
  const files: DerivedSnapshotFile[] = [];
  const promptMessage = input.messages.find((message) => message.role === 'user');

  if (promptMessage?.content.trim()) {
    files.push(buildMarkdownDerivedFile('prompt', promptMessage.content));
  }

  if (input.type === 'scene-small') {
    const parsedResponse = tryParseJsonObject(input.content);
    if (parsedResponse) {
      files.push(buildJsonDerivedFile('response', parsedResponse));
    }
  }

  return files;
}

function buildJsonDerivedFile(suffix: string, payload: unknown): DerivedSnapshotFile {
  return {
    suffix,
    extension: 'json',
    content: JSON.stringify(payload, null, 2),
  };
}

function buildMarkdownDerivedFile(suffix: string, content: string): DerivedSnapshotFile {
  return {
    suffix,
    extension: 'md',
    content,
  };
}

function dedupeDerivedFiles(files: DerivedSnapshotFile[]): DerivedSnapshotFile[] {
  const deduped = new Map<string, DerivedSnapshotFile>();

  for (const file of files) {
    deduped.set(`${file.suffix}.${file.extension}`, file);
  }

  return Array.from(deduped.values());
}

function tryParseJsonObject(input: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(input) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }

    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isSceneContextSnapshotPayload(value: Record<string, unknown>): value is Record<string, unknown> & { activeSummary: string } {
  return value.type === 'scene_context_snapshot'
    && typeof value.activeSummary === 'string';
}

function isMovePlayerToolResult(value: Record<string, unknown>): boolean {
  return typeof value.bearingDegrees === 'number'
    && typeof value.distanceMeters === 'number'
    && isGamePositionLike(value.previousPosition)
    && isGamePositionLike(value.nextPosition);
}

function isGamePositionLike(value: unknown): value is { lat: number; lon: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return typeof candidate.lat === 'number' && typeof candidate.lon === 'number';
}

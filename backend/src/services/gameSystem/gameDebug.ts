import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { buildFullMessagesRequestMessages, buildSingleMessageRequestMessages } from './llm.js';
import type { LlmProviderMessage } from './llmTypes.js';
import type { GameMessage } from './gameSessionStore.js';

type DebugReply = string | object;

type DebugArtifact = {
  suffix: 'system' | 'user-message' | 'full-messages' | 'text-response' | 'json-response' | 'reasoning' | 'error';
  extension: 'md' | 'json';
  content: string;
};

type WriteGameDebugRequestParams =
  | {
      mode: 'user-message';
      functionName: string;
      systemPrompt: string;
      userMessage: string;
    }
  | {
      mode: 'full-messages';
      functionName: string;
      systemPrompt: string;
      gameMessages: GameMessage[];
      statePrompt: string;
    };

type WriteGameDebugResultParams =
  | {
      functionName: string;
      reply: DebugReply;
      reasoning?: string;
    }
  | {
      functionName: string;
      error: unknown;
    };

const DEBUG_DIRECTORY = resolveDebugDirectory();

export async function writeGameDebugRequest(params: WriteGameDebugRequestParams): Promise<void> {
  try {
    await writeArtifacts(params.functionName, buildGameDebugRequestArtifacts(params));
  } catch (error) {
    console.error(`[${new Date().toISOString()}] 写入 game debug request 文件失败`, error);
  }
}

export async function writeGameDebugResult(params: WriteGameDebugResultParams): Promise<void> {
  try {
    await writeArtifacts(params.functionName, buildGameDebugResultArtifacts(params));
  } catch (error) {
    console.error(`[${new Date().toISOString()}] 写入 game debug result 文件失败`, error);
  }
}

export function buildGameDebugRequestArtifacts(params: WriteGameDebugRequestParams): DebugArtifact[] {
  const artifacts: DebugArtifact[] = [{
    suffix: 'system',
    extension: 'md',
    content: toMarkdownText(params.systemPrompt),
  }];

  if (params.mode === 'user-message') {
    const requestMessages = buildSingleMessageRequestMessages(params.systemPrompt, params.userMessage);
    artifacts.push({
      suffix: 'user-message',
      extension: 'md',
      content: toMarkdownText(requestMessages[1]?.content ?? ''),
    });
    return artifacts;
  }

  const requestMessages = buildFullMessagesRequestMessages(
    params.systemPrompt,
    params.gameMessages,
    params.statePrompt,
  );

  artifacts.push({
    suffix: 'full-messages',
    extension: 'md',
    content: formatFullMessagesDebugSnapshot(requestMessages.slice(1), params.statePrompt),
  });

  return artifacts;
}

export function buildGameDebugResultArtifacts(params: WriteGameDebugResultParams): DebugArtifact[] {
  if ('error' in params) {
    return [{
      suffix: 'error',
      extension: 'md',
      content: formatError(params.error),
    }];
  }

  const artifacts: DebugArtifact[] = [];
  if (typeof params.reply === 'string') {
    artifacts.push({
      suffix: 'text-response',
      extension: 'md',
      content: toMarkdownText(params.reply),
    });
  } else {
    artifacts.push({
      suffix: 'json-response',
      extension: 'json',
      content: JSON.stringify(params.reply, null, 2),
    });
  }

  if (params.reasoning) {
    artifacts.push({
      suffix: 'reasoning',
      extension: 'md',
      content: toMarkdownText(params.reasoning),
    });
  }

  return artifacts;
}

async function writeArtifacts(functionName: string, artifacts: DebugArtifact[]): Promise<void> {
  await mkdir(DEBUG_DIRECTORY, { recursive: true });

  const timestamp = new Date().toISOString().replaceAll(':', '-').replace('.', '-');
  await Promise.all(artifacts.map((artifact) => {
    const filename = `${timestamp}_${functionName}_${artifact.suffix}.${artifact.extension}`;
    const filePath = path.join(DEBUG_DIRECTORY, filename);
    return writeFile(filePath, ensureTrailingNewline(artifact.content), 'utf8');
  }));
}

function formatFullMessagesDebugSnapshot(messages: LlmProviderMessage[], worldStatePrompt: string): string {
  if (messages.length === 0) {
    return '（暂无）';
  }

  return messages
    .map((message, index) => formatDebugMessageSection(index, message, worldStatePrompt))
    .join('\n\n');
}

function formatDebugMessageSection(
  index: number,
  message: LlmProviderMessage,
  worldStatePrompt: string,
): string {
  const title = `## ${index + 1}. ${message.role}`;

  if (message.role === 'tool' && message.tool_call_id === "synthetic_get_game_state") {
    const maskedToolMessage = {
      ...message,
      content: '【synthetic_get_game_state 内容因可读性原因迁移到下方】',
    };

    return [
      title,
      '',
      toCodeFence('json', JSON.stringify(maskedToolMessage, null, 2)),
      '',
      toCodeFence('md', worldStatePrompt),
    ].join('\n');
  }

  if (message.tool_calls?.length) {
    return [
      title,
      '',
      toCodeFence('json', JSON.stringify(message, null, 2)),
    ].join('\n');
  }

  return [
    title,
    '',
    toCodeFence('md', message.content ?? ''),
  ].join('\n');
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return [
      `Error: ${error.message || '（空）'}`,
      error.stack ? '' : null,
      error.stack ?? null,
    ].filter((line): line is string => line !== null).join('\n');
  }

  if (typeof error === 'string') {
    return `Error: ${error}`;
  }

  return `Error: ${JSON.stringify(error, null, 2)}`;
}

function toMarkdownText(content: string): string {
  const trimmedContent = content.trim();
  if (!trimmedContent) {
    return '（模型返回了空内容）';
  }

  return trimmedContent
    .split('\n')
    .map((line) => (line.startsWith('#') ? `#${line}` : line))
    .join('\n');
}

function toCodeFence(language: string, content: string): string {
  const normalizedContent = content || '（空）';
  const maxBackticks = Math.max(...Array.from(normalizedContent.matchAll(/`+/g), (match) => match[0].length), 0);
  const fence = '`'.repeat(Math.max(3, maxBackticks + 1));

  return `${fence}${language}\n${normalizedContent}\n${fence}`;
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith('\n') ? content : `${content}\n`;
}

function resolveDebugDirectory(): string {
  const currentWorkingDirectory = process.cwd();
  return path.basename(currentWorkingDirectory) === 'backend'
    ? path.resolve(currentWorkingDirectory, 'data/game-debug')
    : path.resolve(currentWorkingDirectory, 'backend/data/game-debug');
}

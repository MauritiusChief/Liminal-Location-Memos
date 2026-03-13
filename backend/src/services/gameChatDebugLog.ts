import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import type { ChatRequestMessage } from './llm.js';

type GameChatDebugEvent =
  | {
      type: 'chat_completion_request';
      timestamp: string;
      sessionId: string;
      turnId: string;
      stage: string;
      model: string;
      summary: ReturnType<typeof buildMessageDebugSummary>;
      raw: {
        messages: ChatRequestMessage[];
        tools?: unknown;
      };
    }
  | {
      type: 'chat_completion_response';
      timestamp: string;
      sessionId: string;
      turnId: string;
      stage: string;
      model: string;
      summary: {
        hasToolCall: boolean;
        hasReasoningContent: boolean;
        replyLength: number;
      };
      raw: unknown;
    }
  | {
      type: 'game_turn_summary';
      timestamp: string;
      sessionId: string;
      turnId: string;
      stage: string;
      summary: Record<string, unknown>;
    };

const DEBUG_DIRECTORY = path.resolve(process.cwd(), 'data', 'game-chat-debug');

export async function appendGameChatDebugLog(event: GameChatDebugEvent): Promise<void> {
  if (!config.gameChatDebugLogEnabled) {
    return;
  }

  await mkdir(DEBUG_DIRECTORY, { recursive: true });
  const line = `${JSON.stringify(event)}\n`;
  await writeFile(path.join(DEBUG_DIRECTORY, `${event.sessionId}.jsonl`), line, {
    encoding: 'utf8',
    flag: 'a',
  });
}

export function logGameChatDebugSummary(label: string, payload: unknown): void {
  if (!config.gameChatDebugLogEnabled) {
    return;
  }

  console.log(label, payload);
}

export function buildMessageDebugSummary(messages: ChatRequestMessage[]) {
  return messages.map((message, index) => ({
    index,
    role: message.role,
    hasToolCalls: message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0,
    hasReasoningContent: message.role === 'assistant' && typeof message.reasoning_content === 'string' && message.reasoning_content.length > 0,
    toolCallIds: message.role === 'assistant'
      ? message.tool_calls?.map((toolCall) => toolCall.id) || []
      : [],
    toolCallId: message.role === 'tool' ? message.tool_call_id : undefined,
    contentPreview: typeof message.content === 'string' ? message.content.slice(0, 120) : '',
  }));
}

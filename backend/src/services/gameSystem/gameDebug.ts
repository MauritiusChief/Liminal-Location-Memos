import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { GameMessage } from './gameSessionStore.js';

type DebugInput = string | GameMessage[];

type WriteGameDebugParams = {
  functionName: string;
  systemPrompt: string;
  input: DebugInput;
  worldStatePrompt?: string;
  reply: string | object;
  reasoning?: string;
};

const CURRENT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEBUG_DIRECTORY = path.resolve(CURRENT_DIRECTORY, '../../../data/game-debug');

export async function writeGameDebugMarkdown({
  functionName,
  systemPrompt,
  input,
  worldStatePrompt,
  reply,
  reasoning,
}: WriteGameDebugParams): Promise<void> {
  try {
    await mkdir(DEBUG_DIRECTORY, { recursive: true });

    const timestamp = new Date().toISOString().replaceAll(':', '-').replace('.', '-');
    const filename = `${timestamp}_${functionName}.md`;
    const filePath = path.join(DEBUG_DIRECTORY, filename);
    const sections = [
      buildSection('系统提示词', toMarkdownText(systemPrompt)),
      Array.isArray(input)
        ? buildSection('全部消息', formatGameMessages(input))
        : buildSection('单条消息', toMarkdownText(input)),
      worldStatePrompt ? buildSection('worldStatePrompt', toMarkdownText(worldStatePrompt)) : null,
      buildSection('返回的直接回复', formatReply(reply)),
      reasoning ? buildSection('返回的思索内容', toMarkdownText(reasoning)) : null,
    ].filter((section): section is string => section !== null);

    await writeFile(filePath, `${sections.join('\n\n')}\n`, 'utf8');
  } catch (error) {
    console.error(`[${new Date().toISOString()}] 写入 game debug 文件失败`, error);
  }
}

function buildSection(title: string, content: string): string {
  return `## ${title}\n\n${content}`;
}

function formatGameMessages(messages: GameMessage[]): string {
  if (messages.length === 0) {
    return '（暂无）';
  }

  return messages
    .map((message) => {
      const hint = message.role === 'book' ? '**游戏输出**' : '**玩家输入**';
      return toBlockQuote(`${hint}：${message.content}`);
    })
    .join('\n\n');
}

function formatReply(reply: string | object): string {
  if (typeof reply === 'string') {
    return toMarkdownText(reply);
  }

  return ['```json', JSON.stringify(reply, null, 2), '```'].join('\n');
}

function toMarkdownText(content: string): string {
  const lines = content.split('\n')
  const mashedLines = lines.map(l => l.startsWith('#') ? `#${l}` : l)
  const mashedContent = mashedLines.join('\n')
  return mashedContent.trim() ? mashedContent : '（模型返回了空内容）';
}

function toBlockQuote(content: string): string {
  return content
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

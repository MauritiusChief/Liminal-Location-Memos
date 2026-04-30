import type { GameMessage, GameState } from "./gameSessionStore.js";

const RECENT_ACTION_CONTEXT_LIMIT = 6;

/**
 * Router 和 Manager 共用同一份玩家行动上下文格式，避免两阶段看到的“玩家说了什么”
 * 在细节上发生偏移。这里刻意不包含 worldState；环境信息只交给 Manager 使用。
 */
export function buildPlayerActionContextPrompt(
  state: GameState,
  recentHistoryLimit = RECENT_ACTION_CONTEXT_LIMIT,
): string {
  const messageHistory = state.messageHistory;
  const latestPlayerMessage = messageHistory[messageHistory.length - 1];

  return [
    '玩家发送的消息：',
    `> ${latestPlayerMessage?.content ?? ''}\n`,
    '---',
    '近期对话历史：',
    formatGameStateRecentMessageHistory(
      messageHistory.slice(
        Math.max(0, messageHistory.length - recentHistoryLimit),
        messageHistory.length - 1,
      ),
    ),
  ].join('\n');
}

export function formatGameStateRecentMessageHistory(messageHistory: GameMessage[]): string {
  return messageHistory
    .map((messageEntry) => {
      const contentLines = messageEntry.content.split('\n');
      if (messageEntry.role === 'book') {
        return `> **游戏输出**：\n${contentLines.map(line => `> ${line}`).join('\n')}\n>`;
      }

      const playerLines = [
        `> **玩家输入**：\n${contentLines.map(line => `> ${line}`).join('\n')}`,
        '>',
      ];

      if (!messageEntry.stateChange?.length) {
        return playerLines.join('\n');
      }

      const toolCallLines = JSON.stringify(messageEntry.stateChange, null, 2).split('\n');
      return [
        ...playerLines,
        `> **游戏状态变化**：\n${toolCallLines.map(line => `> ${line}`).join('\n')}`,
        '>',
      ].join('\n');
    })
    .join('\n');
}

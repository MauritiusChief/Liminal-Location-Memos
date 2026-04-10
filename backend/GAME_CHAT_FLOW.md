# Game Chat Flow

## Overview
当前正式游戏链路的入口有三条：

- `POST /api/game/start`
- `POST /api/game/turn`
- `GET /api/game/session/:sessionId`

前两条接口都返回 NDJSON stream；恢复接口返回客户端可消费的 session 快照。

## Runtime Model
- `GameState`
  - 纯长期游戏状态，包含位置、朝向、对话历史、Visual Description 等
- `GameSave`
  - 可持久化恢复的存档，主体是 `sessionId + GameState`
- `GameSession`
  - 运行时会话，持有 `GameState`，并额外承载 `pendingVisualDescription`、`queuedPlayerMessage`、`activeTurnId` 等后台态

`gameSessionStore.ts` 负责：

- 内存中的 runtime session map
- `GameSave` 的 JSON 读写
- `GameSession -> client snapshot` 的转换

## Streamed Turn
`streamGameStart()` / `streamGameTurn()` 在 `backend/src/services/gameSystem/gameChat.ts` 中完成正式编排。

处理顺序如下：

1. 基于当前 `GameState` 准备 scene prompt / world-state prompt
2. 调用 `llm.ts` 的流式入口生成 Book Message
3. 持续向前端发送 `book_reply_delta`
4. Book 文本结束后，先把最新 `GameState` 写回 `GameSave`
5. 发送 `book_done` 与 `session_committed`
6. 启动 `Visual Description` 后台补写，并发送 `visual_description_started`
7. 完成后写回 save，并发送 `visual_description_done`

## Queue Policy
- 同一 `sessionId` 任一时刻只允许 1 条正在生成中的 Book Message
- 当 `pendingVisualDescription = true` 时，允许暂存 1 条 `queuedPlayerMessage`
- 若队列已占满，新的 `/api/game/turn` 请求会返回 `queue_rejected`
- 被接受排队的请求会先收到 `queued_next_turn`，然后等待后台准备结束，再继续执行本轮 Book stream

## Stream Events
正式游戏当前使用的领域事件：

- `player_message_accepted`
- `book_reply_delta`
- `book_done`
- `session_committed`
- `visual_description_started`
- `visual_description_done`
- `queued_next_turn`
- `queue_rejected`
- `error`

## Frontend Consumption
前端通过 `frontend/src/api/gameApi.ts` 的 `streamGameStart()` / `streamGameTurn()` 消费 NDJSON。

`chatSlice` 维护两层状态：

- 已提交的 session 快照
- 尚未 commit 的临时 `streamingBookMessage`

因此页面可以在 Book 文本 streaming 时先渲染临时消息，在 `session_committed` 到达后再切换到正式快照，并在 `visual_description_done` 后刷新右侧 debug 面板。

# Game Chat Flow

## Overview
当前正式游戏链路的入口只有两条：

- `POST /api/game/chat`
- `GET /api/game/session/:sessionId`

`POST /api/game/chat` 负责执行一轮正式游戏对话；`GET /api/game/session/:sessionId` 负责读取已有 session 的快照并恢复前端状态。

## Step 1: Route -> Session -> Scene Preparation
`/api/game/chat` 在 `backend/src/routes/api.ts` 中只做参数校验，然后调用 `runGameChatTurn()`。

处理顺序如下：

1. `getOrCreateSession()`
   - 在 `backend/src/services/gameSessionStore.ts`
   - 先查运行时内存 `Map`
   - 如果未命中，再从 `data/game-saves/*.json` 读取或创建新 session
   - 当前 session 是“内存缓存 + JSON 持久化”结构
2. `ensureCoverageForPosition()`
   - 在 `backend/src/services/gameScene.ts`
   - 先检查当前位置到最近 `osm_sync_coverage` 的距离
   - 若 300m 内已有 coverage，则直接从数据库请求数据，以复用现存数据
   - 否则发起一次半径 `1000m` 的 Overpass 同步并写回数据库
3. `loadSceneContext()`
   - 在 `backend/src/services/gameScene.ts`
   - 默认先加载 `1000m` 大场景
   - 复用数据库链路生成 `diagnostics`、`microGrid`、`polarView`
4. `ensureLargeDescription()`
   - 在 `backend/src/services/sceneDescriptionService.ts`
   - 先按距离和 `effectiveRadiusM` 复用已有大描述
   - 未命中时再按需请求 `concise_far_1000` summary 调用 LLM 生成
5. `ensureSmallDescription()`
   - 在 `backend/src/services/sceneDescriptionService.ts`
   - 先复用已有小描述
   - 未命中时按需请求 `concise_near_200` summary 调用 LLM 生成
   - 小描述仍会保存 `farVisibleNotes`，供后续场景快照提供远距可见细节
6. `mergeNearbySmallDescriptions()`
   - 在 `backend/src/services/gameChat.ts`
   - 取当前位置 `200m` 内的小描述列表
   - 并确保当前命中的 active small description 一定包含在返回结果中

到这一步，后端已经拿到本轮需要的 session、当前位置 scene context、active large description、active small description，以及附近小描述列表。

## Step 2: LLM Turn With Tools
`runGameChatTurn()` 在 `backend/src/services/gameChat.ts` 中继续完成本轮 LLM 交互。

处理顺序如下：

1. `buildModelMessages()`
   - 组装 `system + history + user + synthetic scene context`
   - 当前可见消息类型对外是 `user`、`assistant`、`tool`
   - 内部还会保存 assistant 的 tool-call message，但前端展示时会裁掉
2. 首次 `runChatCompletionWithTools()`
   - 当前暴露两个工具：`move_player` 和 `look_far`
3. 如果模型调用 `move_player`
   - 后端解析角度和距离
   - 调用 `movePosition()` 计算新坐标
   - 对新坐标再次执行：`ensureCoverageForPosition()` -> `loadSceneContext()` -> `ensureLargeDescription()` -> `ensureSmallDescription()`
   - 把工具结果写成 `tool` 消息，继续后续轮次
4. 如果模型调用 `look_far`
   - 不移动坐标
   - 只切换为远眺视角，并按需请求 `concise_far_1000` summary 生成新的场景快照后写成 `tool` 消息
5. 每次工具调用后
   - 都会再通过 synthetic `scene_context_snapshot` assistant/tool 消息把最新环境快照补回消息流
   - 再次调用 `runChatCompletionWithTools()` 生成后续回复
6. 本轮结束时
   - 把 `user`、本轮 tool chain、最终 `assistant` 回复一起写入 `messageHistory`
   - history 会按 turn 裁剪，但会保留完整 tool chain
   - `updateSession()` 负责同时更新内存中的 session 和 JSON 存档

`POST /api/game/chat` 返回的当前真实响应面为：

- `sessionId`
- `messages`
- `playerPosition`
- `activeLargeDescription`
- `nearbySmallDescriptions`

`GET /api/game/session/:sessionId` 返回相同的恢复快照，并额外带 `hasStarted`。

## File Roles
- `backend/src/routes/api.ts`
  - 组织 `/api/game/chat` 和 `/api/game/session/:sessionId` 两个正式接口
- `backend/src/services/gameChat.ts`
  - 负责单轮对话编排、tool loop、消息组装与 history 裁剪
- `backend/src/services/gameScene.ts`
  - 负责 coverage 补洞、基础场景装载和带缓存的 `SceneContext` 生成
- `backend/src/services/scene/sceneSummaryService.ts`
  - 负责 summary mode 到半径/提示词模式的映射，以及单一 summary 的按需生成
- `backend/src/services/gameSessionStore.ts`
  - 负责 session 的内存缓存、JSON 持久化和对外快照转换
- `backend/src/services/sceneDescriptionService.ts`
  - 负责 large/small description 的复用与生成
- `backend/src/services/sceneDescriptionRepository.ts`
  - 负责 description 的空间查询与写入，不负责提示词编排
- `backend/src/services/llm.ts`
  - 负责普通回复生成和带工具的 chat completion 调用

## Frontend Consumption
前端当前通过 `frontend/src/api/gameApi.ts` 调用正式接口，并消费后端返回的：

- `sessionId`
- `messages`
- `playerPosition`
- `activeLargeDescription`
- `nearbySmallDescriptions`

首页右侧 debug 面板直接展示当前位置、大描述和附近小描述。“Latest Movement” 不是后端独立字段，而是前端从 `messages` 中最近一条 `move_player` tool 消息推导出来的。

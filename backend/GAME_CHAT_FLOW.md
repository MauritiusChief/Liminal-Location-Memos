# Game Chat 工作流程

这份文档解释当前正式游戏链路 `POST /api/game/chat` 的执行顺序，以及每一步由哪些文件和函数负责。

## 1. 总览

当前正式链路的核心目标是：

1. 接收玩家输入
2. 读取或创建游戏会话
3. 检查当前位置是否需要自动补齐 Overpass 数据
4. 从数据库装载当前位置场景
5. 即时生成程序摘要 `summary`
6. 复用或生成大描述 / 小描述
7. 让 LLM 决定是否调用 `move_player`
8. 如果发生移动，再执行一次“补洞 -> 装载场景 -> 复用或生成描述”
9. 返回自然语言回复和 debug 所需数据给前端

可以把它理解成两层：

- 数据层：OSM 场景数据、coverage 记录、JSON 会话存档中的描述记录
- 回合层：一次 `/api/game/chat` 请求如何驱动这些数据流动

## 2. 路由入口

文件：

- [api.ts](/d:/GitHub/Liminal-Location-Memos/backend/src/routes/api.ts)

关键函数：

- `apiRouter.post('/game/chat', ...)`

职责：

- 校验请求体里的 `message`
- 读取可选的 `sessionId`
- 调用 `runGameChatTurn()`
- 把 service 层返回的结构化结果直接返回给前端

说明：

- 路由层不做业务编排
- 真正的“会话、移动、补洞、描述复用、LLM 调用”都在 service 层

## 3. 一次正式回合如何执行

文件：

- [gameChat.ts](/d:/GitHub/Liminal-Location-Memos/backend/src/services/gameChat.ts)

关键函数：

- `runGameChatTurn()`

这是整个链路的总编排函数，顺序如下。

### 3.1 读取或创建会话

文件：

- [gameSessionStore.ts](/d:/GitHub/Liminal-Location-Memos/backend/src/services/gameSessionStore.ts)

函数：

- `getOrCreateSession()`
- `updateSession()`

职责：

- 在内存 `Map` 中读取现有 session
- 如果不存在，则创建一个新 session
- session 里保存：
  - `playerPosition`
  - `messageHistory`
  - `activeLargeDescriptionId`
  - `visibleSmallDescriptionIds`
  - `lastSceneContext`

说明：

- 当前版本会话有“内存缓存 + JSON 文件”两层
- 内存层负责减少重复读盘和重复建索引
- JSON 文件负责后端重启后的恢复

### 3.2 检查当前位置是否需要补洞

文件：

- [gameScene.ts](/d:/GitHub/Liminal-Location-Memos/backend/src/services/gameScene.ts)
- [osmRepository.ts](/d:/GitHub/Liminal-Location-Memos/backend/src/services/osmRepository.ts)

关键函数：

- `ensureCoverageForPosition()`
- `findNearestCoverageDistanceMeters()`

流程：

1. 从 `osm_sync_coverage` 查询当前位置到最近 coverage 点的距离
2. 如果距离小于等于 300m，则认为已有数据可用
3. 如果距离大于 300m，则：
   - 调用 `buildNormalizedOverpassQuery()`
   - 调用 `overpassJson()`
   - 调用 `convertOverpassToNormalizedFeatures()`
   - 调用 `syncNormalizedFeaturesToDb()`

说明：

- 这就是“自主发送 overpass query 填补地图空白”的实现入口
- 当前补洞半径固定为 1000m

## 4. 如何从 DB 装载当前位置场景

文件：

- [gameScene.ts](/d:/GitHub/Liminal-Location-Memos/backend/src/services/gameScene.ts)
- [overpassGrid.ts](/d:/GitHub/Liminal-Location-Memos/backend/src/services/overpassGrid.ts)
- [overpassPolar.ts](/d:/GitHub/Liminal-Location-Memos/backend/src/services/overpassPolar.ts)
- [overpassPrompt.ts](/d:/GitHub/Liminal-Location-Memos/backend/src/services/overpassPrompt.ts)

关键函数：

- `loadSceneContext()`
- `loadProjectedScene()`

流程：

`loadSceneContext()` 会同时加载两份 scene：

1. 大场景：
   - 半径 `1000m`
   - 用于大描述和宏观世界上下文
2. 小场景：
   - 半径 `200m`
   - 用于小描述和局部观察

`loadProjectedScene()` 内部做的事情：

1. `fetchFeatureDetailsFromDb()`
2. `fetchMicroGridFromDb()`
3. `fetchPolarFeaturesFromDb()`
4. `buildNormalizedMicroGrid()`
5. `buildNormalizedPolarView()`
6. `buildNormalizationPrompt()`

产出：

- `featureSummary`
- `microGrid`
- `polarView`
- `summary`

说明：

- 这里没有重新发明场景投影逻辑
- 正式链路直接复用了现有 debug 链路的 DB-native 投影能力

## 5. `summary` 是什么

文件：

- [gameScene.ts](/d:/GitHub/Liminal-Location-Memos/backend/src/services/gameScene.ts)
- [overpassPrompt.ts](/d:/GitHub/Liminal-Location-Memos/backend/src/services/overpassPrompt.ts)

关键点：

- `summary` 是程序生成的确定性文本
- 相同 scene data 一定会产生相同 `summary`
- 所以它不落库，不做缓存

当前在 `SceneContext` 里拆成两份：

- `largeSummary`
- `smallSummary`

另外还会生成两个签名：

- `largeSceneSignature`
- `smallSceneSignature`

签名生成函数：

- `createSceneSignature()`

作用：

- 判断“当前 scene 是否和某条已存在描述对应的是同一场景”

## 6. 大描述和小描述如何复用或生成

文件：

- [sceneDescriptionRepository.ts](/d:/GitHub/Liminal-Location-Memos/backend/src/services/sceneDescriptionRepository.ts)
- [sceneDescriptionService.ts](/d:/GitHub/Liminal-Location-Memos/backend/src/services/sceneDescriptionService.ts)
- [gameDescriptionIndex.ts](/d:/GitHub/Liminal-Location-Memos/backend/src/services/gameDescriptionIndex.ts)

当前 description 不再落到 relational DB，而是保存在每个会话对应的 JSON 文档中。
空间命中由 `kdbush/geokdbush` 提供。

### 6.1 大描述

关键函数：

- `findActiveLargeDescription()`
- `ensureLargeDescription()`
- `insertLargeDescription()`

流程：

1. 用 `largeSceneSignature` 查询是否存在“同一 scene 且当前位置仍在有效半径内”的大描述
2. 如果存在，直接复用
3. 如果不存在，就调用 LLM 基于 `largeSummary` 生成
4. 把生成结果写入当前会话 JSON 文档中的 `largeDescriptions`

### 6.2 小描述

关键函数：

- `findReusableSmallDescription()`
- `findNearbySmallDescriptions()`
- `ensureSmallDescription()`
- `insertSmallDescription()`

流程：

1. 用 `smallSceneSignature` 查询可复用的小描述
2. 如果不存在，则先取当前位置 200m 内已有的小描述
3. 调用 LLM 基于 `smallSummary` 生成新的小描述
4. 同时要求模型返回：
   - `descriptionText`
   - `farVisibleNotes`
5. 写入当前会话 JSON 文档中的 `smallDescriptions`

说明：

- `findNearbySmallDescriptions()` 不再查 SQL
- 它会从当前会话的 description 索引中取 200m 内候选，再按距离返回

## 7. 为什么小描述要有 `farVisibleNotes`

文件：

- [sceneDescriptionService.ts](/d:/GitHub/Liminal-Location-Memos/backend/src/services/sceneDescriptionService.ts)

相关函数：

- `generateSmallDescription()`
- `filterFarVisibleSmallDescriptions()`

原因：

- 你要求“生成小描述时读取 200 米内其他小描述，但只考虑那些能在 200 米外看到的细节”
- 所以不能把别的小描述全文直接塞进 prompt

当前做法：

1. 小描述生成时要求模型返回 `farVisibleNotes`
2. 后续其他位置生成小描述时，只读取附近记录的 `farVisibleNotes`

这样可以避免把近距离才能知道的细节，例如：

- 门牌
- 店内细节
- 30m 内网格级细节

错误传播到相邻位置

## 8. LLM 如何决定是否移动

文件：

- [gameChat.ts](/d:/GitHub/Liminal-Location-Memos/backend/src/services/gameChat.ts)
- [llm.ts](/d:/GitHub/Liminal-Location-Memos/backend/src/services/llm.ts)

关键函数：

- `runChatCompletionWithTools()`
- `parseMovePlayerArguments()`

工具定义：

- `MOVE_PLAYER_TOOL`

工具参数：

- `bearingDegrees`
- `distanceMeters`
- `reason`
- `targetLabel`

流程：

1. 后端先构建 system prompt
2. 这个 prompt 会包含：
   - 当前大描述
   - 当前小场景 summary
   - 200m 内其他小描述的 `farVisibleNotes`
3. 调用 `runChatCompletionWithTools()`
4. 如果模型没有调用工具，则直接使用文本回复
5. 如果模型调用了 `move_player`：
   - 后端解析参数
   - 调用 `movePosition()` 计算新经纬度
   - 对新位置再次补洞、装载场景、复用/生成描述
   - 最后再调用一次 LLM 输出最终自然语言回复

## 9. 坐标移动是如何计算的

文件：

- [gameMovement.ts](/d:/GitHub/Liminal-Location-Memos/backend/src/services/gameMovement.ts)

关键函数：

- `movePosition()`

职责：

- 输入旧坐标、角度、距离
- 用球面近似公式算出新经纬度

说明：

- 当前版本不做寻路
- 不考虑道路网络
- 不考虑障碍碰撞
- 只做“平面世界上的位移”
- coverage 判定仍然完全依赖 SQL 中的 `osm_sync_coverage`

## 10. 前端如何消费 `/api/game/chat`

文件：

- [gameApi.ts](/d:/GitHub/Liminal-Location-Memos/frontend/src/api/gameApi.ts)
- [chatSlice.ts](/d:/GitHub/Liminal-Location-Memos/frontend/src/features/chat/chatSlice.ts)
- [HomeChatPage.tsx](/d:/GitHub/Liminal-Location-Memos/frontend/src/pages/HomeChatPage.tsx)
- [sceneTypes.ts](/d:/GitHub/Liminal-Location-Memos/frontend/src/api/sceneTypes.ts)

### 10.1 API 层

`submitGameChat()` 直接请求：

- `POST /api/game/chat`

### 10.2 Redux 状态

`chatSlice` 维护两类状态：

1. 对话状态
   - `messages`
   - `message`
   - `request`
2. 世界状态
   - `sessionId`
   - `playerPosition`
   - `activeLargeDescription`
   - `nearbySmallDescriptions`
   - `latestMovementResult`

### 10.3 页面渲染

`HomeChatPage` 分成两块：

1. 左侧消息流
2. 右侧 debug 面板

右侧会显示：

- 当前玩家经纬度
- 当前大描述
- 当前 200m 内所有小描述
- 最近一次移动结果

## 11. 你读代码时建议先看哪里

建议阅读顺序：

1. [api.ts](/d:/GitHub/Liminal-Location-Memos/backend/src/routes/api.ts)
2. [gameChat.ts](/d:/GitHub/Liminal-Location-Memos/backend/src/services/gameChat.ts)
3. [gameScene.ts](/d:/GitHub/Liminal-Location-Memos/backend/src/services/gameScene.ts)
4. [sceneDescriptionService.ts](/d:/GitHub/Liminal-Location-Memos/backend/src/services/sceneDescriptionService.ts)
5. [sceneDescriptionRepository.ts](/d:/GitHub/Liminal-Location-Memos/backend/src/services/sceneDescriptionRepository.ts)
6. [gameMovement.ts](/d:/GitHub/Liminal-Location-Memos/backend/src/services/gameMovement.ts)
7. [chatSlice.ts](/d:/GitHub/Liminal-Location-Memos/frontend/src/features/chat/chatSlice.ts)
8. [HomeChatPage.tsx](/d:/GitHub/Liminal-Location-Memos/frontend/src/pages/HomeChatPage.tsx)

如果你只想先看“主流程”，读前 4 个文件就够了。

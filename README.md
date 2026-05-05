# Liminal Location Memos

基于真实地理位置（OpenStreetMap）的互动叙事游戏引擎。后端从 Overpass API 获取真实地图数据，经过规整化后存入 PostgreSQL，再通过程序生成建筑室内布局、场景描述等，最后由 LLM（DeepSeek / OpenRouter）作为"书"（Book / 叙述者 / GM）驱动游戏流程。前端提供聊天界面和多组开发调试工具。

## 技术栈

| 层 | 技术 |
|--|------|
| 前端 | Vite + React 19 + Redux Toolkit + TypeScript + React Router |
| 后端 | Node.js + Express + TypeScript |
| 数据库 | PostgreSQL + PostGIS |
| LLM | DeepSeek Chat / OpenRouter（OpenAI-compatible API） |
| 地图数据 | Overpass API (OpenStreetMap) |

## 目录结构

```
Liminal-Location-Memos/
├── backend/                    # Express API 服务器
│   ├── src/
│   │   ├── index.ts            # 进程入口
│   │   ├── app.ts              # Express 应用装配
│   │   ├── config.ts           # 环境变量配置
│   │   ├── routes/             # API 路由定义
│   │   ├── services/           # 业务逻辑模块
│   │   │   ├── gameSystem/     # 游戏主循环 / LLM Agent 管线
│   │   │   ├── scene/          # 场景组装（Micro Grid + Polar View）
│   │   │   ├── buildingGeneration/  # 建筑室内布局生成
│   │   │   ├── osmNormalization/    # OSM 数据规整化
│   │   │   ├── objectGeneration/    # 物品/家具模板（开发中）
│   │   │   └── weatherGeneration/   # 天气生成（开发中）
│   │   ├── db/                 # PostgreSQL 客户端
│   │   └── types/              # 类型定义
│   ├── sql/                    # 数据库 DDL / 迁移脚本
│   ├── scripts/                # 工具脚本
│   ├── tests/                  # 测试
│   └── data/game-saves/        # 游戏存档（JSON）
├── frontend/                   # React 客户端
│   └── src/
│       ├── main.tsx            # React 入口
│       ├── App.tsx             # 根布局 + 导航
│       ├── app/                # Redux Store / 路由 / hooks
│       ├── api/                # HTTP 客户端 + API 封装
│       ├── features/           # Redux Slice（按功能分）
│       ├── pages/              # 页面组件
│       └── components/         # 共享组件
└── _designer_note/             # 设计文档 / 思路记录
```

## 快速开始

### 依赖

- Node.js 24+
- PostgreSQL 16+（需开启 PostGIS 扩展）

### 安装

1. 安装前端依赖：
   ```powershell
   cd frontend
   npm install
   ```

2. 安装后端依赖：
   ```powershell
   cd backend
   npm install
   ```

3. 创建 PostgreSQL 数据库并执行 `backend/sql/` 下的脚本（按文件名编号顺序）：
   ```powershell
   createdb liminal-location-memos
   psql -d liminal-location-memos -f backend/sql/001_init_postgis.sql
   psql -d liminal-location-memos -f backend/sql/002_create_osm_tables.sql
   psql -d liminal-location-memos -f backend/sql/003_create_osm_views.sql
   ```

4. 从 `backend/.env.example` 创建 `backend/.env`，填入 LLM API Key 和数据库连接信息。

### 运行

启动后端（默认端口 3001）：

```powershell
cd backend
npm run dev
```

新开终端启动前端：

```powershell
cd frontend
npm run dev
```

前端开发服务器会将 `/api` 请求代理到 `http://localhost:3001`。

## 模块详解

### Backend 模块

#### Core Infrastructure — 应用骨架

负责 Express 服务器启动、配置读取、PostgreSQL 连接池初始化。

| 文件 | 说明 |
|------|------|
| `src/routes/api.ts` | 全部路由定义（生产：`/game/start` `/game/turn` 等；调试：`/debug/llm` `/debug/overpass` 等） |

#### Game System — 游戏主循环与 LLM Agent 管线

核心游戏模块。定义了 Game State（长期状态）、Game Save（存档）、Game Session（运行时会话）三层结构。游戏回合流程：**Router**（意图分类）→ **State Manager**（工具决策）→ **Book Composer**（叙述生成）→ **Visual Describer**（后台视觉描述补写）。

- **Book** = LLM 扮演的叙述者/GM
- **Game State** = 玩家位置/朝向/对话历史/Visual Description 等长期数据
- **World State** = 系统视角的完整世界（State Manager 消费）
- **Player State** = 玩家知道的部分世界（Book Composer 消费）

| 文件 | 说明 |
|------|------|
| `src/services/gameSystem/gameChat.ts` | 游戏循环编排：`streamGameStart()` / `streamGameTurn()` |
| `src/services/gameSystem/gameSessionStore.ts` | GameState / GameSession / GameSave 类型定义 + 持久化 |

> **阅读路线建议**：先读 `_note.md` 理解术语 → `gameSessionStore.ts` 看数据结构 → `gameChat.ts` 看流程编排 → `agentStateRouter.ts` / `agentStateManager.ts` 看 Agent 逻辑

#### Scene — 场景组装

以玩家位置为中心，程序化组装两大结构：
- **Micro Grid**：12×12 网格，每格 5m，覆盖中心 60m×60m 范围
- **Polar View**：三级同心环（30~100m / 100~300m / 300m~1km），经过 Level → Occlusion → Cluster → Filter 管线

| 文件 | 说明 |
|------|------|
| `src/services/scene/sceneObject.ts` | 场景组装入口：`buildSceneFromRequest()` |
| `src/services/scene/scenePrompt.ts` | 场景 → LLM 文本提示词 |

#### Building Generation — 建筑室内布局生成

从 OSM 地物分类出发，经过 **Category → Pattern → Pattern Distribution → Category Schema → Sector Distribution → 补齐** 管线，生成建筑的完整室内布局（楼层/区域/房间/套房）。

当前支持的建筑分类：house（独栋房屋）、apartment（公寓）、附属建筑（garage/shed 等）。建筑分类仍在持续拓展中。

| 文件 | 说明 |
|------|------|
| `src/services/buildingGeneration/buildingSchema.ts` | 核心：建筑分类 + 生成管线编排（~900 行） |
| `src/services/buildingGeneration/buildingRecord.ts` | Schema → 运行期可消费的记录（房间展开、子房间、玩家定位） |

#### OSM Normalization — 地图数据规整化

从 Overpass API 获取 OSM 原始数据 → 规整化为统一 GeoJSON 格式 → 分类（building / POI / line / area）→ 写入 PostgreSQL。

| 文件 | 说明 |
|------|------|
| `src/services/osmNormalization/osmNormalizer.ts` | 核心规整化引擎（~900 行）：去重、Relation 处理、标签继承、POI 提取 |
| `src/services/osmNormalization/osmGate.ts` | Overpass API 请求入口 |

#### Object Generation — 物品/家具模板（开发中）

当前仅定义了数据结构接口（ItemRecord / FurnitureRecord / Cardboard*），生成逻辑仍在开发中。

#### Weather Generation — 天气生成（开发中）

尚无代码实现，仅有设计笔记（`_note.md`）。

### Frontend 页面

主页面：

| 页面 | 路由 | 核心文件 |
|------|------|-----------|
| **Home Chat** | `/` | `pages/HomeChatPage.tsx` / `features/chat/chatSlice.ts` |

另有若干 Debug 页面（路由 `/debug/...`），用于开发和测试 LLM、OSM 数据管线、建筑生成等环节，随开发需要灵活调整，此处不逐一详述。

## 架构数据流

```
Overpass API
    │ (raw OSM JSON)
    ▼
OSM Normalizer  ──→  PostgreSQL/PostGIS
(osmNormalizer.ts)   (building / poi / line / area 表)
    │
    ▼
Scene Object  ◄──  DB Feature Details
(sceneObject.ts)   (featureDetail.ts)
    │
    ├──  Micro Grid (30m, 12×12 × 5m)
    └──  Polar View (30m~1km, 三级环 + 遮挡 + 聚类 + 过滤)
    │
    ▼
Scene Prompt  ──→  LLM (DeepSeek/OpenRouter)
(scenePrompt.ts)    │
                    ├── Book Composer → 叙述文本 → NDJSON 流 → 前端
                    ├── State Router  → 意图分类
                    └── State Manager → 工具调用（移动/室内定位/生成物品）
                    │
                    ▼
            Game State / Game Save / Game Session
            (gameSessionStore.ts → data/game-saves/*.json)
```

## 文档

- `backend/GAME_CHAT_FLOW.md` — 游戏聊天流的详细说明（Stream Events、Queue Policy、Frontend Consumption）
- `backend/src/services/*/_note.md` — 各模块设计笔记（术语定义、处理流程、架构决策）
- `_designer_note/` — 设计思路记录（建筑相对位置、玩家移动、室内细节生成等）

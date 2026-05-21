# Game System 说明

这个模块包括：
- 游戏的初始化
- Game Save/Game State/Game Session 的定义以及修改函数
- 游戏回合的运作机制
- LLM 可以使用的各种工具

术语：
- **Book**：指代的是剧本，也就是该剧本的主持人。是采用多种程序生成信息然后以自然语言呈现给玩家的“直接交互者”
- **Book Message**：与 User Message 相对，指的是剧本发送给玩家的消息
- **Game State**：盛装所有的游戏世界与对话记录、玩家状态等数据，只包含长期有效、需要参与后续推演的状态
- **Game Save**：可持久化恢复的存档快照。主体是 Game State 加恢复所需元数据，但不包含运行态后台任务信息
- **Game Session**：运行时会话容器。持有 Game Save / Game State，并额外承载流式请求、后台准备、排队消息、并发控制等临时状态
- **World State**：系统角度的游戏世界以及玩家角色的状态，会通过手段去掉无关内容防止信息爆炸
  - 用在 Game State Manager (Agent)
- **Player State**：玩家视角的状态描述，仅包括 World State 所有状态当中玩家知道的部分
  - 用在 Book Composer (Agent)
  - （TODO）记忆功能，记忆玩家明明知道的建筑地点

Game State 术语：
- **Visual Description**：用来记录某地范围内，确定性数据（比如 OSM）未呈现而让 LLM 自由发挥的地方。
  - **Field Visual Description**
    - 内容为以列表形式记录某一经纬度为 index、半径300米范围内的 World State 数据（包括 OSM 和游戏内的物品、容器等数据）未呈现，但在过往 LLM 对话中提及的细节
    - 处于玩家300米范围内的 Field Visual Description 都会以附带极坐标方位的形式呈现给 LLM，作为事实来源
    - 生成途径：玩家距离最近的 Field Visual Description 超过300米了，以玩家所在坐标为基准记录
  - **Exterior Visual Description**
    - 与 Field Visual Description 类似，内容为列表形式半径300米范围内 LLM 对话中与建筑相关的细节，此时 index 为建筑的id。
    - 生成途径：LLM 在概览 Book Message 时，如果某些细节与建筑有关，就会以该细节所对应的建筑id为基准进行记录（需要 LLM 辨认属于哪个建筑）
  - **Room Visual Description**
    - 内容与 Field Visual Description 类似，但记录的 index 是某房间
    - 只有所在房间的 Visual Description 才会激活
- **Visible Location**：在 Game State 的 playerVisibleLocations 中用来记载当前玩家可看到的范围。
  - playerVisibleLocations 决定关系如下：默认情况下只能看到所在 Sector 的普通房间与套房表层。特殊情况下：
    - 处在楼梯口等，可以看见相邻楼层的垂直连接处，比如楼梯间或者阁楼
    - 破坏了视觉遮挡的情况下，可以看到套房内部的子房间
    - 破坏了视觉遮挡的情况下，可以看到 internal access 相连的另一栋建筑的 internal access 另一端房间
  - playerVisibleLocations 在玩家每次转移 Sector 时，都会重新计算并由 Game State Manager 指定特殊情况
  - playerVisibleLocations 不决定可互动关系，玩家总是只能和所在的 Indoor Location 互动

## 游戏流程

### 开局回合

1. 玩家点击开始游戏后，进入游戏初始化流程。从经纬度数据读取 OSM、生成 Building Schema 等，组装 Player State Prompt，让 Book Composer (Agent) 生成开场 Book Message
2. 生成初始 Book Message 时，会先以 stream 的形式把文本增量发给前端
3. Book Message stream 完成后，先立即提交本轮 Game Save，再由 Visual Describer (Agent) 根据 Book Message 和已有的世界状态撰写/更新 Visual Description
  - 为了更短的互动前静止时间，Visual Description 不再阻塞 Book Message 的送达
  - 在 Visual Description 工作完成之前，只允许暂存 1 条下一回合的 User Message，（TODO）界面形式与发送消息后等待回复一模一样
  - 当 Visual Description 准备完毕后，排队中的下一条消息才会进入下一回合

### 常规回合

0. 玩家发送信息，先由 Game State Manager (Agent) 通过专门处理 Game State，获取包括对话记录在内的全量游戏状态，产出多个顺序进行的 Game State Tool Call
1. Game State 处理完毕后，处理结果以及玩家的周遭信息会以 syth tool return 的形式给到 Book Composer (Agent)，生成 Book Message
2. Book Message 被 stream 给前端
3. 与开局回合相似的 Visual Describer (Agent) 流程

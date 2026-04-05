# Game System 说明

这个模块包括：
- 游戏的初始化
- Game Save 与 Game State 的定义以及修改函数（TODO：细化）
- 游戏回合的运作机制
- LLM 可以使用的各种工具

术语：
- **Book**：指代的是剧本，也就是该剧本的主持人。是采用多种程序生成信息然后以自然语言呈现给玩家的“直接交互者”
- **Book Message**：与 User Message 相对，指的是剧本发送给玩家的消息

- **Visual Description**：用来记录某地范围内，确定性数据（比如 OSM）未呈现而让 LLM 自由发挥的地方。
  - **Outdoor Visual Description**
    - 内容为以列表形式记录某一经纬度半径100米范围内的，OSM 数据未呈现，但在过往 LLM 对话中提及的细节
    - 处于玩家300米范围内的 Outdoor Visual Description 都会以附带极坐标方位的形式呈现给 LLM，作为事实来源
    - 生成时有两种途径
      - 玩家距离最近的 Outdoor Visual Description 超过100米了，以玩家所在坐标为基准记录
      - （TODO）LLM 在概览 Book Message 时，认为某些事实性细节假如在只提供 OSM 数据的情况下无法复现。这时会以该细节所对应的建筑的中心坐标为基准记录
  - **Level Visual Description**

## 游戏流程

1. 玩家点击开始游戏后，进入游戏初始化流程。从经纬度数据读取 OSM 然后生成 Scene Prompt，让一个专门的 Agent 生成开场 Book Message
2. 每次生成 Book Message 并发送给前端之后，另一个 Agent 便会根据 Book Message 撰写或者更新 Visual Description
  - 为了更短的互动前静止时间, Book Message 会被立刻发送给前端，但在 Visual Description 工作完成之前，下一个 User Message 只会被暂存，等到准备完毕才进入下一回合
  - 这是在赌玩家会花费时间阅读 Book Message 时，Visual Description 等准备工作可以利用此时间完成
3. 玩家发送信息之后，先由 Game State 管理者 Agent 专门处理 Game State
4. Game State 处理完毕后，处理结果以及玩家的周遭信息会以 syth tool return 的形式给到剧本主持人，生成 Book Message 发给前端
5.


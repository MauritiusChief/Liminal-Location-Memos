# Game System 说明

这个模块包括：
- 游戏的初始化
- 每回合的 Game State 定义
- 修改每回合 Game State 的函数（TODO：细化）
- Game Save 的定义
- Game Save 修改函数（TODO：细化）

## 相关定义

**Visual Description**：用来记录某地范围内，OSM 数据未呈现而让 LLM 自由发挥的地方。
- 内容为以列表形式记录某一经纬度半径100米范围内的，OSM 数据未呈现，但在过往 LLM 对话中提及的细节
- 处于玩家300米范围内的 Visual Description 都会以附带极坐标方位的形式呈现给 LLM，作为事实来源
- 生成时有两种途径
  - 玩家距离最近的 Visual Description 超过100米了，以玩家所在坐标为基准记录
  - LLM 在概览主 LLM 发给玩家的消息时，认为某些细节假如在只提供 OSM 数据的情况下无法复现。这时会以该细节所对应的建筑的中心坐标为基准记录

# Scene 说明

术语：
- **Scene**：一种用来描述某一经纬度周遭若干米范围内场景的东西
  - **Scene Object**：Scene 的内存数据版本，形式为 object
  - 包含下文的 Grid 以及 Polar View
  - **Scene Prompt**：Scene 的提示词版本，由程序组装
- **Micro Grid**：Scene 当中专门用来描述中心点半径30米内场景的东西
  - 具体格式为12格×12格，格长5m的，总面积60m×60m的正方形网格
  - **Micro Grid Object**：Micro Grid 的内存数据版本，形式为 object
  - **Micro Grid Prompt**：Micro Grid 的提示词版本，主体网格内只装少量信息，剩下的信息补充在网格下方
- **Polar View**：Scene 当中专门用来描述中心点30米以外到查询范围极限处的东西
  - 分为30m~100m, 100m~300m, 300m~1km 三档
  - **Polar View Object**：Polar View 的内存数据版本，形式为 object
  - Polar View Object 会根据玩家视野状态进行筛选，比方说视角限制、辨别认能力限制等
  - **Polar View Prompt**：Polar View 的提示词版本
  - 提示词版本当中，不同距离档会经过固定的规则省略信息或者聚类

这个模块包括
- 从 relational DB 获取数据，组装 Micro Grid 数据结构的工具
- 从 relational DB 获取数据，组装 Polar View 数据结构的工具
- 根据 Micro Grid & Polar View 数据结构组装 Scene Object 的工具
- 从 Micro Grid 数据结构组装 Micro Grid Prompt 的工具
- 从 Polar View 数据结构组装 Polar View Prompt 的工具
- 拼接 Micro Grid & Polar View 的 Prompt 形成 Scene Prompt 的工具

总的来说，只要给定了经纬度与范围，Scene/Micro Grid/Polar View 的 Object/Prompt 都能随意获取

## Polar View Object

组装 Polar View OBject 的工具流程是
1. 组装扁平结构
2. 在扁平结构上打上 marker（cluster marker 和 level marker）
3. 按照 marker 标记组装分为不同 level，level 内部又包含单个 feature 或者多个 feature 组成的 cluster，得到最完整版 Polar View Object
4. 按照不同的配置，对最完整版进行过滤筛选

## DEBUG API

- `POST /api/debug/db/normalized-load`
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
1. 组装扁平结构（理论上最完整的信息，但暂时没有归类）
2. 先进行分层与分区（LeveledPolarView），然后剔除视野遮挡（OccludedPolarView）
3. 打上标签（base label），随后在 level 内进行聚类，level 内部包含单个 feature 或者多个 feature 组成的 cluster（ClusteredPolarView）
4. 按照不同的配置，对 ClusteredPolarView 进行过滤筛选，得到 FilteredPolarView

`polarViewObject.ts` 出口的工具可以直接给定经纬度、范围与分档好的配置名，自动读取 relational DB 数据以及存储的配置，输出一个 FilteredPolarView

## Polar View Occlusion

剔除视野遮挡物体发生在扁平结构组装之后，

此处定义因高度而必定被看到的地物（同时用在此处以及后续 Polar View Filter）

视野遮挡机制：
1. 所有 level 1 (30~100m) 建筑视为完全可见，也因此通过 level 1 计算可见的角度区间
2. 通过 level 2 (100~300m) 建筑计算第二层可见角度区间
3. 对 level 2 每个地物应用 level 1 算出的可见区间，对 level 3 每个地物应用两层可见区间
2. 分别对 level 2 和 3 的每个地物，判断是否有点能透过可见角度区间被极坐标原点看到
3. 对实际存在的 level 2 建筑，也计算遮挡/可视区间
4. 然后再对 level 3 幸存的地物进行再次过滤
5. 把因高度而必定显著的地物额外加上

## Polar View Filter

这是加在 Polar View Object 上的的过滤器，来模拟视野看不到的情况。一共有两层
1. 视野细节看不清的情况，靠望远镜等缓解
2. 视野遮挡的情况，靠站在高处缓解

遮挡情况是决定性的，如果被遮挡那么即使细节辨别能力极强也无法看到。
此处假定如果一个地物非常高，不用站在高处也能看到，那么这个地物一定是显著的

## DEBUG API

- `POST /api/debug/db/normalized-load`
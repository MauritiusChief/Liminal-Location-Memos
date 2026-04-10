# Game System 说明

这个模块包括：
- 游戏的初始化
- Game Save/Game State/Game Session 的定义以及修改函数
- 游戏回合的运作机制
- LLM 可以使用的各种工具
- 建筑的生成工具

术语：
- **Book**：指代的是剧本，也就是该剧本的主持人。是采用多种程序生成信息然后以自然语言呈现给玩家的“直接交互者”
- **Book Message**：与 User Message 相对，指的是剧本发送给玩家的消息
- **Game State**：纯游戏世界与对话后果，只包含长期有效、需要参与后续推演的状态
- **Game Save**：可持久化恢复的存档快照。主体是 Game State 加恢复所需元数据，但不包含运行态后台任务信息
- **Game Session**：运行时会话容器。持有 Game Save / Game State，并额外承载流式请求、后台准备、排队消息、并发控制等临时状态
- **World State**：游戏世界以及玩家角色的状态，简单来讲就是 Game State 去掉对话记录换成 World State Tool 运行记录

Game State 术语：
- **Visual Description**：用来记录某地范围内，确定性数据（比如 OSM）未呈现而让 LLM 自由发挥的地方。
  - **Outdoor Visual Description**
    - 内容为以列表形式记录某一经纬度为 index、半径300米范围内的 World State 数据（包括 OSM 和游戏内的物品、容器等数据）未呈现，但在过往 LLM 对话中提及的细节
    - 处于玩家300米范围内的 Outdoor Visual Description 都会以附带极坐标方位的形式呈现给 LLM，作为事实来源
    - 生成时有两种途径
      - 玩家距离最近的 Outdoor Visual Description 超过300米了，以玩家所在坐标为基准记录
      - （TODO）LLM 在概览 Book Message 时，认为某些事实性细节假如在只提供 OSM 数据的情况下无法复现。这时会以该细节所对应的建筑的中心坐标为基准记录
  - **Level Visual Description**
    - 内容与 Outdoor Visual Description 类似，但记录的 index 是某建筑某楼层某 Sector，且一次性涵盖整个 Sector
    - Sector 是指按边长100m（也就是外接圆半径100m）的六边形网格进行遮罩后，切分出来之后吸收细微区域形成的小区域。如果建筑不大，一个 Level 就只会有 Sector
    - 网格仅仅以该建筑所在面，不是全球统一网格。如果建筑面积达到阈值，优先以网格线经过建筑中心点的方式设置网格

（TODO）游戏建筑术语：
- **Theme**：程序随机选择的，为该建筑或建筑某一部分添加效果的描述。比如某个民宅正在办派对，后续生成时就可能添加派对描述，甚至在建筑里生成更多派对用品与食物
  - 大多数情况下都会是默认，因此 Theme 可以理解为用来生产特殊事件
- **Schema**：只存在于 Game State 内部，直接用于 LLM 生成建筑结构的数据。
  - **Building Schema**：建筑的 Schema，包含建筑的 Theme 与各个楼层的 Schema
  - **Level Schema**：楼层的 Schema，包含楼层的 Theme 与该楼层的 Sector Schema
  - **Sector Schema**：区域的 Schema，包含 Room Schema 与 Suite Schema
  - **Room Schema**
  - **Suite Schema**
  - **Subroom Schema**
- **Category**：建筑的大的类型，比如图书馆 Category，独栋房屋 Category
- **Pattern**：预设的建筑里的主要功能房间或主要楼层，可以认为是 Building Schema 的前体。每个大类的建筑都有一套 Pattern，比如图书馆大类包含藏书室、电脑房、讨论室等各种房间，以及楼层上的 Pattern 比如高层酒店大类有地面层、住房层等。
  如果建筑本身较标准，那么可以直接用程序从 Pattern 生成 Building Schema，否则就需要把 Pattern、建筑本身 OSM 信息发给 LLM，进行分配。
  - **Pattern Distribution**：如果建筑本身是多体建筑，或者建筑因面积很大拆分为了多个 Sector，每个子建筑/Sector肯定不会包含 Pattern 中的全部功能。因此就需要这个 Pattern Distribution 指定各个子建筑/Sector中没有哪些功能

## 游戏流程

1. 玩家点击开始游戏后，进入游戏初始化流程。从经纬度数据读取 OSM 然后生成 Scene Prompt，让一个专门的 Agent 生成开场 Book Message
2. 每次生成 Book Message 时，会先以 stream 的形式把文本增量发给前端
3. Book Message stream 完成后，先立即提交本轮 Game Save，再由另一个 Agent 根据 Book Message 撰写或者更新 Visual Description
  - 为了更短的互动前静止时间，Visual Description 不再阻塞 Book Message 的送达
  - 在 Visual Description 工作完成之前，只允许暂存 1 条下一回合的 User Message；若队列已占满，则拒绝新的消息
  - 当 Visual Description 准备完毕后，排队中的下一条消息才会进入下一回合
4. 玩家发送信息之后，先由 Game State 管理者 Agent 专门处理 Game State
5. Game State 处理完毕后，处理结果以及玩家的周遭信息会以 syth tool return 的形式给到剧本主持人，生成 Book Message 并 stream 给前端
5.

## 建筑生成逻辑

1. 用 OSM tags 以及建筑内包含的所有 POI 对建筑进行分类：
  - 分类结果不一定是单一类型，也可以是复合类型。比方说“图书馆 - 内含 咖啡厅”
  - 如果是非常标准的建筑，比如独栋民宅、独立加油站，可以直接程序给出分类结果
  - 如果缺少信息，则额外获取获取短距离范围内的 OSM Scene Prompt，以及此范围内已有的建筑蓝图，交给 LLM 进行分类
  - 如果是多体建筑，则所有建筑作为一个整体，再查看信息是否足够，然后走程序分类/LLM 分类的分支
2. 根据分类结果，程序随机选择一套基础 Pattern，然后生成 Pattern Distribution
  - 如果是非常标准的独栋建筑，比如独栋酒店、办公楼，不存在分配问题，可以直接下一步程序生成 Building Schema
  - 如果是多体建筑，则需要让 LLM 把基础 Pattern 中的功能分配到多个建筑中（会提供各个建筑的 OSM tags 与所含 POI 作为参考）
  - 如果是超大的楼层建筑，则需要按六边形网格切分 Sector，然后类似多体建筑那样把 Pattern 中的功能进行分配（会提供各个 Sector 所含的 POI 作为参考）
3. Pattern 或 Pattern Distribution 便可以直接用程序生成 Building Schema 了：
  - 添加随机的 Suite Schema，比如仅仅指定为公寓或酒店后，内部的套房
  - 添加零碎 Room Schema，比如办公室、厕所、清洁室、储藏室等
  - 添加出入口和楼层间通道、多体建筑之间的通道


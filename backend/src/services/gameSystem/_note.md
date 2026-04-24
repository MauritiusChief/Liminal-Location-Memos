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
  - **Field Visual Description**
    - 内容为以列表形式记录某一经纬度为 index、半径300米范围内的 World State 数据（包括 OSM 和游戏内的物品、容器等数据）未呈现，但在过往 LLM 对话中提及的细节
    - 处于玩家300米范围内的 Field Visual Description 都会以附带极坐标方位的形式呈现给 LLM，作为事实来源
    - 生成途径：玩家距离最近的 Field Visual Description 超过300米了，以玩家所在坐标为基准记录
  - **Exterior Visual Description**
    - 与 Field Visual Description 类似，内容为列表形式半径300米范围内 LLM 对话中与建筑相关的细节，此时 index 为建筑的id。
    - 生成途径：LLM 在概览 Book Message 时，如果某些细节与建筑有关，就会以该细节所对应的建筑id为基准进行记录（需要 LLM 辨认属于哪个建筑）
  - **Sector Visual Description**
    - 内容与 Field Visual Description 类似，但记录的 index 是某建筑某楼层某 Sector，且一次性涵盖整个 Sector
    - 只有所在 Sector 的 Visual Description 才会激活
- **Sector**：是指按边长100m（也就是外接圆半径100m）的六边形网格进行遮罩后，切分出来之后吸收细微区域形成的小区域。如果建筑不大，一个 Level 就只会有一个 Sector
  - 网格仅仅以该建筑所在面，不是全球统一网格。如果建筑面积达到阈值，优先以网格线经过建筑中心点的方式设置网格
- **Indoor Location**：本意是指一组特定的 建筑id-楼层号-房间id，但在 Game State 的 activeIndoorLocations 中也用来记载当前玩家可看到的范围。
  - activeIndoorLocations 决定关系如下：默认情况下只能看到所在 Sector 的普通房间与套房表层。特殊情况下：
    - 处在楼梯口等，可以看见相邻楼层的垂直连接处，比如楼梯间或者阁楼
    - 破坏了视觉遮挡的情况下，可以看到套房内部的子房间
    - 破坏了视觉遮挡的情况下，可以看到 internal access 相连的另一栋建筑的 internal access 另一端房间
  - activeIndoorLocations 不决定可互动关系，玩家总是只能和所在的 Indoor Location 互动

（TODO）游戏建筑术语：
- **Theme**：程序随机选择的，为该建筑或建筑某一部分添加效果的描述。比如某个民宅正在办派对，后续生成时就可能添加派对描述，甚至在建筑里生成更多派对用品与食物
  - 大多数情况下都会是默认，因此 Theme 可以理解为用来生产特殊事件
- **Schema**：只存在于 Game State 内部，直接用于 LLM 生成建筑结构的数据。
  - **Building Schema**：建筑的 Schema，包含各个楼层的 Schema
  - **Level Schema**：楼层的 Schema，包含该楼层的 Sector Schema
  - **Sector Schema**：区域的 Schema，包含 Room Schema 与 Suite Schema
  - **Room Schema**
  - **Suite Schema**
  - **Subroom Schema**
- **Category**：建筑的大的类型，比如图书馆 Category，独栋房屋 Category
  - **Category Base Schema**：每个大类（Category）的建筑的 Schema 通用基板，不同的 Pattern 就是在这个基板上增加房间种类，形成多样化的 Schema
  - **Category Schema**：只存在于 Schema 构建阶段的辅助 Schem，可以认为是 Building Schema 的前体。在 Category Base Schem 上应用 Pattern 而产生，包含全面的功能信息与各功能的楼层信息。
- **Pattern**：预设的建筑里的主要功能房间或主要楼层。每个大类（Category）的建筑都有一套或几套 Pattern，比如图书馆大类包含藏书室、电脑房、讨论室等各种房间，以及楼层上的 Pattern 比如高层酒店大类有地面层、住房层等。
  - **Pattern Distribution**：如果建筑本身是多体建筑，每个子建筑肯定不会包含 Pattern 中的全部功能。因此就需要这个 Pattern Distribution 指定各个子建筑中没有哪些功能（或者说，哪些功能在一个子建筑拥有之后便可服务整个建筑）
- **Sector Distribution**：完成 Category Schem 之后，如果建筑/子建筑的楼层空间非常大，那么就要套用 Sector 分区规则切分。然后，对每个 Sector 套用类似的 Pattern Distribution 的分配（哪些功能在一个区域拥有之后便可服务整个楼层）

## 游戏流程

### 开局回合

0. 玩家点击开始游戏后，进入游戏初始化流程。从经纬度数据读取 OSM 然后生成 Scene Prompt，让 Book Composer (Agent) 生成开场 Book Message
1. 生成初始 Book Message 时，会先以 stream 的形式把文本增量发给前端
2. Book Message stream 完成后，先立即提交本轮 Game Save，再由 Visual Describer (Agent) 根据 Book Message 和已有的世界状态撰写/更新 Visual Description
  - 为了更短的互动前静止时间，Visual Description 不再阻塞 Book Message 的送达
  - 在 Visual Description 工作完成之前，只允许暂存 1 条下一回合的 User Message；若队列已占满，则拒绝新的消息
  - 当 Visual Description 准备完毕后，排队中的下一条消息才会进入下一回合

### 常规回合

1. 玩家发送信息，先由 Game State Manager (Agent) 专门处理 Game State，获取包括对话记录在内的全量游戏状态，产出多个顺序进行的 Game State Tool Call
2. Game State 处理完毕后，处理结果以及玩家的周遭信息会以 syth tool return 的形式给到 Book Composer (Agent)，生成 Book Message 并 stream 给前端
3. 与开局回合相似的 Visual Describer (Agent) 流程

## 建筑生成逻辑

1. 用 OSM tags 以及建筑内包含的所有 POI 对建筑进行分类：
  - 分类结果不一定是单一类型，也可以是复合类型。比方说“图书馆 - 内含 咖啡厅”
  - 如果是非常标准的建筑，比如独栋民宅、独立加油站，可以直接*程序*给出分类结果
  - 如果缺少信息，则额外获取获取短距离范围内的 OSM Scene Prompt，以及此范围内已有的建筑蓝图，交给 *LLM* 进行分类
  - 如果是多体建筑，则所有建筑作为一个整体，再查看信息是否足够，然后走程序分类/LLM 分类的分支
2. 根据分类结果，*程序*随机选择一套基础 Pattern
3. 从 Pattern 视情况生成 Pattern Distribution
  - 如果*程序*判断是非常标准的独栋建筑，比如独栋酒店、办公楼，不存在分配问题，可以直接下一步
  - 如果是多体建筑，则需要让 *LLM* 把 Pattern 中的功能分配到多个建筑中（会提供各个建筑的 OSM tags 与所含 POI 作为参考）生成 Pattern Distribution
4. 在 Category Base Schem 上应用 Pattern 或 Pattern Distribution，结合建筑楼层信息生成 Category Schema
  - 如果是多层建筑，那么会读取 Category Schem 中每个功能所偏好的楼层（底层、顶层）和楼层分布频率（每一层都有、隔一层有一个），细化到每个楼层的程度（不涉及房间数量、出入口与通道、 套房内容的敲定）
5. 从 Category Schema 视情况生成 Sector Distribution
  - 如果*程序*判断面积不大，则不需要切分为 Sector，直接下一步
  - 面积较大的话则需要先按六边形网格切分 Sector，然后 *LLM* 把 Category Schema 中单一楼层的功能分配到多个 Sector 中（会提供各个 Sector 的方位、外部的附近道路或设施、所含的 POI 作为参考）
6. Category Schema 中所没有的信息的补完工作
  - 根据楼层或者 Sector 面积填补各个房间的数量信息，或者根据房间的类型随机决定数量
  - 填补随机的 Suite Schema，比如仅仅指定为公寓或酒店后，内部的套房
  - 添加出入口和楼层间通道、多体建筑之间的通道

> 例子1：way/123
> 1. 程序内判断：building=house, Scene Object 没有查找到停车场，随机分类为了“住宅 - 内含 车库”（Category: house & garage）
> 2. 程序随机选择一个 Pattern，因为 way/123 面积较小，随机到了“单卧室”
> 3. 程序内判断：way/123 不是 relation 建筑，不存在 Pattern Distribution 问题，Pattern 内部所有功能房间全部给到 way/123
> 4. 程序根据 Category “住宅 - 内含 车库”，在其 Category Base Schema 基础上应用 Pattern “单卧室”，生成了 Category Schema。
> 5. 程序内判断：way/123 没有多楼层，Category Schema 内所有房间种类全部给到 1 楼，“每个楼层必有”的东西也只用设置 1 次
> 6. 程序内判断：way/123 面积较小，1 楼的房间不用再按 Sector Distribution 细分

生成完 Building Schema 之后便用此生成建筑，过程还有
- （TODO）为建筑、楼层、房间随机分配特殊事件主题
- 有些套房或者楼层的 *_wild 房间在此时还需要随机生成一下



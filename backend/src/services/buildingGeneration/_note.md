# Building Generation 说明

这个模块负责从 OSM 地物与周边信号生成建筑内部结构，并把结构转成游戏运行期可消费的建筑记录。

## 建筑生成术语

- **Theme**：程序随机选择的，为该建筑或建筑某一部分添加效果的描述。比如某个民宅正在办派对，后续生成时就可能添加派对描述，甚至在建筑里生成更多派对用品与食物。
  - 大多数情况下都会是默认，因此 Theme 可以理解为用来生产特殊事件。
- **Schema**：只存在于 Game State 内部，直接用于 LLM 生成建筑结构的数据。
  - **Building Schema**：建筑的 Schema，包含各个楼层的 Schema
  - **Level Schema**：楼层的 Schema，包含该楼层的 Sector Schema
  - **Sector Schema**：区域的 Schema，包含 Room Schema 与 Suite Schema
  - **Room Schema**
  - **Suite Schema**
  - **Subroom Schema**
- **Sector**：是指按边长100m（也就是外接圆半径100m）的六边形网格进行遮罩后，切分出来之后吸收细微区域形成的小区域。如果建筑不大，一个 Level 就只会有一个 Sector。
  - 网格仅仅以该建筑所在面，不是全球统一网格。如果建筑面积达到阈值，优先以网格线经过建筑中心点的方式设置网格。
- **Category**：建筑的大的类型，比如图书馆 Category，独栋房屋 Category。
  - **Category Base Schema**：每个大类（Category）的建筑的 Schema 通用基板，不同的 Pattern 就是在这个基板上增加房间种类，形成多样化的 Schema。
  - **Category Schema**：只存在于 Schema 构建阶段的辅助 Schem，可以认为是 Building Schema 的前体。在 Category Base Schem 上应用 Pattern 而产生，包含全面的功能信息与各功能的楼层信息。
- **Pattern**：预设的建筑里的主要功能房间或主要楼层。每个大类（Category）的建筑都有一套或几套 Pattern，比如图书馆大类包含藏书室、电脑房、讨论室等各种房间，以及楼层上的 Pattern 比如高层酒店大类有地面层、住房层等。
  - **Pattern Distribution**：如果建筑本身是多体建筑，每个子建筑肯定不会包含 Pattern 中的全部功能。因此就需要这个 Pattern Distribution 指定各个子建筑中没有哪些功能（或者说，哪些功能在一个子建筑拥有之后便可服务整个建筑）。
- **Sector Distribution**：完成 Category Schem 之后，如果建筑/子建筑的楼层空间非常大，那么就要套用 Sector 分区规则切分。然后，对每个 Sector 套用类似的 Pattern Distribution 的分配（哪些功能在一个区域拥有之后便可服务整个楼层）。

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

生成完 Building Schema 之后便用此生成建筑，过程还有：
- （TODO）为建筑、楼层、房间随机分配特殊事件主题
- 有些套房或者楼层的 *_wild 房间在此时还需要随机生成一下

## 新添一类建筑所需的步骤

1. 定义 Category、Base Schema 与 Pattern
  - 如果新建筑有独立文件，参考 `buildingHouse.ts` / `buildingApartment.ts` 建立 `CategoryDefinition`。
  - Base Schema 放该类别一定具备的功能；Pattern 放可变化的主要功能房间或楼层方案。
  - 若某类建筑本体就是单一房间功能，可使用 `base_schema.rooms.self` 表达。

2. 补充分类型判断
  - 在 `buildingSchema.ts` 中把明确的 OSM `building` tag、contained POI 或其他稳定信号加入 explicit 分类。
  - 如果只能通过周边信号、面积、楼层、邻居建筑等判断，则新增 ambiguous 分类函数。
  - 只有分类逻辑需要新数据库信号时，才新增或修改 `buildingGeneration/sql/...` 查询，并在对应工具函数中读取。

3. 接入 Pattern 选择
  - 为新类别提供 `selectXPatternKey()` 或复用简单类别直接返回 Category Key 的策略。
  - 在 `selectPatternKey()` 中按 Category Key 分派，保证 `candidate.patternRecord` 能记录所选 Pattern。

4. 构建 Category Schema
  - 实现 `buildXCategorySchemaFromDistribution()`，把应用了 Pattern Distribution 的房间定义映射到楼层。
  - 将新类别接入 `buildCategorySchemaFromDistribution()`，按主 Category 分支返回对应 `CategorySchema`。

5. 完成 Building Schema 收尾
  - 实现或复用 `finishXBuildingSchema()`，补齐房间数量、suite/subRoom、入口、垂直通道和最终 `category` 字段。
  - 将新类别接入 `finishBuildingSchema()`，确保输出 `Record<FeatureId, BuildingSchema>`。

6. 注册类别定义
  - 在 `buildingSchema.ts` 的 `ALL_CATEGORIES` 加入新 Category。
  - 如果该类属于住宅体系或复用住宅工具，确认 `registerResidentialCategoryDefinitions()` 生成的 category/pattern key 池符合预期。

7. 加测试并验证调试出口
  - 为分类、Pattern 选择、Category Schema 构建和最终 Building Schema 各加至少一个聚焦测试。
  - 用 `/debug/building-schema` 或前端 Building Schema Debug 页面验证真实 featureId 的输出结构。
  - 运行 `npx tsc -p src/tsconfig.src.json --noEmit` 与相关 Jest 测试。


## 重构计划

* gameChat.ts 裁切 messageHistory 时的注释（包括 generateBookMessage() 和 gameStateManager() ）
* Game State 已经定义为 Game Session 的同义词，所以 toGameStatePrompt() 函数以及相应的 "gameState/gameStatePrompt" 也要改名
  * 暂定改名为 Player State，需要同步写入 _note.md
* gameMovement.ts 函数合并入 geometry.ts 和 gameSystem/

## 近期计划

* 添加玩家的视野朝向功能
  * 这对 Micro Grid 可能很困难，甚至要重写 SQL
* 添加通过海拔高度 API 与 ele 标签计算建筑实际高度的功能

* 添加记忆功能/工具，可以把觉得重要的东西记下来。
* 范围从小到大依次读取地图，避免一次性读取太多地图，信息量太大。
* 主对话再调整一下，如果不是特别要求查看周围，就再压缩环境描写、扩充“你”的动作与行为描写，让被压缩的环境描写显得像是匆匆走过没有细看
* 考虑如何实现汽车这样 10 分钟就能走 10 公里的速度如何实现
  * 大概率得想办法长距离组装线状特征，然后沿着线状特征的坐标行进
  * 或者调整调用工具的模式，进行连续调用工具快速移动（然后每次调用工具根据速度略微描写环境，速度越快描写越少）

## 长远计划

* 改用 stream，避免超长时间等待
* 玩家行为反向存入数据库的方法（比如修建某些东西）
  * 以5m²为尺寸填格子，全球统一网格

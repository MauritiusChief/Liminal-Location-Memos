# TODO 计划大全

## 修 bug

* 在数据库为空的情况下开局，会识别不到室内，默认变成室外。

## 重构计划

* backend/routes/api.ts 拆分为小的文件，不要全挤在一起

## 近期计划

* 添加 LLM 在游戏过程中生成 template 甚至 building pattern 的功能

* 提示 LLM 如果信息不足，不要总是令玩家行为得逞，而是间接提示玩家需要更多信息

* 添加建筑生成功能，具体在 buildingGeneration/_note 中
  * 公寓添加公寓设施的配套生成逻辑
  * 警察局、消防局
  * 商业建筑
  * ...

* 添加记忆功能/工具，可以把觉得重要的东西记下来。
* 范围从小到大依次读取地图，避免一次性读取太多地图，信息量太大。
* 主对话再调整一下，如果不是特别要求查看周围，就再压缩环境描写、扩充“你”的动作与行为描写，让被压缩的环境描写显得像是匆匆走过没有细看
* 考虑如何实现汽车这样 10 分钟就能走 10 公里的速度如何实现
  * 大概率得想办法长距离组装线状特征，然后沿着线状特征的坐标行进
  * 或者调整调用工具的模式，进行连续调用工具快速移动（然后每次调用工具根据速度略微描写环境，速度越快描写越少）

* 前端美化
  * streamInitialBookMessage 无美化
  * gameStateRouter 输出前：_你正在世界中活动_
  * gameStateManager 输出前：根据初筛结果变化-_你回想起刚刚的战斗_/_你回想起刚刚的收获_/_你回想起路途中的见闻_/...
  * streamRegularBookMessage 回复输出前，思索内容输出时：_思绪在脑海里翻涌_(十六进制数字)
  * finalizeVisualDescription 完成前：_笔迹正在风干_

## 长远计划

* 玩家行为反向存入数据库的方法（比如修建某些东西）
  * 以5m²为尺寸填格子，全球统一网格
* 拿到纸和笔之后，可以画地图
  * 画的图仅有点和线，点的话放一个图标表示建筑

* 添加渐进式披露或者路由者，减缓单次对话负担
* 用简单路由者决定是否启用哪个 Visual Describer，而不是全凭自觉

* gameChat 当中把 Scene Object 也加入流转，避免反复 sql 消耗性能

* Open-Meteo Land Cover API
  * 获取地表覆盖
  * https://archive-api.open-meteo.com/v1/era5-land
* Open-Meteo API
  * 气候、降水
 * https://api.open-meteo.com/v1/forecast
* Open-Elevation API
  * 经纬度返回海拔
  * https://api.open-elevation.com/api/v1/lookup?locations=LAT,LON

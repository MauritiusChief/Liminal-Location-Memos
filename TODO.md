# TODO 计划大全

## 重构计划

* backend/routes/api.ts 拆分为小的文件，不要全挤在一起

## 近期计划

* 允许 Game State Manager 渐进披露工具信息、已有的物品定义信息等，需要添加真正的多轮对话功能了
* 添加物品与容器生成功能后，记得提醒 Visual Describer 不要把物品信息也当做细节信息了

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

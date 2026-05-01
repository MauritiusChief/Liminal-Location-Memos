# Object Generation

该模块负责生成物品

## 术语

- **Object**: 最笼统的概念，目前包括 Item, Vehicle, Furniture
- **Item**: 较小的能拿走、穿着的东西，通常意义上的普通物品
- **Furniture**: 指代有特定功能的且较大的东西(不同于Item), 不仅仅是家具，也包括大型机器等东西
- **Vehicle**: 有轮子或者其他可移动手段的 Furniture，小到购物车大到游轮都算
- **Cardboard**: 缺乏细节的类似占位符的存在。其意义是：LLM 不擅长可控的随机，而程序不擅长填充细节，那就先让程序生成可控的随机结果，把 Book Composer 糊弄过去之后再让按需让 LLM 填充细节
  - 其不需要模板那样的可继承性和通用性，也不需要模型那样合理的细节，就像是硬纸板做的仅仅只有最低可辨认度的纸板模型，因此得名
  - **Cardboard Loots**: 一大堆各式各样的物品，包含随机选择种类与数量范围的 Cardboard Item 和这堆物品的 theme
  - **Cardboard Item**: 单个缺乏细节的物品，详细程度也有区别
  - **Cardboard Furniture**: 内部可能包含 Cardboard Loots
  - **Cardboard Vehicle**: 内部可能包含 Cardboard Loots
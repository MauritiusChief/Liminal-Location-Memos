# Object Generation

该模块负责生成物品

## 术语

- **Object**: 最笼统的概念，目前包括 Item, Vehicle, Furniture
- **Item**: 较小的能拿走、穿着的东西，通常意义上的普通物品
- **Furniture**: 指代有特定功能的且较大的东西(不同于Item), 不仅仅是家具，也包括大型机器等东西
- **Vehicle**: 有轮子或者其他可移动手段的 Furniture，小到购物车大到游轮都算
- **Cardboard**: 缺乏细节的类似占位符的存在。其意义是：LLM 不擅长可控的随机，而程序不擅长填充细节，那就先让程序生成可控的随机结果，把 Book Composer 糊弄过去之后再让按需让 LLM 填充细节
  - 其不需要模板那样的可继承性和通用性，也不需要模型那样合理的细节，就像是硬纸板做的仅仅只有最低可辨认度的纸板模型，因此得名
  - **Cardboard Loots**: 一大堆各式各样的物品，也可以理解为战利品表
    - 纸板状态：有名字、参考质量-体积-长度范围，若由 LLM 创建则多一条软性提示
    - 细化后果：转化为多个 Cardboard Item，软性提示继承到所有 Cardboard Item 内
  - **Cardboard Item**: 单个缺乏细节的物品，详细程度也有区别
    - 纸板状态：有功能(用在 Cardboard Furniture/Vehicle 内)/名字(单独获取、Cardboard Loots 细化时)、参考质量-体积-长度范围，可能有软性提示(继承得来或由LLM写下)
    - 细化后果：名字、固定的质量-体积-长度、作为其更细组成部分的 Cardboard Item/Loots 或/与形状-材料定义
      - 比如，一盒子弹被细化后便是纸板(材料)-盒子(形状)与多个子弹；如果有机会，子弹再被细化，其是火药(材料)-粉末(形状)+黄铜(材料)-弹壳(形状)+铅(材料)-弹头(形状)
  - **Cardboard Furniture**:
    - 纸板状态：有名字、参考质量-体积-长度范围、预制功能 Carboard Item，可能有 Cardboard Loots，若由 LLM 创建则多一条软性提示
    - 细化后果：功能 Cardboard Item 被替换为细化过的、能满足此功能的 Item，或者 Cardboard Loots 被细化
  - **Cardboard Vehicle**:
    - 纸板状态：有名字、参考质量-体积-长度范围、预制功能 Carboard Item，可能有 Cardboard Loots，若由 LLM 创建则多一条软性提示
    - 细化后果：功能 Cardboard Item 被替换为细化过的、能满足此功能的 Item，或者 Cardboard Loots 被细化
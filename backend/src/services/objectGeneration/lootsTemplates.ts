/**
 * 战利品表模板定义。
 *
 * 与 furniture/item 模板类似，Loots 模板定义从某个 Cardboard Loots 中可以细化出哪些物品。
 * 每个物品条目带有独立的参考质量/体积/长度（aprx MVL），
 * refine_loots 工具按预算逐一生成物品直到 Loots 的 aprxMVL 预算耗尽。
 */
export interface LootsTemplate {
  id: string;
  keyword: string; // 供以后关键字检索用
  description: string; // 给 LLM 看的描述
  items: LootsItemEntry[];
}

export interface LootsItemEntry {
  id: string;
  name: string; // 物品名称
  description: string; // 物品描述
  aprxMass: number; // 每单位参考质量(kg)
  aprxVolume: number; // 每单位参考体积(L)
  aprxLength: number; // 每单位参考长度(cm)
  /** 软容器标记：细化成物品后是否自动标记为软容器 */
  isSoftContainer?: boolean;
}

export const LOOTS_TEMPLATES: LootsTemplate[] = [
  {
    id: "groceries",
    keyword: "杂货食品日常饮食蔬果调味料",
    description: "常规家庭的日常饮食，包括乳制品、蔬果、主食与调味料等",
    items: [
      { id: "milk", name: "牛奶", description: "一盒全脂牛奶", aprxMass: 1.0, aprxVolume: 1.0, aprxLength: 25 },
      { id: "bread", name: "面包", description: "一条切片白面包", aprxMass: 0.5, aprxVolume: 2.0, aprxLength: 30 },
      { id: "eggs", name: "鸡蛋", description: "一打鸡蛋（12枚）", aprxMass: 0.6, aprxVolume: 0.6, aprxLength: 15 },
      { id: "butter", name: "黄油", description: "一条无盐黄油", aprxMass: 0.25, aprxVolume: 0.25, aprxLength: 12 },
      { id: "apple", name: "苹果", description: "一颗红富士苹果", aprxMass: 0.2, aprxVolume: 0.3, aprxLength: 8 },
      { id: "tomato_sauce", name: "番茄酱", description: "一瓶番茄酱", aprxMass: 0.5, aprxVolume: 0.5, aprxLength: 20 },
      { id: "rice", name: "大米", description: "一袋大米（2kg装）", aprxMass: 2.0, aprxVolume: 2.5, aprxLength: 30 },
      { id: "pasta", name: "意大利面", description: "一包干意大利面", aprxMass: 0.5, aprxVolume: 1.5, aprxLength: 25 },
      { id: "cereal", name: "麦片", description: "一盒早餐麦片", aprxMass: 0.4, aprxVolume: 2.0, aprxLength: 25 },
      { id: "cooking_oil", name: "食用油", description: "一瓶菜籽油", aprxMass: 1.0, aprxVolume: 1.0, aprxLength: 25 },
    ],
  },
  {
    id: "beers",
    keyword: "啤酒饮料酒类速冻快餐冰镇",
    description: "冰镇啤酒和其他快餐与速冻食品",
    items: [
      { id: "beer_can", name: "罐装啤酒", description: "一罐冰镇啤酒（330ml）", aprxMass: 0.35, aprxVolume: 0.33, aprxLength: 12 },
      { id: "beer_bottle", name: "瓶装啤酒", description: "一瓶精酿啤酒", aprxMass: 0.5, aprxVolume: 0.5, aprxLength: 20 },
      { id: "frozen_pizza", name: "冷冻披萨", description: "一盒速冻披萨", aprxMass: 0.8, aprxVolume: 3.0, aprxLength: 30 },
      { id: "frozen_burger", name: "冷冻汉堡", description: "一盒速冻汉堡肉饼", aprxMass: 0.6, aprxVolume: 1.5, aprxLength: 20 },
      { id: "ice_cream", name: "冰淇淋", description: "一桶香草冰淇淋", aprxMass: 0.5, aprxVolume: 1.0, aprxLength: 15 },
      { id: "soda", name: "汽水", description: "一罐可乐", aprxMass: 0.35, aprxVolume: 0.33, aprxLength: 12 },
    ],
  },
];

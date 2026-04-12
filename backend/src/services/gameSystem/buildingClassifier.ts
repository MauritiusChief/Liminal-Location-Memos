

//#region 常量

/**
 * 兼作分类结果（单独把 key 提取出来）和 Pattern 记录
 * 注：后续添加 schema trivial 然后生成 Building Scheme 时，schema trivial 是整个 Category 通用的，所以把独特内容在 Pattern 里加好，或者干脆新立另一个 Category
 */
const RESIDENTIAL_PATTERNS = {
  independent_house: { desc: "独栋住宅",
    // TODO 添加随机删除与合并条件
    schema_trivial: { bath_room: { desc: "包含厕所的浴室" }, living_room: { desc: "客厅" }, kitchen: { desc: "带餐厅的厨房" }},
    patterns: {
      small: { // 单卧室
        bedroom: {}
      },
      medium: { // 双卧室
        master_bedroom: { desc: "主卧" }, master_bathroom: { desc: "主卧浴室" },
        second_bedroom: { desc: "次卧或小孩房" },
        closet: { desc: "储藏室" }, laundry: {}
      },
      large: { // 三卧室
        master_bedroom: { desc: "主卧" }, master_bathroom: { desc: "主卧浴室" },
        second_bedroom: { desc: "次卧或小孩房" },
        closet: { desc: "储藏室" }
      },
    },
  },
  masion: { desc: "独栋豪宅" },
  individual_garage: { desc: "独立车库", patterns: {self_room: true} },
  tool_shed: { desc: "工具屋", patterns: {self_room: true} },
}

//#region 主函数


// 根据详细的 osm tags 进行分类

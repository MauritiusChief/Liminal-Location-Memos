

//#region 常量

/**
 * 兼作分类结果（单独把 key 提取出来）和 Pattern 记录
 * 注：后续添加零碎房间生成 Building Scheme 时，是整个 Category 通用的，所以把独特内容在 Pattern 里加好，或者干脆新立另一个 Category
 */
const RESIDENTIAL_PATTERNS = {
  independent_house: { desc: "独栋住宅",
    patterns: {
      small: {
        master_bedroom: {}
      },
      medium: {
        master_bedroom: { desc: "主卧"},
        second_bedroom: { desc: "次卧"},
        closet: {}
      },
      large: {
        master_bedroom: {},
        second_bedroom: {},
      },
    },
  },
  individual_garage: { desc: "独立车库",
    patterns: {self_room: true},
  },
  tool_shed: { desc: "工具屋",
    patterns: {self_room: true},
  }
}

//#region 主函数


// 根据详细的 osm tags 进行分类

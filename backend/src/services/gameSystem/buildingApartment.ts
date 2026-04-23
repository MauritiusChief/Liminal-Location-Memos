import type { BuildingCandidate, BuildingSchema, CategoryDefinition, CategoryLevelSchema, CategoryRoomSchema, CategorySchema, RoomSchema, SectorDistributionSchem, SuiteSchema } from "./buildingClassifier.js";
import { pickRandom, weightedBoolean, type PatternDistribution } from "./buildingClassifier.js";
import type { FeatureId } from "../featureDetail.js";
import {
  ALL_LEVELS,
  APARTMENT_GROUND_ORDINARY_ROOM_AREA_SQM,
  APARTMENT_LEVELS_MIN,
  APARTMENT_SUITE_AREA_SQM,
  GROUND_LEVEL,
  isHouseDetermingFactorApartment,
  rangeNumbers,
  SMALL_APARTMENT_PATTERN_AREA_MAX_SQM,
  TOP_LEVEL,
  type HouseDetermingFactor,
} from "./buildingUtils.js";

type ApartmentSuiteRoomDefinition = {
  desc: string;
  chance?: number;
  count?: number;
};
type ApartmentSuiteTemplate = Record<string, ApartmentSuiteRoomDefinition>;

//#region 常量

// 公寓
export const APARTMENT_CATEGORY: CategoryDefinition = {
  desc: "公寓楼",
  base_schema: {rooms: {
    janitor_room: {desc: "清洁间", prefered: GROUND_LEVEL[0]},
    trash_room: {desc: "垃圾站", prefered: GROUND_LEVEL[0]},
    electrical_room: {desc: "配电间", prefered: ALL_LEVELS[0]},
    storage_unit: {desc: "迷你自存仓", prefered: GROUND_LEVEL[0], chance: 0.2},
  }},
  patterns: {
    studio_apt: {desc: "以小型单间公寓为主的公寓楼", rooms: {
      studio_suite: {desc: "单间公寓套房", prefered: ALL_LEVELS[0]},
    }},
    standard_apt: {desc: "以标准公寓套房为主的公寓楼", rooms: {
      standard_suite: {desc: "标准公寓套房", prefered: ALL_LEVELS[0]},
      studio_suite: {desc: "单间公寓套房", prefered: ALL_LEVELS[0], chance: 0.2},
    }},
  },
};

// 套房模板只描述套房内部有哪些子房间；具体数量在收尾阶段按套房数量折算。
export const APARTMENT_SUITE_TEMPLATES: Record<string, Record<string, ApartmentSuiteTemplate>> = {
  studio_suite: {
    studio: {
      living_room: { desc: "卧室、客厅、厨房一体空间" },
      bath_room: { desc: "带厕所浴室" },
    },
    seperate_bedroom: {
      bedroom_wild: { desc: "卧室类房间（可为卧室/儿童卧室/办公室）", count: 1 },
      living_room: { desc: "与厨房相连的客厅" },
      bath_room: { desc: "带厕所浴室" },
    },
  },
  standard_suite: {
    standard: {
      bedroom_wild: { desc: "卧室类房间（可为卧室/儿童卧室/办公室）", count: 2 },
      living_room: { desc: "客厅" },
      kitchen: { desc: "厨房" },
      bath_room: { desc: "带厕所浴室" },
      closet: { desc: "储物间", chance: 0.6 },
    },
    seperate_restroom: {
      bedroom_wild: { desc: "卧室类房间（可为卧室/儿童卧室/办公室）", count: 2 },
      living_room: { desc: "客厅" },
      kitchen: { desc: "带餐厅的厨房" },
      bath_room: { desc: "浴室" },
      rest_room: { desc: "厕所" },
      closet: { desc: "储物间", chance: 0.6 },
    },
  },
};
const APARTMENT_SUITE_KEYS = Object.keys(APARTMENT_SUITE_TEMPLATES)

const APARTMENT_FLOOR_DESCRIPTIONS: Record<string, string> = {
  ground_floor: "地面层",
  residential_floor: "住宅层",
};
const APARTMENT_FLOORS = Object.keys(APARTMENT_FLOOR_DESCRIPTIONS)

//#region Category 逻辑

/**
 * 判断一个建筑是否是“公寓楼”。
 *
 * 输入前提：
 * - 默认调用方已经确认候选属于住宅区
 *
 * 保守策略：
 * - 公寓只看稳定的面积与楼层信号；
 *
 * @param candidate 已缩小到住宅区范围内的建筑候选
 * @returns 分类结果；不属于公寓则返回 undefined
 */
export function isAmbiguousApartmentCategory(
  candidate: BuildingCandidate,
  factor: HouseDetermingFactor,
): string[] | undefined {
  if (!isHouseDetermingFactorApartment(candidate, factor)) return undefined;

  return weightedBoolean(3, 7)
    ? ["apartment", "apartment_utility"]
    : ["apartment"];
}

//#region Pattern 逻辑

export function selectApartmentPatternKey(candidate: BuildingCandidate): string {
  return pickRandom(determineApartmentPatternPool(candidate));
}

/**
 * 为公寓选择 Pattern 候选池。
 * 小体量或低楼层公寓允许出现单间公寓为主的布局；更大的公寓默认使用标准套房布局。
 * @param candidate 已确定为公寓的建筑候选
 * @returns 允许抽样的公寓 pattern 列表
 */
function determineApartmentPatternPool(candidate: BuildingCandidate): string[] {
  const { areaSqm, buildingLevels } = candidate;

  if ((areaSqm !== null && areaSqm <= SMALL_APARTMENT_PATTERN_AREA_MAX_SQM) || (buildingLevels !== null && buildingLevels <= 2)) {
    return ["studio_apt", "standard_apt"];
  }

  return ["standard_apt"];
}

//#####################
//#region C-Schema 逻辑
//#####################

/**
 * 公寓楼的 C-Schema 逻辑
 * 只保留 ground_floor 与 residential_floor 两种楼层语义：
 * - ground_floor 表示入口层和整栋公寓共享的公共/设备空间；
 * - residential_floor 表示二层及以上所有可居住楼层。
 * @param appliedBaseSchema
 * @param candidate
 * @returns
 */
export function buildApartmentCategorySchemaFromDistribution(
  appliedBaseSchema: PatternDistribution,
  candidate: BuildingCandidate,
): Record<FeatureId, CategorySchema> {
  if (!candidate.categoryRecord) return {}
  // 公寓缺少楼层信息时保守按2层处理，保证存在 residential_floor。
  const buildingLevels = Math.max(APARTMENT_LEVELS_MIN, candidate.buildingLevels ?? APARTMENT_LEVELS_MIN);

  const result: Record<FeatureId, CategorySchema> = {}
  Object.entries(appliedBaseSchema).forEach(([featureId, roomDefs]) => {
    const levels: Record<string, CategoryLevelSchema> = {
      [APARTMENT_FLOORS[0]]: {
        description: APARTMENT_FLOOR_DESCRIPTIONS[APARTMENT_FLOORS[0]],
        span: [1],
        rooms: {},
      },
      [APARTMENT_FLOORS[1]]: {
        description: APARTMENT_FLOOR_DESCRIPTIONS[APARTMENT_FLOORS[1]],
        span: rangeNumbers(2, buildingLevels),
        rooms: {},
      },
    };

    Object.entries(roomDefs).forEach(([roomKey, definition]) => {
      if (definition.chance && 1 - definition.chance > Math.random()) return
      const levelKeys = resolveApartmentCategorySchemaLevelKeys(roomKey, definition.prefered);
      levelKeys.forEach((levelKey) => {
        levels[levelKey].rooms[roomKey] = {
          description: definition.desc ?? roomKey,
        };
      });
    });

    result[featureId] = {
      levels,
    }
  });

  return result
}

/**
 * 把公寓 Category 中的抽象位置收束到 ground_floor / residential_floor。
 * 所有 *_suite 固定进入居住层，同时复制到地面层作为候选；
 * 其他公共设施和设备房默认进入地面层。
 * @param roomKey
 * @param prefered
 * @returns 需要填充的公寓楼层 key
 */
function resolveApartmentCategorySchemaLevelKeys(
  roomKey: string,
  prefered: string | undefined,
): string[] {
  if (APARTMENT_SUITE_KEYS.includes(roomKey)) return APARTMENT_FLOORS;
  if (prefered === ALL_LEVELS[0]) return [APARTMENT_FLOORS[1]];
  if (TOP_LEVEL.includes(prefered ?? "")) return [APARTMENT_FLOORS[1]];
  return [APARTMENT_FLOORS[0]];
}

//################
//#region 收尾逻辑
//################

/**
 * 公寓楼(Apartment)的收尾逻辑
 * 普通公共房间继续输出 RoomSchema，*_suite 会在此阶段转为 SuiteSchema。
 * @param schemas
 * @param candidate
 * @returns
 */
export function finishApartmentBuildingSchema(
  schemas: Record<FeatureId, SectorDistributionSchem>,
  candidate: BuildingCandidate,
): Record<FeatureId, BuildingSchema>  {
  const result: Record<FeatureId, BuildingSchema> = {}
  const categoryKey = candidate.categoryRecord?.join('&') || '出错';
  Object.entries(schemas).forEach(([featureId, schema]) => {
    const levels: BuildingSchema["levels"] = Object.fromEntries(
      Object.entries(schema.levels).map(([levelKey, level]) => {
        const sectors = Object.fromEntries(
          Object.entries(level.sectors).map(([sectorKey, sector]) => {
            const rooms = resolveApartmentSectorRooms(sector.rooms);

            // 公寓入口与垂直交通是整栋建筑级能力，不属于任何单个套房。
            applyApartmentAccessRooms(candidate, levelKey, rooms);
            applyApartmentSuiteCapacity(candidate, levelKey, sector.area, rooms);

            return [sectorKey, {
              area: sector.area,
              centerPosition: sector.centerPosition,
              rooms,
            }];
          }),
        );

        return [levelKey, {
          description: level.description,
          span: level.span,
          sectors,
        }];
      }),
    );

    result[featureId] = {
      featureId,
      category: categoryKey,
      centerPosition: candidate.centerPosition,
      levels,
    };
  })
  return result
}

//#region 收尾辅助函数

/**
 * 将公寓的 CategoryRoomSchema 转为最终房间结构。
 * *_suite 在此处膨胀为 SuiteSchema 候选；具体数量和是否保留在容量校验阶段处理。
 * @param rooms
 * @returns
 */
function resolveApartmentSectorRooms(
  rooms: Record<string, CategoryRoomSchema>,
): Record<string, RoomSchema | SuiteSchema> {
  const result: Record<string, RoomSchema | SuiteSchema> = {}

  Object.entries(rooms).forEach(([roomKey, room]) => {
    if (APARTMENT_SUITE_KEYS.includes(roomKey)) {
      const suite = buildApartmentSuiteSchema(roomKey, room.description);
      result[roomKey] = {
        description: room.description,
        count: suite.count,
        subRooms: suite.subRooms,
      };
      return
    }

    if (roomKey === "storage_unit") {
      result[roomKey] = {
        description: room.description,
        count: Math.ceil(4 + Math.random() * 8), // 迷你自存仓一般有多个
        ...(room.access ? { access: room.access } : {}),
      };
      return
    }

    result[roomKey] = {
      description: room.description,
      count: 1,
      ...(room.access ? { access: room.access } : {}),
    };
  });

  return result;
}

/**
 * 从指定套房类型的模板池中抽样，把模板中的 desc/chance 转成最终子房间。
 * @param suiteKey suite 房间 key
 * @returns 可写入 BuildingSchema 的 SuiteSchema
 */
function buildApartmentSuiteSchema(
  suiteKey: string,
  description: string,
): SuiteSchema {
  const templates = APARTMENT_SUITE_TEMPLATES[suiteKey] ?? APARTMENT_SUITE_TEMPLATES[APARTMENT_SUITE_KEYS[0]];
  const templateKey = pickRandom(Object.keys(templates));
  const template = templates[templateKey];
  const subRooms = buildApartmentSuiteSubRooms(template);

  return { description, count: 1, subRooms };
}

function buildApartmentSuiteSubRooms(
  template: ApartmentSuiteTemplate,
): SuiteSchema["subRooms"] {
  const subRooms: SuiteSchema["subRooms"] = {};
  Object.entries(template).forEach(([roomKey, definition]) => {
    if (definition.chance && 1 - definition.chance > Math.random()) return;
    subRooms[roomKey] = {
      description: definition.desc ?? roomKey,
      count: definition.count ?? 1,
    };
  });

  return subRooms;
}

/**
 * 用单层面积与楼层粗略估算当前 level/sector 可容纳的“套房总数”。
 *
 * 一楼需要先按普通房间数量预留公共/设备/通道空间；如果剩余面积不足一套，
 * 收尾阶段会移除 Category Schema 中提前放入的一楼套房候选。
 *
 * 注意：返回值不是每一种套房各自的数量，而是该楼层该 sector 的总套房容量。
 * 多种套房之间的数量分配由 applyApartmentSuiteCapacity 继续处理。
 *
 * @param candidate 建筑候选，用于在 sector 面积缺失时回退到建筑面积
 * @param levelKey 当前楼层语义 key
 * @param sectorArea 当前 sector 的面积
 * @param rooms 当前 sector 已转换出的房间/套房候选
 * @returns 当前 level/sector 可分配给所有套房类型的总套数
 */
function determineApartmentSuiteCount(
  candidate: BuildingCandidate,
  levelKey: string,
  sectorArea: number,
  rooms: Record<string, RoomSchema | SuiteSchema>,
): number {
  if (levelKey === APARTMENT_FLOORS[0]) {
    const ordinaryRoomCount = countApartmentOrdinaryRooms(rooms);
    // 一楼通常有公共和设备空间，因此先给面积加随机浮动，再扣掉普通房间预算。
    const floorArea = (sectorArea || candidate.areaSqm || 0) * (1 - Math.random() * 0.4); // 添加浮动的面积，在 100% ~ 60% 浮动
    const suiteArea = floorArea - ordinaryRoomCount * APARTMENT_GROUND_ORDINARY_ROOM_AREA_SQM;
    return Math.max(0, Math.floor(suiteArea / APARTMENT_SUITE_AREA_SQM));
  }

  // 居住层缺少面积信息时使用 4 套公寓的面积作为保守回退，并至少保留 1 套。
  const floorArea = (sectorArea || candidate.areaSqm || APARTMENT_SUITE_AREA_SQM*4) * (1 - Math.random() * 0.4); // 添加浮动的面积，在 100% ~ 60% 浮动
  return Math.max(1, Math.floor(floorArea / APARTMENT_SUITE_AREA_SQM));
}

/**
 * 将套房候选按当前 level/sector 的容量落成最终数量。
 *
 * Category Schema 阶段只表达“这个楼层可能有这些套房类型”；
 * 收尾阶段才按面积计算总容量，并在多种套房类型之间随机拆分。
 * 分到 0 的套房类型会被删除，避免输出 count 为 0 的 SuiteSchema。
 *
 * @param candidate 建筑候选，用于面积回退
 * @param levelKey 当前楼层语义 key
 * @param sectorArea 当前 sector 面积
 * @param rooms 当前 sector 的最终房间表，会被原地更新
 */
function applyApartmentSuiteCapacity(
  candidate: BuildingCandidate,
  levelKey: string,
  sectorArea: number,
  rooms: Record<string, RoomSchema | SuiteSchema>,
): void {
  const suiteKeys = Object.keys(rooms).filter(isApartmentSuiteRoomKey);
  if (suiteKeys.length === 0) return;

  // suiteCount 是当前楼层/sector 的总容量，不是每个 suite key 的独立容量。
  const suiteCount = determineApartmentSuiteCount(candidate, levelKey, sectorArea, rooms);
  const suiteCounts = distributeApartmentSuiteCounts(suiteCount, suiteKeys);
  suiteKeys.forEach((suiteKey) => {
    const count = suiteCounts[suiteKey] ?? 0;
    if (count <= 0) {
      // 允许随机分配后某一类套房完全不出现；删除比保留 count: 0 更干净。
      delete rooms[suiteKey];
      return;
    }
    rooms[suiteKey].count = count;
  });
}

/**
 * 将套房总容量随机拆分到多个套房类型上。
 *
 * 算法分两步：
 * 1. 为每个套房类型生成随机权重，按比例取 floor 得到基础分配；
 * 2. 把 floor 后遗漏的余数按随机顺序补回，保证最终总和严格等于 totalCount。
 *
 * 这里刻意不设置每类最小值，因此某些套房类型可以被分到 0。
 *
 * @param totalCount 当前 level/sector 的套房总容量
 * @param suiteKeys 当前 level/sector 中存在的套房类型 key
 * @returns 每个套房类型对应的最终套数
 */
function distributeApartmentSuiteCounts(
  totalCount: number,
  suiteKeys: string[],
): Record<string, number> {
  if (totalCount <= 0 || suiteKeys.length === 0) return {};
  if (suiteKeys.length === 1) return { [suiteKeys[0]]: totalCount };

  // Math.random() 理论上可能为 0；用极小值避免 totalWeight 被 0 除。
  const weights = suiteKeys.map((suiteKey) => ({
    suiteKey,
    weight: Math.random() || Number.EPSILON,
  }));
  const totalWeight = weights.reduce((sum, item) => sum + item.weight, 0);
  // 先按权重比例分配整数部分，此时总和可能小于 totalCount。
  const result = Object.fromEntries(
    weights.map(({ suiteKey, weight }) => [suiteKey, Math.floor(totalCount * weight / totalWeight)]),
  );
  let assignedCount = Object.values(result).reduce((sum, count) => sum + count, 0);
  // floor 剩下的余数按随机顺序补，避免固定偏向第一个 suite key。
  const remainderOrder = [...suiteKeys].sort(() => Math.random() - 0.5);

  for (let i = 0; assignedCount < totalCount; i += 1) {
    const suiteKey = remainderOrder[i % remainderOrder.length];
    result[suiteKey] += 1;
    assignedCount += 1;
  }

  return result;
}

/**
 * 统计公寓公共/设备/通道等普通房间数量，用于估算一楼非套房空间占用。
 *
 * @param rooms 当前 sector 的房间表
 * @returns 非套房房间的 count 总和
 */
function countApartmentOrdinaryRooms(
  rooms: Record<string, RoomSchema | SuiteSchema>,
): number {
  return Object.entries(rooms).reduce((count, [roomKey, room]) => {
    if (isApartmentSuiteRoomKey(roomKey)) return count;
    return count + room.count;
  }, 0);
}

/**
 * 为公寓补齐入口大厅和垂直交通。
 * @param levelKey
 * @param rooms
 */
function applyApartmentAccessRooms(
  candidate: BuildingCandidate,
  levelKey: string,
  rooms: Record<string, RoomSchema | SuiteSchema>,
): void {
  void candidate;
  if (levelKey === APARTMENT_FLOORS[0]) {
    rooms.lobby = {
      description: "公寓大厅",
      count: 1,
      access: "entrance",
    };
  }

  if (levelKey === APARTMENT_FLOORS[1]) {
    rooms.hall = {
      description: "走廊",
      count: 1,
    };
  }

  rooms.stairwell = {
    description: "楼梯间",
    count: 1,
    access: "vertical",
  };
  rooms.elevator = {
    description: "电梯",
    count: 1,
    access: "vertical",
  };
}

//#region 帮助函数

/**
 * 判断某个 room key 是否是公寓套房类型。
 * @param roomKey 房间或套房 key
 * @returns 是否属于 APARTMENT_SUITE_TEMPLATES 中登记的套房类型
 */
function isApartmentSuiteRoomKey(roomKey: string): boolean {
  return APARTMENT_SUITE_KEYS.includes(roomKey);
}

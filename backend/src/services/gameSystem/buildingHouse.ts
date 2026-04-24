import type { BuildingCandidate, BuildingSchema, CategoryDefinition, CategoryLevelSchema, CategoryRoomSchema, CategorySchema, PatternDistribution, RoomSchema, SectorDistributionSchem } from "./buildingSchema.js";
import { pickRandom, weightedBoolean } from "./buildingSchema.js";
import type { FeatureId } from "../featureDetail.js";
import {
  ALL_LEVELS,
  BASE_LEVEL,
  GROUND_LEVEL,
  isHouseDetermingFactorAccessory,
  isHouseDetermingFactorApartment,
  MEDIUM_HOUSE_AREA_MAX_SQM,
  normalizeBuildingLevels,
  ROOF_LEVEL,
  SMALL_HOUSE_AREA_MAX_SQM,
  TOP_LEVEL,
  type HouseDetermingFactor,
} from "./buildingUtils.js";

//#region 常量

export const HOUSE_CATEGORY: CategoryDefinition = {
  desc: "住宅",
  base_schema: {rooms: {
    storage: {desc: "杂物存储空间", prefered: ROOF_LEVEL, chance: 0.5},
    hvac: {desc: "空调-通风-供暖(HVAC)系统", prefered: ROOF_LEVEL},
  }},
  patterns: {
    studio: {desc: "仅卧室、客厅、浴室的简单布局", rooms: {
      bedroom: {desc: "卧室", prefered: TOP_LEVEL[0]},
      living_room: {desc: "与餐厅、厨房相连的客厅", prefered: GROUND_LEVEL[0]},
      bath_room: {desc: "带厕所的浴室", prefered: TOP_LEVEL[0]},
    }},
    standard: {desc: "单间卧室的常规布局", rooms: {
      bedroom: {desc: "卧室", prefered: TOP_LEVEL[0]},
      living_room: {desc: "客厅", prefered: GROUND_LEVEL[0]},
      kitchen: {desc: "带餐厅的厨房", prefered: GROUND_LEVEL[0]},
      bath_room: {desc: "带厕所的浴室", prefered: TOP_LEVEL[0]},
      // 概率房间
      laundry: {desc: "洗衣间", prefered: GROUND_LEVEL[0], chance: 0.2},
    }},
    duplex: {desc: "一到两间卧室的较复杂布局", rooms: {
      bedroom: {desc: "卧室", prefered: TOP_LEVEL[0]},
      living_room: {desc: "客厅", prefered: GROUND_LEVEL[0]},
      kitchen: {desc: "带餐厅的厨房", prefered: GROUND_LEVEL[0]},
      bath_room: {desc: "带厕所的浴室", prefered: TOP_LEVEL[0]},
      // 概率房间
      closet: {desc: "储物间", chance: 0.5},
      office: {desc: "办公室", chance: 0.2},
      laundry: {desc: "洗衣间", prefered: GROUND_LEVEL[0], chance: 0.8},
      kids_bedroom: {desc: "儿童卧室", prefered: TOP_LEVEL[0], chance: 0.5},
      rest_room: {desc: "厕所", prefered: ALL_LEVELS[0], chance: 0.5},
    }},
    elaborate: {desc: "三到四间卧室的复杂房屋布局", rooms: {
      bedroom: {desc: "卧室", prefered: TOP_LEVEL[0]},
      living_room: {desc: "客厅", prefered: GROUND_LEVEL[0]},
      kitchen: {desc: "厨房", prefered: GROUND_LEVEL[0]},
      bath_room: {desc: "带厕所的浴室", prefered: TOP_LEVEL[0]},
      dining_room: {desc: "餐厅", prefered: GROUND_LEVEL[0]},
      laundry: {desc: "洗衣间", prefered: GROUND_LEVEL[0]},
      closet: {desc: "储物间"},
      // 概率房间
      office: {desc: "办公室", chance: 0.5},
      kids_bedroom: {desc: "儿童卧室", prefered: TOP_LEVEL[0], chance: 0.8},
      rest_room: {desc: "厕所", prefered: ALL_LEVELS[0], chance: 0.9},
    }}
  }
};

const ATTIC_FLOOR = "attic";
const ATTIC_FLOOR_DESCRIPTION = "阁楼";
const BASE_FLOOR = "basement";
const BASE_FLOOR_DESCRIPTION = "地下室";
const HOUSE_FLOOR_DESCRIPTIONS: Record<string, string> = {
  ground_floor: "地面层",
  middle_floor: "中间层",
  top_floor: "顶层",
};

const HOUSE_FLOORS = Object.keys(HOUSE_FLOOR_DESCRIPTIONS)

//#region Category 逻辑

/**
 * 判断一个建筑是否是“独栋住宅”。
 *
 * 输入前提：
 * - 默认调用方已经确认候选属于住宅区
 *
 * 保守策略：
 * - 当目标建筑邻域样本不足或关键几何证据不足时，一律按住宅处理。
 *
 * @param candidate 已缩小到住宅区范围内的建筑候选
 * @returns 分类结果；不属于住宅则返回 undefined
 */
export function isAmbiguousHouseCategory(
  candidate: BuildingCandidate,
  factor: HouseDetermingFactor,
  hasNearbyParking: boolean,
  nearbySchemas: BuildingSchema[],
): string[] | undefined {
  if (isHouseDetermingFactorApartment(candidate, factor)) return undefined;
  if (isHouseDetermingFactorAccessory(factor)) return undefined;

  // 如果是住宅则根据是否有外置停车地点来判断本体需不需要车库
  const hasNearbyGarage = nearbySchemas.some((schema) => schema.category === "garage");
  if (hasNearbyParking || hasNearbyGarage) {
    return ["house"];
  }

  return weightedBoolean(9, 1)
    ? ["house","garage"]
    : ["house"];
}

//#region Pattern 逻辑

export function selectHousePatternKey(candidate: BuildingCandidate): string {
  return pickRandom(determineHousePatternPool(candidate));
}

/**
 * 为住宅类选择一个“可抽样的 pattern 候选池”。
 *
 * 当前规则只使用面积与楼层数这两个稳定信号，保持实现简单且可解释。
 * 真正的随机发生在 pickRandom() 中。
 *
 * @param candidate 已确定为住宅的建筑候选
 * @returns 允许抽样的住宅 pattern 列表
 */
function determineHousePatternPool(candidate: BuildingCandidate): string[] {
  const { areaSqm, buildingLevels } = candidate;

  if (areaSqm === null && buildingLevels === null) {
    return ["studio", "standard", "duplex", "elaborate"];
  }

  if ((areaSqm === null || areaSqm <= SMALL_HOUSE_AREA_MAX_SQM) && (buildingLevels === null || buildingLevels <= 1)) {
    return ["studio", "standard"];
  }

  if ((areaSqm === null || areaSqm <= MEDIUM_HOUSE_AREA_MAX_SQM) && (buildingLevels === null || buildingLevels <= 2)) {
    return ["standard", "duplex"];
  }

  if ((areaSqm !== null && areaSqm > MEDIUM_HOUSE_AREA_MAX_SQM) || (buildingLevels !== null && buildingLevels >= 2)) {
    return ["duplex", "elaborate"];
  }

  return ["standard", "duplex"];
}

//#####################
//#region C-Schema 逻辑
//#####################

/**
 * 因默认为 House 类，所以楼层数会控制为 1 到 3；
 * 从已应用 Pattern Distribution 的 Base Schema 中获取某住宅有哪些功能、有何种偏好，
 * 然后从 Candidate 中获取此住宅的楼层，最后根据偏好的楼层把功能安插到楼层中去。
 * （不涉及房间数量、出入口与通道、套房细节）
 * @param appliedBaseSchema
 * @param candidate
 * @returns 以 Feature ID 为键的 CategorySchema
 */
export function buildHouseCategorySchemaFromDistribution(
  appliedBaseSchema: PatternDistribution,
  candidate: BuildingCandidate,
): Record<FeatureId, CategorySchema> {
  if (!candidate.categoryRecord) return {} // 如果此时还没有 Category 结果，说明肯定是出问题了
  // 控制楼层数在 1 ~ 3 范围
  const buildingLevels = candidate.buildingLevels ? Math.min(3, candidate.buildingLevels) : 1 // 此处默认1层是合理的，因为 Pattern 本身就是被面积与楼层决定的，不会出现不够用的情况

  const result: Record<FeatureId, CategorySchema> = {}
  Object.entries(appliedBaseSchema).forEach(([featureId, roomDefs]) => {

    // 组装空的楼层
    const levels: Record<string, CategoryLevelSchema> = {}
    const concreteLevelKeys: string[] = []
    for (let i = 1; i <= buildingLevels; i++) {
      const levelKey = resolveHouseConcreteLevelKey(i, buildingLevels)
      concreteLevelKeys.push(levelKey)
      levels[levelKey] = {
        description: HOUSE_FLOOR_DESCRIPTIONS[levelKey] ?? levelKey,
        span: [i], // span 固定只有1层的范围
        rooms: {}, // 等待后续装填
      }
    }
    levels[ATTIC_FLOOR] = { // 添加阁楼
      description: ATTIC_FLOOR_DESCRIPTION,
      span: [buildingLevels+1],
      rooms: {},
    }
    // TODO 添加地下室

    // 每个建筑所对应的功能房间都要决定一次装填到哪个楼层
    Object.entries(roomDefs).forEach(([roomKey, definition]) => {
      // 决定去哪个/哪些楼层，返回这些楼层的 key
      const levelKeys = resolveHouseCategorySchemaLevelKeys(definition.prefered, levels, concreteLevelKeys);
      for (const levelKey of levelKeys) {
        if (definition.chance && 1 - definition.chance > Math.random()) continue // 有概率直接跳过，不写入 levels
        levels[levelKey].rooms[roomKey] = {
          description: definition.desc ?? roomKey,
        };
      }
    });

    // TODO 如果各楼层的房间分布不均匀，则挪一挪

    result[featureId] = {
      levels
    }
  });

  return result
}

/**
 * 根据 House 的建筑总楼层和当前楼层，返回当前这个楼层应该叫什么名字
 * @param levelNumber
 * @param buildingLevels
 * @returns
 */
function resolveHouseConcreteLevelKey(levelNumber: number, buildingLevels: number): string {
  if (buildingLevels === 1) return HOUSE_FLOORS[0];
  if (levelNumber === 1) return HOUSE_FLOORS[0];
  if (levelNumber === buildingLevels) return HOUSE_FLOORS[2];
  return HOUSE_FLOORS[1];
}

/**
 * 通过各种条件，选出 House 当中最适合填入某个建筑的楼层 key。
 * 相当于把位置 key 转化为具体楼层名字。
 * @param prefered
 * @param levels
 * @param concreteLevelKeys 可被填的所有楼层
 * @returns 需要填充的楼层的 key
 */
function resolveHouseCategorySchemaLevelKeys(
  prefered: string | undefined,
  levels: Record<string, CategoryLevelSchema>,
  concreteLevelKeys: string[],
): string[] {
  if (prefered === ALL_LEVELS[0]) return concreteLevelKeys;

  if (!prefered) return [pickRandom(concreteLevelKeys)];

  if (TOP_LEVEL.includes(prefered)) return [concreteLevelKeys[concreteLevelKeys.length - 1]];

  if (GROUND_LEVEL.includes(prefered)) return [concreteLevelKeys[0]];

  if (prefered === ROOF_LEVEL) return [ATTIC_FLOOR]

  if (prefered === BASE_LEVEL) return [BASE_FLOOR]

  if (levels[prefered]) return [prefered]; // 保底用，直接返回位置 key 碰碰运气

  return [pickRandom(concreteLevelKeys)];
}

//################
//#region 收尾逻辑
//################

/**
 * 住宅(House)的收尾逻辑
 * @param schemas
 * @param candidate
 * @returns
 */
export function finishHouseBuildingSchema(
  schemas: Record<FeatureId, SectorDistributionSchem>,
  candidate: BuildingCandidate,
): Record<FeatureId, BuildingSchema>  {
  const result: Record<FeatureId, BuildingSchema> = {}
  const categoryKey = candidate.categoryRecord?.join('&') || '出错';
  Object.entries(schemas).forEach(([featureId, schema]) => {
    // 装填楼层中缺失的信息
    const levels: BuildingSchema["levels"] = Object.fromEntries(
      Object.entries(schema.levels).map(([levelKey, level]) => {
        const sectors = Object.fromEntries(
          Object.entries(level.sectors).map(([sectorKey, sector]) => {
            const rooms = resolveResidentialSectorRooms(sector.rooms);

            // 住宅主体收尾负责补齐卧室组、入口和垂直通道；独立附属建筑由单独 finalizer 处理。
            applyHouseSharedRoomCounts(candidate, rooms);

            // 收尾阶段补齐进入建筑和楼层间移动所需的通道房间。
            // 门厅只属于地面层；楼梯间需要在每个实际楼层都能被引用。
            applyHouseAccessRooms(candidate, levelKey, rooms);

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
      category: categoryKey, // 输出到 Building Schema 后，因为不再用到 category 了，就直接组合为单一字符串了
      centerPosition: candidate.centerPosition,
      levels,
    };
  })
  return result
}

//#region 收尾辅助函数

/**
 * 把 CategoryRoomSchema 转为最终 RoomSchema。
 *
 * Category 阶段只表达“有什么功能”，不表达数量；这里先给每个房间默认 1，
 * 后续 helper 再按住宅规则调整共享卧室组、入口和楼梯间。
 * @param rooms Sector Distribution 中的房间定义
 * @returns 可写入 BuildingSchema 的房间定义
 */
function resolveResidentialSectorRooms(
  rooms: Record<string, CategoryRoomSchema>,
): Record<string, RoomSchema> {
  return Object.fromEntries(
    Object.entries(rooms).map(([roomKey, room]) => [roomKey, {
      description: room.description,
      count: 1,
      ...(room.access ? { access: room.access } : {}),
    }]),
  );
}

/**
 * House 使用的卧室数量生成函数
 * @param candidate
 * @returns
 */
function determineSharedBedroomLimit(candidate: BuildingCandidate): number {
  const { areaSqm, buildingLevels } = candidate;

  if ((areaSqm === null || areaSqm <= SMALL_HOUSE_AREA_MAX_SQM) && (buildingLevels === null || buildingLevels <= 1)) {
    return weightedBoolean(3, 1) ? 1 : 2;
  }

  if ((areaSqm === null || areaSqm <= MEDIUM_HOUSE_AREA_MAX_SQM) && (buildingLevels === null || buildingLevels <= 2)) {
    return pickRandom([2, 3]);
  }

  return pickRandom([3, 4]);
}

/**
 * 根据卧室数量上限，分配卧室预算给卧室、儿童卧室、办公室
 * @param candidate
 * @param rooms
 * @returns
 */
function applyHouseSharedRoomCounts(
  candidate: BuildingCandidate,
  rooms: Record<string, RoomSchema>,
): void {
  if (!rooms.bedroom) return;

  const limit = determineSharedBedroomLimit(candidate);
  const hasKidsBedroom = Boolean(rooms.kids_bedroom);
  const hasOffice = Boolean(rooms.office);

  const desiredKidsBedroomCount = hasKidsBedroom ? pickRandom([1, 2]) : 0;
  let remaining = Math.max(0, limit - 1);
  let kidsBedroomCount = Math.min(desiredKidsBedroomCount, remaining);
  remaining -= kidsBedroomCount;
  let officeCount = hasOffice && remaining > 0 ? 1 : 0;
  remaining -= officeCount;
  const bedroomCount = 1 + remaining;

  rooms.bedroom.count = bedroomCount;
  if (rooms.kids_bedroom) {
    if (kidsBedroomCount <= 0) {
      delete rooms.kids_bedroom;
    } else {
      rooms.kids_bedroom.count = kidsBedroomCount;
    }
  }
  if (rooms.office) {
    if (officeCount <= 0) {
      delete rooms.office;
    } else {
      rooms.office.count = officeCount;
    }
  }
}

/**
 * TODO 楼梯间有时会被替换为“带楼梯的走廊”，但必须整个 House 统一
 * @param candidate
 * @param levelKey
 * @param rooms
 */
function applyHouseAccessRooms(
  candidate: BuildingCandidate,
  levelKey: string,
  rooms: Record<string, RoomSchema>,
): void {
  const buildingLevels = normalizeBuildingLevels(candidate.buildingLevels);
  const isSmallSingleLevel = (candidate.areaSqm === null || candidate.areaSqm <= SMALL_HOUSE_AREA_MAX_SQM) && buildingLevels == 1;
  const isGroundLevel = levelKey === "ground_floor";
  const isTopLevel = levelKey === "top_floor";

  if (isGroundLevel && isSmallSingleLevel && rooms.living_room) {
    rooms.living_room.access = "entrance";
  } else if (isGroundLevel) {
    rooms.hall = {
      description: "门厅",
      count: 1,
      access: "entrance",
    };
  }

  if (((buildingLevels == 1 && isGroundLevel) || isTopLevel) && rooms.bedroom) {
    rooms.bedroom.access = "vertical"
  }
  if (levelKey === ATTIC_FLOOR && rooms.hvac) rooms.hvac.access = "vertical"

  if (buildingLevels > 1) {
    rooms.stairwell = {
      description: "带楼梯的走廊",
      count: 1,
      access: "vertical",
    };
  }
}

import type { BuildingCandidate, BuildingSchema, CategoryDefinition, CategoryLevelSchema, CategoryRoomSchema, CategorySchema, PatternDistribution, RoomSchema, SectorDistributionSchem } from "./buildingSchema.js";
import { weightedBoolean } from "./buildingSchema.js";
import type { FeatureId } from "../featureDetail.js";
import {
  GROUND_LEVEL,
  isHouseDetermingFactorAccessory,
  TINY_RESIDENTIAL_BUILDING_AREA_MAX_SQM,
  type HouseDetermingFactor,
} from "./buildingUtils.js";

//#region 常量

// 带车库的住宅通过应用复合型 Category “住宅 - 内含 车库” 表示
// 就像 “图书馆 - 内含 咖啡厅”
export const GARAGE_CATEGORY: CategoryDefinition = {
  desc: "车库",
  base_schema: {rooms: {self: {prefered: GROUND_LEVEL[0]}}},
};

export const TOOL_SHED_CATEGORY: CategoryDefinition = {
  desc: "工具屋",
  base_schema: {rooms: {self: {prefered: GROUND_LEVEL[0]}}},
};

const ACCESSORY_DEFAULT_FLOOR = "default_floor";
const ACCESSORY_FLOOR_DESCRIPTIONS: Record<string, string> = {
  [ACCESSORY_DEFAULT_FLOOR]: "单层空间",
};

//#region Category 逻辑

/**
 * 判断一个建筑是否是“独立附属建筑（独立车库/工具屋）”。
 *
 * 输入前提：
 * - 默认调用方已经确认候选属于住宅区
 *
 * @param candidate 已缩小到住宅区范围内的建筑候选
 * @returns 分类结果；不属于独立附属建筑则返回 undefined
 */
export function isAmbiguousHouseAccessoryCategory(
  candidate: BuildingCandidate,
  factor: HouseDetermingFactor,
  hasNearbyParking: boolean,
  nearbySchemas: BuildingSchema[],
): string[] | undefined {
  if (!isHouseDetermingFactorAccessory(factor)) return undefined;

  // 过小的住宅区建筑固定视作工具屋，避免把明显的储物/工具空间随机成车库。
  if (candidate.areaSqm !== null && candidate.areaSqm < TINY_RESIDENTIAL_BUILDING_AREA_MAX_SQM) {
    return ["tool_shed"];
  }

  // 如果是附属建筑，首先根据周围住宅是否有内置车库来判断，已有内置车库就不需要车库了
  const hasNearbyHouseGarage = nearbySchemas.some((schema) => schema.category === "house&garage");
  if (hasNearbyHouseGarage) {
    return ["tool_shed"];
  }

  if (hasNearbyParking) { // 即使有外置停车地点，也可能需要独立车库
    return weightedBoolean(9, 1)
      ? ["tool_shed"]
      : ["garage"];
  }

  // 没有内置车库且没有外置停车地点，大概率是独立车库，但仍有小概率是街边停车+工具房
  return weightedBoolean(1, 9)
    ? ["tool_shed"]
    : ["garage"];
}

//#####################
//#region C-Schema 逻辑
//#####################

/**
 * 独立附属建筑(Accessory)的 C-Schema 逻辑
 * 默认楼层数限制为1，且只有1个房间
 * @param appliedBaseSchema
 * @param candidate
 * @returns
 */
export function buildResidentialAccessoryCategorySchemaFromDistribution(
  appliedBaseSchema: PatternDistribution,
  candidate: BuildingCandidate,
): Record<FeatureId, CategorySchema> {
  if (!candidate.categoryRecord) return {}

  const result: Record<FeatureId, CategorySchema> = {}
  Object.entries(appliedBaseSchema).forEach(([featureId, roomDefs]) => {
    const level: CategoryLevelSchema = {
      description: ACCESSORY_FLOOR_DESCRIPTIONS[ACCESSORY_DEFAULT_FLOOR],
      span: [1],
      rooms: {},
    };

    // 独立附属建筑按单一功能空间建模，避免复用住宅的楼层命名和通道规则。
    Object.entries(roomDefs).forEach(([roomKey, definition]) => {
      if (definition.chance && 1 - definition.chance > Math.random()) return
      level.rooms[roomKey] = {
        description: definition.desc ?? roomKey,
      };
    });

    result[featureId] = {
      levels: {
        [ACCESSORY_DEFAULT_FLOOR]: level,
      },
    }
  });

  return result
}

//################
//#region 收尾逻辑
//################

/**
 * 独立附属建筑 (Accessory) 的收尾逻辑
 * @param schemas
 * @param candidate
 * @returns
 */
export function finishResidentialAccessoryBuildingSchema(
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
            const roomsEntries = Object.entries(resolveResidentialSectorRooms(sector.rooms));
            // 独立附属建筑肯定只有1个房间，所以全部加上 access entrance
            // 出问题了再说吧
            const rooms: Record<string, RoomSchema> = Object.fromEntries(roomsEntries.map(([k, v]) => [k, {...v, access: "entrance"}]))
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

/// <reference types="jest" />

jest.mock("../src/db/client", () => ({
  query: jest.fn(),
}));

jest.mock("../src/db/sqlLoader", () => ({
  loadServiceSql: jest.fn().mockResolvedValue("SELECT 1"),
}));

import {
  applyCategoryBaseSchemasToDistribution,
  BuildingCandidate,
  decidePatternDistribution,
  FeatureIdRoomDefinition,
} from "../src/services/gameSystem/buildingClassifier";
import { buildHouseCategorySchemaFromDistribution } from "../src/services/gameSystem/buildingResidential";

describe("building residential schema generation", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("preserves house pattern room keys through distribution", () => {
    const candidate = buildCandidate({ buildingLevels: 1 });

    const distribution = decidePatternDistribution(candidate, { house: "studio" });
    const appliedBaseSchema = applyCategoryBaseSchemasToDistribution(distribution);
    const schema = buildHouseCategorySchemaFromDistribution(appliedBaseSchema, candidate);
    const rooms = schema.levels.ground_level.rooms;

    expect(rooms.bedroom).toEqual({ descrption: "卧室" });
    expect(rooms.living_room).toEqual({ descrption: "与餐厅、厨房相连的客厅" });
    expect(rooms.bath_room).toEqual({ descrption: "带厕所的浴室" });
  });

  it("merges composite house and garage rooms without overwriting the feature distribution", () => {
    const candidate = buildCandidate({ areaSqm: 120, buildingLevels: 1 });

    const distribution = decidePatternDistribution(candidate, { house: "standard", garage: "garage" });
    const appliedBaseSchema = applyCategoryBaseSchemasToDistribution(distribution);
    const schema = buildHouseCategorySchemaFromDistribution(appliedBaseSchema, candidate);
    const rooms = schema.levels.ground_level.rooms;

    expect(distribution[candidate.detail.featureId].categories).toEqual(["house", "garage"]);
    expect(rooms.living_room).toEqual({ descrption: "客厅" });
    expect(rooms.kitchen).toEqual({ descrption: "带餐厅的厨房" });
    expect(rooms.garage).toEqual({ descrption: "车库" });
  });

  it("converts true self base schema rooms to category-keyed rooms with category descriptions", () => {
    const candidate = buildCandidate();

    const distribution = decidePatternDistribution(candidate, { tool_shed: "tool_shed" });
    const appliedBaseSchema = applyCategoryBaseSchemasToDistribution(distribution);
    const schema = buildHouseCategorySchemaFromDistribution(appliedBaseSchema, candidate);

    expect(schema.levels.ground_level.rooms.tool_shed).toEqual({ descrption: "工具屋" });
  });

  it("places rooms by preferred level and random fallback", () => {
    jest.spyOn(Math, "random").mockReturnValue(0.99);
    const candidate = buildCandidate({ buildingLevels: 2 });
    const appliedBaseSchema: FeatureIdRoomDefinition = {
      [candidate.detail.featureId]: {
        top_room: { desc: "顶层房间", prefered: "top_level" },
        ground_room: { desc: "底层房间", prefered: "ground_level" },
        whole_room: { desc: "全楼层房间", prefered: "all_levels" },
        fallback_room: { desc: "随机房间" },
      },
    };

    const schema = buildHouseCategorySchemaFromDistribution(appliedBaseSchema, candidate);

    expect(schema.levels.top_level.rooms.top_room).toEqual({ descrption: "顶层房间" });
    expect(schema.levels.ground_level.rooms.ground_room).toEqual({ descrption: "底层房间" });
    expect(schema.levels.ground_level.rooms.whole_room).toEqual({ descrption: "全楼层房间" });
    expect(schema.levels.top_level.rooms.whole_room).toEqual({ descrption: "全楼层房间" });
    expect(schema.levels.all_levels).toBeUndefined();
    expect(schema.levels.top_level.rooms.fallback_room).toEqual({ descrption: "随机房间" });
    expect(schema.levels.ground_level.rooms.fallback_room).toBeUndefined();
  });
});

function buildCandidate(overrides: Partial<{
  areaSqm: number | null;
  buildingLevels: number | null;
}> = {}): BuildingCandidate {
  return {
    scope: "single",
    detail: {
      featureId: "way/999",
      osmId: 999,
      osmType: "way",
      category: "building",
      geometryType: "POLYGON",
      tags: { building: "yes" },
    },
    areaSqm: 100,
    centerPosition: { lat: 40, lon: -83 },
    buildingLevels: 1,
    heightMeters: null,
    buildingValue: "yes",
    ...overrides,
  };
}

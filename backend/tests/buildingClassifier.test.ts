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
  PatternDistribution,
  SectorDistributionSchem,
} from "../src/services/gameSystem/buildingClassifier";
import { buildHouseCategorySchemaFromDistribution, finishHouseBuildingSchema } from "../src/services/gameSystem/buildingResidential";

describe("building residential schema generation", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("preserves house pattern room keys through distribution", () => {
    jest.spyOn(Math, "random").mockReturnValue(0.99);
    const candidate = buildCandidate({ buildingLevels: 1 });

    const distribution = decidePatternDistribution(candidate, { house: "studio" });
    const appliedBaseSchema = applyCategoryBaseSchemasToDistribution(distribution);
    const schema = buildHouseCategorySchemaFromDistribution(appliedBaseSchema, candidate);
    const rooms = schema.levels.ground_level.rooms;

    expect(schema.theme).toBe("普通的住宅");
    expect(schema.levels.ground_level.theme).toBe("普通的住宅");
    expect(rooms.bedroom).toEqual({ descrption: "卧室" });
    expect(rooms.living_room).toEqual({ descrption: "与餐厅、厨房相连的客厅" });
    expect(rooms.bath_room).toEqual({ descrption: "带厕所的浴室" });
  });

  it("merges composite house and garage rooms without overwriting the feature distribution", () => {
    jest.spyOn(Math, "random").mockReturnValue(0.99);
    const candidate = buildCandidate({ areaSqm: 120, buildingLevels: 1 });

    const distribution = decidePatternDistribution(candidate, { house: "standard", garage: "garage" });
    const appliedBaseSchema = applyCategoryBaseSchemasToDistribution(distribution);
    const schema = buildHouseCategorySchemaFromDistribution(appliedBaseSchema, candidate);
    const rooms = schema.levels.ground_level.rooms;

    expect(distribution[candidate.detail.featureId].categories).toEqual(["house", "garage"]);
    expect(appliedBaseSchema[candidate.detail.featureId].categories).toEqual(["house", "garage"]);
    expect(schema.theme).toBe("普通的住宅");
    expect(schema.levels.ground_level.theme).toBe("普通的住宅");
    expect(rooms.living_room).toEqual({ descrption: "客厅" });
    expect(rooms.kitchen).toEqual({ descrption: "带餐厅的厨房" });
    expect(rooms.garage).toEqual({ descrption: "车库" });
  });

  it("converts true self base schema rooms to category-keyed rooms with category descriptions", () => {
    jest.spyOn(Math, "random").mockReturnValue(0.99);
    const candidate = buildCandidate();

    const distribution = decidePatternDistribution(candidate, { tool_shed: "tool_shed" });
    const appliedBaseSchema = applyCategoryBaseSchemasToDistribution(distribution);
    const schema = buildHouseCategorySchemaFromDistribution(appliedBaseSchema, candidate);

    expect(schema.theme).toBe("普通的工具屋");
    expect(schema.levels.ground_level.theme).toBe("普通的工具屋");
    expect(schema.levels.ground_level.rooms.tool_shed).toEqual({ descrption: "工具屋" });
  });

  it("uses garage as the schema theme when garage is the main category", () => {
    jest.spyOn(Math, "random").mockReturnValue(0.99);
    const candidate = buildCandidate();

    const distribution = decidePatternDistribution(candidate, { garage: "garage" });
    const appliedBaseSchema = applyCategoryBaseSchemasToDistribution(distribution);
    const schema = buildHouseCategorySchemaFromDistribution(appliedBaseSchema, candidate);

    expect(schema.theme).toBe("普通的车库");
    expect(schema.levels.ground_level.theme).toBe("普通的车库");
    expect(schema.levels.ground_level.rooms.garage).toEqual({ descrption: "车库" });
  });

  it("places rooms by preferred level and random fallback", () => {
    jest.spyOn(Math, "random").mockReturnValue(0.99);
    const candidate = buildCandidate({ buildingLevels: 2 });
    const appliedBaseSchema: PatternDistribution = {
      [candidate.detail.featureId]: {
        categories: ["house"],
        rooms: {
          top_room: { desc: "顶层房间", prefered: "top_level" },
          ground_room: { desc: "底层房间", prefered: "ground_level" },
          whole_room: { desc: "全楼层房间", prefered: "all_levels" },
          fallback_room: { desc: "随机房间" },
        },
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

  it("applies a schema-level event theme to every level when schema theme mutates", () => {
    jest.spyOn(Math, "random")
      .mockReturnValueOnce(0.01)
      .mockReturnValueOnce(0);
    const candidate = buildCandidate({ buildingLevels: 2 });

    const distribution = decidePatternDistribution(candidate, { house: "studio" });
    const appliedBaseSchema = applyCategoryBaseSchemasToDistribution(distribution);
    const schema = buildHouseCategorySchemaFromDistribution(appliedBaseSchema, candidate);

    expect(schema.theme).toBe("正在举办小型聚会的住宅");
    expect(schema.levels.ground_level.theme).toBe("正在举办小型聚会的住宅");
    expect(schema.levels.top_level.theme).toBe("正在举办小型聚会的住宅");
  });

  it("mutates only the matching level theme when schema theme stays normal", () => {
    jest.spyOn(Math, "random")
      .mockReturnValueOnce(0.99)
      .mockReturnValueOnce(0.01)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.99);
    const candidate = buildCandidate({ buildingLevels: 2 });

    const distribution = decidePatternDistribution(candidate, { house: "studio" });
    const appliedBaseSchema = applyCategoryBaseSchemasToDistribution(distribution);
    const schema = buildHouseCategorySchemaFromDistribution(appliedBaseSchema, candidate);

    expect(schema.theme).toBe("普通的住宅");
    expect(schema.levels.ground_level.theme).toBe("正在整理生活用品的住宅楼层");
    expect(schema.levels.top_level.theme).toBe("普通的住宅");
  });

  it("finishes a studio house into a complete building schema with a living room entrance", () => {
    jest.spyOn(Math, "random").mockReturnValue(0);
    const candidate = buildCandidate({ areaSqm: 80, buildingLevels: 1 });
    const sectorSchema = buildSectorDistributionSchema({
      theme: "普通的住宅",
      levels: {
        ground_level: {
          theme: "普通的住宅",
          span: [1],
          rooms: {
            bedroom: { descrption: "卧室" },
            living_room: { descrption: "与餐厅、厨房相连的客厅" },
            bath_room: { descrption: "带厕所的浴室" },
          },
        },
      },
    });

    const schema = finishHouseBuildingSchema(sectorSchema, candidate, "house");
    const rooms = schema.levels.ground_level.sectors.main.rooms;

    expect(schema.featureId).toBe(candidate.detail.featureId);
    expect(schema.category).toBe("house");
    expect(schema.centerPosition).toEqual(candidate.centerPosition);
    expect(schema.theme).toBe("普通的住宅");
    expect(schema.levels.ground_level.span).toEqual([1]);
    expect(schema.levels.ground_level.sectors.main.area).toBe(80);
    expect(rooms.bedroom).toEqual({ descrption: "卧室", count: 1 });
    expect(rooms.living_room).toEqual({
      descrption: "与餐厅、厨房相连的客厅",
      count: 1,
      access: "entrance",
    });
    expect(rooms.hall).toBeUndefined();
  });

  it("adds a ground-level hall and vertical stairwells for a two-level house", () => {
    jest.spyOn(Math, "random").mockReturnValue(0);
    const candidate = buildCandidate({ areaSqm: 140, buildingLevels: 2 });
    const sectorSchema = buildSectorDistributionSchema({
      theme: "普通的住宅",
      levels: {
        ground_level: {
          theme: "普通的住宅",
          span: [1],
          rooms: {
            living_room: { descrption: "客厅" },
            kitchen: { descrption: "带餐厅的厨房" },
          },
        },
        top_level: {
          theme: "普通的住宅",
          span: [2],
          rooms: {
            bedroom: { descrption: "卧室" },
            bath_room: { descrption: "带厕所的浴室" },
          },
        },
      },
    });

    const schema = finishHouseBuildingSchema(sectorSchema, candidate, "house");
    const groundRooms = schema.levels.ground_level.sectors.main.rooms;
    const topRooms = schema.levels.top_level.sectors.main.rooms;

    expect(schema.category).toBe("house");
    expect(groundRooms.hall).toEqual({ descrption: "门厅", count: 1, access: "entrance" });
    expect(groundRooms.stairwell).toEqual({ descrption: "楼梯间", count: 1, access: "vertical" });
    expect(topRooms.hall).toBeUndefined();
    expect(topRooms.stairwell).toEqual({ descrption: "楼梯间", count: 1, access: "vertical" });
  });

  it("finishes a composite house and garage schema without losing garage count", () => {
    const candidate = buildCandidate({ areaSqm: 120, buildingLevels: 1 });
    const sectorSchema = buildSectorDistributionSchema({
      theme: "普通的住宅",
      levels: {
        ground_level: {
          theme: "普通的住宅",
          span: [1],
          rooms: {
            living_room: { descrption: "客厅" },
            garage: { descrption: "车库" },
          },
        },
      },
    });

    const schema = finishHouseBuildingSchema(sectorSchema, candidate, "house");
    const rooms = schema.levels.ground_level.sectors.main.rooms;

    expect(schema.category).toBe("house");
    expect(rooms.garage).toEqual({ descrption: "车库", count: 1 });
    expect(rooms.hall).toEqual({ descrption: "门厅", count: 1, access: "entrance" });
  });

  it("finishes simple accessory residential categories as single-room schemas", () => {
    const candidate = buildCandidate({ areaSqm: 24, buildingLevels: 1 });
    const garageSectorSchema = buildSectorDistributionSchema({
      theme: "普通的车库",
      levels: {
        ground_level: {
          theme: "普通的车库",
          span: [1],
          rooms: {
            garage: { descrption: "车库" },
          },
        },
      },
    });
    const shedSectorSchema = buildSectorDistributionSchema({
      theme: "普通的工具屋",
      levels: {
        ground_level: {
          theme: "普通的工具屋",
          span: [1],
          rooms: {
            tool_shed: { descrption: "工具屋" },
          },
        },
      },
    });

    const garageSchema = finishHouseBuildingSchema(garageSectorSchema, candidate, "garage");
    const shedSchema = finishHouseBuildingSchema(shedSectorSchema, candidate, "tool_shed");

    expect(garageSchema.category).toBe("garage");
    expect(garageSchema.levels.ground_level.sectors.main.rooms.garage).toEqual({ descrption: "车库", count: 1 });
    expect(garageSchema.levels.ground_level.sectors.main.rooms.hall).toEqual({ descrption: "门厅", count: 1, access: "entrance" });
    expect(shedSchema.category).toBe("tool_shed");
    expect(shedSchema.levels.ground_level.sectors.main.rooms.tool_shed).toEqual({ descrption: "工具屋", count: 1 });
    expect(shedSchema.levels.ground_level.sectors.main.rooms.hall).toEqual({ descrption: "门厅", count: 1, access: "entrance" });
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

function buildSectorDistributionSchema(input: {
  theme: string;
  levels: Record<string, {
    theme: string;
    span: number[];
    rooms: SectorDistributionSchem["levels"][string]["sectors"][string]["rooms"];
  }>;
}): SectorDistributionSchem {
  return {
    theme: input.theme,
    levels: Object.fromEntries(
      Object.entries(input.levels).map(([levelKey, level]) => [levelKey, {
        theme: level.theme,
        span: level.span,
        sectors: {
          main: {
            area: 80,
            centerPosition: { lat: 40, lon: -83 },
            rooms: level.rooms,
          },
        },
      }]),
    ),
  };
}

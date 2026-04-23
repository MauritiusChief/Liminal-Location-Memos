/// <reference types="jest" />

jest.mock("../src/db/client", () => ({
  query: jest.fn(),
}));

jest.mock("../src/db/sqlLoader", () => ({
  loadServiceSql: jest.fn().mockResolvedValue("SELECT 1"),
}));

import { query } from "../src/db/client";
import {
  applyCategoryBaseSchemasToDistribution,
  buildColocatedDebugBuildingSchemas,
  type BuildingCandidate,
  decidePatternDistribution,
  generateBuildingSchema,
  type PatternDistribution,
  type SectorDistributionSchem,
} from "../src/services/gameSystem/buildingClassifier";
import {
  buildApartmentCategorySchemaFromDistribution,
  buildHouseCategorySchemaFromDistribution,
  buildResidentialAccessoryCategorySchemaFromDistribution,
  finishApartmentBuildingSchema,
  finishHouseBuildingSchema,
  finishResidentialAccessoryBuildingSchema,
} from "../src/services/gameSystem/buildingResidential";
import type { DbBuildingFeatureDetailRow } from "../src/services/featureDetail";

const mockedQuery = jest.mocked(query);

describe("building residential schema generation", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    mockedQuery.mockReset();
  });

  it("preserves house pattern room keys through distribution", () => {
    jest.spyOn(Math, "random").mockReturnValue(0.99);
    const candidate = buildCandidate({
      categoryRecord: ["house"],
      patternRecord: { house: "studio" },
    });

    const distribution = decidePatternDistribution(candidate, true);
    const appliedBaseSchema = applyCategoryBaseSchemasToDistribution(candidate, distribution);
    const schemas = buildHouseCategorySchemaFromDistribution(appliedBaseSchema, candidate);
    const schema = schemas[candidate.details[0].featureId];
    const rooms = schema.levels.ground_floor.rooms;

    expect(rooms.bedroom).toEqual({ descrption: "卧室" });
    expect(rooms.living_room).toEqual({ descrption: "与餐厅、厨房相连的客厅" });
    expect(rooms.bath_room).toEqual({ descrption: "带厕所的浴室" });
  });

  it("passes skipComplex through pattern distribution without changing deterministic output", () => {
    const candidate = buildCandidate({
      categoryRecord: ["house"],
      patternRecord: { house: "standard" },
    });

    expect(decidePatternDistribution(candidate, true)).toEqual(decidePatternDistribution(candidate, false));
  });

  it("merges composite house and garage rooms into the same feature distribution", () => {
    jest.spyOn(Math, "random").mockReturnValue(0.99);
    const candidate = buildCandidate({
      areaSqm: 120,
      categoryRecord: ["house", "garage"],
      patternRecord: { house: "standard", garage: "garage" },
    });

    const distribution = decidePatternDistribution(candidate);
    const appliedBaseSchema = applyCategoryBaseSchemasToDistribution(candidate, distribution);
    const schemas = buildHouseCategorySchemaFromDistribution(appliedBaseSchema, candidate);
    const rooms = schemas[candidate.details[0].featureId].levels.ground_floor.rooms;

    expect(rooms.living_room).toEqual({ descrption: "客厅" });
    expect(rooms.kitchen).toEqual({ descrption: "带餐厅的厨房" });
    expect(rooms.garage).toEqual({ descrption: "车库" });
    expect(rooms.self).toBeUndefined();
  });

  it("finishes a standalone garage without house access rooms", () => {
    jest.spyOn(Math, "random").mockReturnValue(0.99);
    const candidate = buildCandidate({
      buildingLevels: 2,
      categoryRecord: ["garage"],
      patternRecord: { garage: "garage" },
    });

    const categorySchemas = buildAccessoryCategorySchemas(candidate);
    const sectorSchema = buildSectorDistributionSchema(candidate, categorySchemas[candidate.details[0].featureId]);
    const schemas = finishResidentialAccessoryBuildingSchema(sectorSchema, candidate);
    const schema = schemas[candidate.details[0].featureId];
    const defaultRooms = schema.levels.default_floor.sectors.main.rooms;

    expect(schema.category).toBe("garage");
    expect(Object.keys(schema.levels)).toEqual(["default_floor"]);
    expect(defaultRooms.garage).toEqual({ descrption: "车库", count: 1, access: "entrance" });
    expect(defaultRooms.hall).toBeUndefined();
    expect(defaultRooms.stairwell).toBeUndefined();
    expect(schema.levels.ground_floor).toBeUndefined();
    expect(schema.levels.top_floor).toBeUndefined();
  });

  it("finishes a standalone tool shed without house access rooms", () => {
    jest.spyOn(Math, "random").mockReturnValue(0.99);
    const candidate = buildCandidate({
      buildingLevels: 2,
      categoryRecord: ["tool_shed"],
      patternRecord: { tool_shed: "tool_shed" },
    });

    const categorySchemas = buildAccessoryCategorySchemas(candidate);
    const sectorSchema = buildSectorDistributionSchema(candidate, categorySchemas[candidate.details[0].featureId]);
    const schemas = finishResidentialAccessoryBuildingSchema(sectorSchema, candidate);
    const schema = schemas[candidate.details[0].featureId];
    const defaultRooms = schema.levels.default_floor.sectors.main.rooms;

    expect(schema.category).toBe("tool_shed");
    expect(Object.keys(schema.levels)).toEqual(["default_floor"]);
    expect(defaultRooms.tool_shed).toEqual({ descrption: "工具屋", count: 1, access: "entrance" });
    expect(defaultRooms.hall).toBeUndefined();
    expect(defaultRooms.stairwell).toBeUndefined();
    expect(schema.levels.ground_floor).toBeUndefined();
    expect(schema.levels.top_floor).toBeUndefined();
  });

  it("builds apartment category schema with only ground and residential floors", () => {
    jest.spyOn(Math, "random").mockReturnValue(0.99);
    const candidate = buildCandidate({
      areaSqm: 320,
      buildingLevels: 4,
      categoryRecord: ["apartment", "apartment_utility"],
      patternRecord: { apartment: "standard_apt", apartment_utility: "apartment_utility" },
    });

    const distribution = decidePatternDistribution(candidate);
    const appliedBaseSchema = applyCategoryBaseSchemasToDistribution(candidate, distribution);
    const schemas = buildApartmentCategorySchemaFromDistribution(appliedBaseSchema, candidate);
    const schema = schemas[candidate.details[0].featureId];

    expect(Object.keys(schema.levels)).toEqual(["ground_floor", "residential_floor"]);
    expect(schema.levels.ground_floor.span).toEqual([1]);
    expect(schema.levels.residential_floor.span).toEqual([2, 3, 4]);
    expect(schema.levels.residential_floor.rooms.standard_suite).toEqual({ descrption: "标准公寓套房" });
    expect(schema.levels.residential_floor.rooms.studio_suite).toEqual({ descrption: "单间公寓套房" });
    expect(schema.levels.ground_floor.rooms.standard_suite).toEqual({ descrption: "标准公寓套房" });
    expect(schema.levels.ground_floor.rooms.studio_suite).toEqual({ descrption: "单间公寓套房" });
    expect(schema.levels.ground_floor.rooms.janitor_room).toEqual({ descrption: "清洁间" });
    expect(schema.levels.ground_floor.rooms.mail_room).toEqual({ descrption: "收发室" });
    expect(schema.levels.ground_floor.rooms.laundry_room).toEqual({ descrption: "公共洗衣房" });
    expect(schema.levels.ground_floor.rooms.gym).toEqual({ descrption: "健身房" });
  });

  it("finishes apartment suites and access rooms", () => {
    jest.spyOn(Math, "random").mockReturnValue(0);
    const candidate = buildCandidate({
      areaSqm: 320,
      buildingLevels: 2,
      categoryRecord: ["apartment"],
      patternRecord: { apartment: "studio_apt" },
    });
    const sectorSchema = buildSectorDistributionSchema(candidate, {
      levels: {
        ground_floor: {
          span: [1],
          rooms: {
            cleaning_room: { descrption: "清洁间" },
            studio_suite: { descrption: "单间公寓套房" },
          },
        },
        residential_floor: {
          span: [2],
          rooms: {
            studio_suite: { descrption: "单间公寓套房" },
          },
        },
      },
    });

    const schemas = finishApartmentBuildingSchema(sectorSchema, candidate);
    const schema = schemas[candidate.details[0].featureId];
    const groundRooms = schema.levels.ground_floor.sectors.main.rooms;
    const residentialRooms = schema.levels.residential_floor.sectors.main.rooms;
    const groundSuite = groundRooms.studio_suite;
    const suite = residentialRooms.studio_suite;

    expect(schema.category).toBe("apartment");
    expect(groundRooms.lobby).toEqual({ descrption: "公寓大厅", count: 1, access: "entrance" });
    expect(groundRooms.stairwell).toEqual({ descrption: "楼梯间", count: 1, access: "vertical" });
    expect(residentialRooms.stairwell).toEqual({ descrption: "楼梯间", count: 1, access: "vertical" });
    expect("subRooms" in groundSuite).toBe(true);
    if ("subRooms" in groundSuite) {
      expect(groundSuite.count).toBe(2);
    }
    expect("subRooms" in suite).toBe(true);
    if ("subRooms" in suite) {
      expect(suite.count).toBe(4);
      expect(suite.subRooms).toEqual({
        living_room: { descrption: "卧室、客厅、厨房一体空间", count: 1 },
        bath_room: { descrption: "带厕所浴室", count: 1 },
      });
      expect(suite.subRooms.bedroom).toBeUndefined();
      expect(suite.subRooms.bedroom_wild).toBeUndefined();
    }
  });

  it("removes ground floor apartment suites when shared rooms leave no suite capacity", () => {
    jest.spyOn(Math, "random").mockReturnValue(0);
    const candidate = buildCandidate({
      areaSqm: 180,
      buildingLevels: 2,
      categoryRecord: ["apartment"],
      patternRecord: { apartment: "studio_apt" },
    });
    const sectorSchema = buildSectorDistributionSchema(candidate, {
      levels: {
        ground_floor: {
          span: [1],
          rooms: {
            cleaning_room: { descrption: "清洁间" },
            trash_room: { descrption: "垃圾站" },
            electrical_room: { descrption: "配电间" },
            studio_suite: { descrption: "单间公寓套房" },
          },
        },
        residential_floor: {
          span: [2],
          rooms: {
            studio_suite: { descrption: "单间公寓套房" },
          },
        },
      },
    });

    const schemas = finishApartmentBuildingSchema(sectorSchema, candidate);
    const schema = schemas[candidate.details[0].featureId];
    const groundRooms = schema.levels.ground_floor.sectors.main.rooms;
    const residentialRooms = schema.levels.residential_floor.sectors.main.rooms;

    expect(groundRooms.studio_suite).toBeUndefined();
    expect(groundRooms.lobby).toEqual({ descrption: "公寓大厅", count: 1, access: "entrance" });
    expect(groundRooms.stairwell).toEqual({ descrption: "楼梯间", count: 1, access: "vertical" });
    expect(residentialRooms.studio_suite).toBeDefined();
  });

  it("keeps studio apartment pattern limited to studio suites", () => {
    jest.spyOn(Math, "random").mockReturnValue(0.99);
    const candidate = buildCandidate({
      areaSqm: 320,
      buildingLevels: 2,
      categoryRecord: ["apartment"],
      patternRecord: { apartment: "studio_apt" },
    });

    const distribution = decidePatternDistribution(candidate);
    const appliedBaseSchema = applyCategoryBaseSchemasToDistribution(candidate, distribution);
    const schemas = buildApartmentCategorySchemaFromDistribution(appliedBaseSchema, candidate);
    const groundRooms = schemas[candidate.details[0].featureId].levels.ground_floor.rooms;
    const residentialRooms = schemas[candidate.details[0].featureId].levels.residential_floor.rooms;

    expect(groundRooms.studio_suite).toEqual({ descrption: "单间公寓套房" });
    expect(groundRooms.standard_suite).toBeUndefined();
    expect(residentialRooms.studio_suite).toEqual({ descrption: "单间公寓套房" });
    expect(residentialRooms.standard_suite).toBeUndefined();
  });

  it("can finish standard and studio suites from the same apartment floor", () => {
    jest.spyOn(Math, "random").mockReturnValue(0.99);
    const candidate = buildCandidate({
      areaSqm: 320,
      buildingLevels: 2,
      categoryRecord: ["apartment"],
      patternRecord: { apartment: "standard_apt" },
    });
    const sectorSchema = buildSectorDistributionSchema(candidate, {
      levels: {
        residential_floor: {
          span: [2],
          rooms: {
            standard_suite: { descrption: "标准公寓套房" },
            studio_suite: { descrption: "单间公寓套房" },
          },
        },
      },
    });

    const schemas = finishApartmentBuildingSchema(sectorSchema, candidate);
    const rooms = schemas[candidate.details[0].featureId].levels.residential_floor.sectors.main.rooms;
    const standardSuite = rooms.standard_suite;
    const studioSuite = rooms.studio_suite;

    expect("subRooms" in standardSuite).toBe(true);
    if ("subRooms" in standardSuite) {
      expect(standardSuite.count).toBe(1);
      expect(standardSuite.subRooms).toEqual({
        bedroom_wild: { descrption: "卧室类房间（可为卧室/儿童卧室/办公室）", count: 2 },
        living_room: { descrption: "客厅", count: 1 },
        kitchen: { descrption: "带餐厅的厨房", count: 1 },
        bath_room: { descrption: "浴室", count: 1 },
        rest_room: { descrption: "厕所", count: 1 },
        closet: { descrption: "储物间", count: 1 },
      });
      expect(standardSuite.subRooms.bedroom).toBeUndefined();
      expect(standardSuite.subRooms.kids_bedroom).toBeUndefined();
      expect(standardSuite.subRooms.office).toBeUndefined();
    }
    expect("subRooms" in studioSuite).toBe(true);
    if ("subRooms" in studioSuite) {
      expect(studioSuite.count).toBe(1);
      expect(studioSuite.subRooms).toEqual({
        bedroom_wild: { descrption: "卧室类房间（可为卧室/儿童卧室/办公室）", count: 1 },
        living_room: { descrption: "与厨房相连的客厅", count: 1 },
        bath_room: { descrption: "带厕所浴室", count: 1 },
      });
      expect(studioSuite.subRooms.bedroom).toBeUndefined();
    }
    if ("subRooms" in standardSuite && "subRooms" in studioSuite) {
      expect(standardSuite.count + studioSuite.count).toBe(2);
    }
  });

  it("can remove one apartment suite type when random split assigns zero capacity", () => {
    jest.spyOn(Math, "random").mockReturnValue(0);
    const candidate = buildCandidate({
      areaSqm: 80,
      buildingLevels: 2,
      categoryRecord: ["apartment"],
      patternRecord: { apartment: "standard_apt" },
    });
    const sectorSchema = buildSectorDistributionSchema(candidate, {
      levels: {
        residential_floor: {
          span: [2],
          rooms: {
            standard_suite: { descrption: "标准公寓套房" },
            studio_suite: { descrption: "单间公寓套房" },
          },
        },
      },
    });

    const schemas = finishApartmentBuildingSchema(sectorSchema, candidate);
    const rooms = schemas[candidate.details[0].featureId].levels.residential_floor.sectors.main.rooms;
    const suites = [rooms.standard_suite, rooms.studio_suite].filter((room) => room !== undefined);

    expect(suites).toHaveLength(1);
    expect("subRooms" in suites[0]).toBe(true);
    if ("subRooms" in suites[0]) {
      expect(suites[0].count).toBe(1);
    }
  });

  it("places rooms by preferred level and random fallback", () => {
    jest.spyOn(Math, "random").mockReturnValue(0.99);
    const candidate = buildCandidate({
      buildingLevels: 2,
      categoryRecord: ["house"],
    });
    const appliedBaseSchema: PatternDistribution = {
      [candidate.details[0].featureId]: {
        top_room: { desc: "顶层房间", prefered: "top_level" },
        ground_room: { desc: "底层房间", prefered: "ground_level" },
        whole_room: { desc: "全楼层房间", prefered: "all_levels" },
        fallback_room: { desc: "随机房间" },
      },
    };

    const schemas = buildHouseCategorySchemaFromDistribution(appliedBaseSchema, candidate);
    const schema = schemas[candidate.details[0].featureId];

    expect(schema.levels.top_floor.rooms.top_room).toEqual({ descrption: "顶层房间" });
    expect(schema.levels.ground_floor.rooms.ground_room).toEqual({ descrption: "底层房间" });
    expect(schema.levels.ground_floor.rooms.whole_room).toEqual({ descrption: "全楼层房间" });
    expect(schema.levels.top_floor.rooms.whole_room).toEqual({ descrption: "全楼层房间" });
    expect(schema.levels.top_floor.rooms.fallback_room).toEqual({ descrption: "随机房间" });
    expect(schema.levels.ground_floor.rooms.fallback_room).toBeUndefined();
  });

  it("finishes a studio house into a complete building schema record", () => {
    jest.spyOn(Math, "random").mockReturnValue(0);
    const candidate = buildCandidate({
      areaSqm: 80,
      buildingLevels: 1,
      categoryRecord: ["house"],
    });
    const sectorSchema = buildSectorDistributionSchema(candidate, {
      levels: {
        ground_floor: {
          span: [1],
          rooms: {
            bedroom: { descrption: "卧室" },
            living_room: { descrption: "与餐厅、厨房相连的客厅" },
            bath_room: { descrption: "带厕所的浴室" },
          },
        },
      },
    });

    const schemas = finishHouseBuildingSchema(sectorSchema, candidate);
    const schema = schemas[candidate.details[0].featureId];
    const rooms = schema.levels.ground_floor.sectors.main.rooms;

    expect(schema.featureId).toBe(candidate.details[0].featureId);
    expect(schema.category).toBe("house");
    expect(schema.centerPosition).toEqual(candidate.centerPosition);
    expect(rooms.bedroom).toEqual({ descrption: "卧室", count: 1, access: "vertical" });
    expect(rooms.living_room).toEqual({
      descrption: "与餐厅、厨房相连的客厅",
      count: 1,
      access: "entrance",
    });
  });

  it("generateBuildingSchema returns the completed schema record", async () => {
    jest.spyOn(Math, "random").mockReturnValue(0);
    mockedQuery.mockResolvedValueOnce({
      rows: [buildDbBuildingRow({ tags: { building: "house", "building:levels": "1" } })],
    } as never);

    const schemas = await generateBuildingSchema("way/123", [], true);

    expect(schemas).toBeDefined();
    expect(Object.keys(schemas || {})).toEqual(["way/123"]);
    expect(schemas?.["way/123"].category).toBe("house");
    expect(schemas?.["way/123"].levels.ground_floor).toBeDefined();
  });

  it("generateBuildingSchema routes standalone garage through accessory schema finalization", async () => {
    jest.spyOn(Math, "random").mockReturnValue(0.99);
    mockedQuery.mockResolvedValueOnce({
      rows: [buildDbBuildingRow({ tags: { building: "garage", "building:levels": "2" } })],
    } as never);

    const schemas = await generateBuildingSchema("way/123", [], true);
    const schema = schemas?.["way/123"];

    expect(schema?.category).toBe("garage");
    expect(Object.keys(schema?.levels || {})).toEqual(["default_floor"]);
    expect(schema?.levels.default_floor.sectors.main.rooms.garage).toEqual({ descrption: "车库", count: 1, access: "entrance" });
    expect(schema?.levels.default_floor.sectors.main.rooms.hall).toBeUndefined();
    expect(schema?.levels.default_floor.sectors.main.rooms.stairwell).toBeUndefined();
  });

  it("generateBuildingSchema supports explicit apartment buildings", async () => {
    jest.spyOn(Math, "random").mockReturnValue(0.99);
    mockedQuery.mockResolvedValueOnce({
      rows: [buildDbBuildingRow({
        area_sqm: 320,
        tags: { building: "apartments", "building:levels": "4" },
      })],
    } as never);

    const schemas = await generateBuildingSchema("way/123", [], true);
    const schema = schemas?.["way/123"];

    expect(schema?.category).toBe("apartment");
    expect(Object.keys(schema?.levels || {})).toEqual(["ground_floor", "residential_floor"]);
    expect(schema?.levels.residential_floor.sectors.main.rooms.standard_suite).toBeDefined();
  });

  it("generateBuildingSchema can classify ambiguous large multi-level residential buildings as apartment utilities", async () => {
    jest.spyOn(Math, "random").mockReturnValue(0);
    mockedQuery
      .mockResolvedValueOnce({
        rows: [buildDbBuildingRow({
          area_sqm: 320,
          tags: { building: "yes", "building:levels": "2" },
        })],
      } as never)
      .mockResolvedValueOnce({ rows: [{ covering_areas: ["landuse:residential"] }] } as never)
      .mockResolvedValueOnce({ rows: [{ road_kinds: [] }] } as never)
      .mockResolvedValueOnce({
        rows: [{
          area_sqm: 320,
          neighbor_sample_count: 1,
          neighbor_average_area_sqm: 120,
          is_simple_rectangle: false,
        }],
      } as never)
      .mockResolvedValueOnce({ rows: [{ has_nearby_parking: false }] } as never);

    const schemas = await generateBuildingSchema("way/123", [], true);
    const schema = schemas?.["way/123"];
    const groundRooms = schema?.levels.ground_floor.sectors.main.rooms;

    expect(schema?.category).toBe("apartment&apartment_utility");
    expect(groundRooms?.mail_room).toEqual({ descrption: "收发室", count: 1 });
    expect(groundRooms?.laundry_room).toEqual({ descrption: "公共洗衣房", count: 1 });
    expect(groundRooms?.gym).toEqual({ descrption: "健身房", count: 1 });
  });

  it("generateBuildingSchema fixes tiny ambiguous residential buildings as tool sheds", async () => {
    jest.spyOn(Math, "random").mockReturnValue(0.99);
    mockedQuery
      .mockResolvedValueOnce({
        rows: [buildDbBuildingRow({
          area_sqm: 20,
          tags: { building: "yes", "building:levels": "1" },
        })],
      } as never)
      .mockResolvedValueOnce({ rows: [{ covering_areas: ["landuse:residential"] }] } as never)
      .mockResolvedValueOnce({ rows: [{ road_kinds: [] }] } as never)
      .mockResolvedValueOnce({
        rows: [{
          area_sqm: 20,
          neighbor_sample_count: 1,
          neighbor_average_area_sqm: 120,
          is_simple_rectangle: true,
        }],
      } as never)
      .mockResolvedValueOnce({ rows: [{ has_nearby_parking: false }] } as never);

    const schemas = await generateBuildingSchema("way/123", [], true);
    const schema = schemas?.["way/123"];

    expect(schema?.category).toBe("tool_shed");
    expect(Object.keys(schema?.levels || {})).toEqual(["default_floor"]);
    expect(schema?.levels.default_floor.sectors.main.rooms.tool_shed).toEqual({
      descrption: "工具屋",
      count: 1,
      access: "entrance",
    });
  });

  it("builds colocated debug existing schemas from the target feature center", async () => {
    mockedQuery.mockResolvedValueOnce({
      rows: [buildDbBuildingRow({ center_lat: 41, center_lon: -84 })],
    } as never);

    const schemas = await buildColocatedDebugBuildingSchemas("way/123", ["house", "garage"]);

    expect(schemas?.map((schema) => schema.category)).toEqual(["house", "garage"]);
    expect(schemas?.map((schema) => schema.centerPosition)).toEqual([
      { lat: 41, lon: -84 },
      { lat: 41, lon: -84 },
    ]);
  });
});

function buildCandidate(overrides: Partial<BuildingCandidate> = {}): BuildingCandidate {
  const featureId = "way/999";

  return {
    featureId,
    scope: "single",
    details: [{
      featureId,
      osmId: 999,
      osmType: "way",
      category: "building",
      geometryType: "POLYGON",
      tags: { building: "yes" },
    }],
    areaSqm: 100,
    centerPosition: { lat: 40, lon: -83 },
    buildingLevels: 1,
    heightMeters: null,
    buildingValue: "yes",
    ...overrides,
  };
}

function buildSectorDistributionSchema(
  candidate: BuildingCandidate,
  input: {
    levels: Record<string, {
      span: number[];
      rooms: SectorDistributionSchem["levels"][string]["sectors"][string]["rooms"];
    }>;
  },
): Record<string, SectorDistributionSchem> {
  return {
    [candidate.details[0].featureId]: {
      levels: Object.fromEntries(
        Object.entries(input.levels).map(([levelKey, level]) => [levelKey, {
          span: level.span,
          sectors: {
            main: {
              area: candidate.areaSqm ?? 0,
              centerPosition: candidate.centerPosition,
              rooms: level.rooms,
            },
          },
        }]),
      ),
    },
  };
}

function buildAccessoryCategorySchemas(candidate: BuildingCandidate) {
  const distribution = decidePatternDistribution(candidate);
  const appliedBaseSchema = applyCategoryBaseSchemasToDistribution(candidate, distribution);
  return buildResidentialAccessoryCategorySchemaFromDistribution(appliedBaseSchema, candidate);
}

function buildDbBuildingRow(overrides: Partial<DbBuildingFeatureDetailRow & {
  area_sqm: number;
  center_lon: number;
  center_lat: number;
}> = {}) {
  return {
    feature_id: "way/123",
    osm_type: "way",
    osm_id: 123,
    category: "building",
    geometry_type: "POLYGON",
    tags: { building: "house" },
    relations: [],
    meta: {},
    tainted: false,
    contained_pois: [],
    outline_references: [],
    area_sqm: 80,
    center_lon: -83,
    center_lat: 40,
    ...overrides,
  };
}

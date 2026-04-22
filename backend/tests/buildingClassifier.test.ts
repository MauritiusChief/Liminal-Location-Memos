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
  buildHouseCategorySchemaFromDistribution,
  finishHouseBuildingSchema,
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
    const rooms = schema.levels.ground_level.rooms;

    expect(schema.theme).toBe("普通的住宅");
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
    const rooms = schemas[candidate.details[0].featureId].levels.ground_level.rooms;

    expect(rooms.living_room).toEqual({ descrption: "客厅" });
    expect(rooms.kitchen).toEqual({ descrption: "带餐厅的厨房" });
    expect(rooms.self).toEqual({ descrption: "self" });
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

    expect(schema.levels.top_level.rooms.top_room).toEqual({ descrption: "顶层房间" });
    expect(schema.levels.ground_level.rooms.ground_room).toEqual({ descrption: "底层房间" });
    expect(schema.levels.ground_level.rooms.whole_room).toEqual({ descrption: "全楼层房间" });
    expect(schema.levels.top_level.rooms.whole_room).toEqual({ descrption: "全楼层房间" });
    expect(schema.levels.top_level.rooms.fallback_room).toEqual({ descrption: "随机房间" });
    expect(schema.levels.ground_level.rooms.fallback_room).toBeUndefined();
  });

  it("finishes a studio house into a complete building schema record", () => {
    jest.spyOn(Math, "random").mockReturnValue(0);
    const candidate = buildCandidate({
      areaSqm: 80,
      buildingLevels: 1,
      categoryRecord: ["house"],
    });
    const sectorSchema = buildSectorDistributionSchema(candidate, {
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

    const schemas = finishHouseBuildingSchema(sectorSchema, candidate);
    const schema = schemas[candidate.details[0].featureId];
    const rooms = schema.levels.ground_level.sectors.main.rooms;

    expect(schema.featureId).toBe(candidate.details[0].featureId);
    expect(schema.category).toBe("house");
    expect(schema.centerPosition).toEqual(candidate.centerPosition);
    expect(rooms.bedroom).toEqual({ descrption: "卧室", count: 1 });
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
    expect(schemas?.["way/123"].levels.ground_level).toBeDefined();
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
    theme: string;
    levels: Record<string, {
      theme: string;
      span: number[];
      rooms: SectorDistributionSchem["levels"][string]["sectors"][string]["rooms"];
    }>;
  },
): Record<string, SectorDistributionSchem> {
  return {
    [candidate.details[0].featureId]: {
      theme: input.theme,
      levels: Object.fromEntries(
        Object.entries(input.levels).map(([levelKey, level]) => [levelKey, {
          theme: level.theme,
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

/// <reference types="jest" />

jest.mock("../src/db/client", () => ({
  query: jest.fn(),
}));

jest.mock("../src/db/sqlLoader", () => ({
  loadServiceSql: jest.fn().mockResolvedValue("SELECT 1"),
}));

import { query } from "../src/db/client";
import { generateBuildingSchema } from "../src/services/gameSystem/buildingClassifier";
import { buildResidentialLevels } from "../src/services/gameSystem/buildingResidential";

describe("building residential schema generation", () => {
  const mockedQuery = jest.mocked(query);

  beforeEach(() => {
    jest.resetAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("generates residential levels for an explicit house", async () => {
    jest.spyOn(Math, "random").mockReturnValue(0);
    mockedQuery.mockResolvedValueOnce({
      rows: [buildDetailRow({
        feature_id: "way/123",
        osm_type: "way",
        osm_id: 123,
        tags: { building: "house", "building:levels": "1" },
        area_sqm: 80,
        center_lon: -83.01,
        center_lat: 40.0,
      })],
    } as never);

    const schema = await generateBuildingSchema("way/123", {});
    const rooms = schema?.levels.ground_level.sectors.main.rooms;

    expect(schema?.featureId).toBe("way/123");
    expect(schema?.category).toBe("house");
    expect(schema?.centerPosition).toEqual({ lat: 40.0, lon: -83.01 });
    expect(rooms?.bedroom).toEqual({ descrption: "卧室", count: 1 });
    expect(rooms?.living_room).toEqual({ descrption: "与餐厅、厨房相连的客厅", count: 1, access: "entrance" });
    expect(rooms?.bath_room).toEqual({ descrption: "带厕所的浴室", count: 1 });
  });

  it("treats house&garage as a composite category", () => {
    jest.spyOn(Math, "random").mockReturnValue(0.99);

    const levels = buildResidentialLevels(
      buildCandidate({ areaSqm: 120, buildingLevels: 1 }),
      "house&garage",
      "standard",
    );
    const groundRooms = levels.ground_level.sectors.main.rooms;

    expect(groundRooms.living_room).toBeDefined();
    expect(groundRooms.kitchen).toBeDefined();
    expect(groundRooms.garage).toEqual({ descrption: "车库", count: 1 });
  });

  it("generates simple base schema rooms for garage and tool_shed", () => {
    const garageLevels = buildResidentialLevels(buildCandidate(), "garage", "garage");
    const shedLevels = buildResidentialLevels(buildCandidate(), "tool_shed", "tool_shed");

    expect(garageLevels.ground_level.sectors.main.rooms.garage).toEqual({ descrption: "车库", count: 1 });
    expect(shedLevels.ground_level.sectors.main.rooms.tool_shed).toEqual({ descrption: "工具屋", count: 1 });
  });

  it("randomly places rooms without prefered on a concrete level", () => {
    jest.spyOn(Math, "random").mockReturnValue(0.99);

    const levels = buildResidentialLevels(
      buildCandidate({ areaSqm: 260, buildingLevels: 2 }),
      "house",
      "elaborate",
    );

    expect(levels.second_level.sectors.main.rooms.closet).toEqual({ descrption: "储物间", count: 1 });
    expect(levels.all_levels.sectors.main.rooms.closet).toBeUndefined();
  });

  it("adds hall and stairwell for larger or multi-level houses", () => {
    jest.spyOn(Math, "random").mockReturnValue(0.99);

    const levels = buildResidentialLevels(
      buildCandidate({ areaSqm: 160, buildingLevels: 2 }),
      "house",
      "standard",
    );

    expect(levels.ground_level.sectors.main.rooms.hall).toEqual({ descrption: "门厅", count: 1, access: "entrance" });
    expect(levels.all_levels.sectors.main.rooms.stairwell).toEqual({ descrption: "楼梯间", count: 1, access: "vertical" });
    expect(levels.ground_level.sectors.main.rooms.living_room).toEqual({ descrption: "客厅", count: 1 });
  });

  it("shares bedroom capacity while preserving at least one bedroom", () => {
    jest.spyOn(Math, "random")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0);

    const levels = buildResidentialLevels(
      buildCandidate({ areaSqm: 60, buildingLevels: 1 }),
      "house",
      "elaborate",
    );
    const rooms = levels.ground_level.sectors.main.rooms;

    expect(rooms.bedroom).toEqual({ descrption: "卧室", count: 1 });
    expect(rooms.kids_bedroom).toBeUndefined();
    expect(rooms.office).toBeUndefined();
  });
});

function buildDetailRow(overrides: Partial<{
  feature_id: string;
  osm_type: string;
  osm_id: number;
  geometry_type: string;
  tags: Record<string, string>;
  relations: Array<{ role: string; rel: number; reltags: Record<string, string> }>;
  outline_references: unknown[];
  meta: Record<string, string | number>;
  tainted: boolean;
  contained_pois: unknown[];
  area_sqm: number;
  center_lon: number;
  center_lat: number;
}> = {}) {
  return {
    feature_id: "way/1",
    osm_type: "way",
    osm_id: 1,
    geometry_type: "POLYGON",
    tags: { building: "yes" },
    relations: [],
    outline_references: [],
    meta: {},
    tainted: false,
    contained_pois: [],
    area_sqm: 100,
    center_lon: -83.0,
    center_lat: 40.0,
    ...overrides,
  };
}

function buildCandidate(overrides: Partial<{
  areaSqm: number | null;
  buildingLevels: number | null;
}> = {}) {
  return {
    scope: "single" as const,
    detail: {
      featureId: "way/999",
      osmId: 999,
      osmType: "way",
      category: "building" as const,
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

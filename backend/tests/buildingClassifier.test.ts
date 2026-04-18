/// <reference types="jest" />

jest.mock("../src/db/client", () => ({
  query: jest.fn(),
}));

jest.mock("../src/db/sqlLoader", () => ({
  loadServiceSql: jest.fn().mockResolvedValue("SELECT 1"),
}));

import { query } from "../src/db/client";
import { generateBuildingSchema } from "../src/services/gameSystem/buildingClassifier";
import {
  determineResidentialBuildingKind,
  selectResidentialPatternKey,
} from "../src/services/gameSystem/buildingResidential";

describe("buildingClassifier", () => {
  const mockedQuery = jest.mocked(query);

  beforeEach(() => {
    jest.resetAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("classifies a small rectangular building as an accessory building", async () => {
    mockedQuery.mockResolvedValue({
      rows: [buildStandaloneRow({
        area_sqm: 30,
        neighbor_sample_count: 4,
        neighbor_average_area_sqm: 80,
        is_simple_rectangle: true,
      })],
    } as never);

    await expect(determineResidentialBuildingKind("way/123")).resolves.toBe("accessory");
  });

  it("classifies a non-rectangular small building as a house", async () => {
    mockedQuery.mockResolvedValue({
      rows: [buildStandaloneRow({
        area_sqm: 30,
        neighbor_sample_count: 4,
        neighbor_average_area_sqm: 80,
        is_simple_rectangle: false,
      })],
    } as never);

    await expect(determineResidentialBuildingKind("way/123")).resolves.toBe("house");
  });

  it("classifies a building above the absolute area cutoff as a house", async () => {
    mockedQuery.mockResolvedValue({
      rows: [buildStandaloneRow({
        area_sqm: 46,
        neighbor_sample_count: 4,
        neighbor_average_area_sqm: 100,
        is_simple_rectangle: true,
      })],
    } as never);

    await expect(determineResidentialBuildingKind("way/123")).resolves.toBe("house");
  });

  it("classifies a building that is not small relative to neighbors as a house", async () => {
    mockedQuery.mockResolvedValue({
      rows: [buildStandaloneRow({
        area_sqm: 30,
        neighbor_sample_count: 4,
        neighbor_average_area_sqm: 40,
        is_simple_rectangle: true,
      })],
    } as never);

    await expect(determineResidentialBuildingKind("way/123")).resolves.toBe("house");
  });

  it("classifies a building as a house when nearby samples are insufficient", async () => {
    mockedQuery.mockResolvedValue({
      rows: [buildStandaloneRow({
        area_sqm: 30,
        neighbor_sample_count: 0,
        neighbor_average_area_sqm: 80,
        is_simple_rectangle: true,
      })],
    } as never);

    await expect(determineResidentialBuildingKind("way/123")).resolves.toBe("house");
  });

  it("classifies a building as a house when the target row is missing", async () => {
    mockedQuery.mockResolvedValue({ rows: [] } as never);

    await expect(determineResidentialBuildingKind("way/123")).resolves.toBe("house");
  });

  it("classifies an explicit house directly", async () => {
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

    expect(schema?.featureId).toBe("way/123");
    expect(schema?.category).toBe("house");
    expect(schema?.centerPosition).toEqual({ lat: 40.0, lon: -83.01 });
  });

  it("returns undefined for unresolved buildings when skipComplex is true", async () => {
    mockedQuery
      .mockResolvedValueOnce({
        rows: [buildDetailRow({
          feature_id: "way/500",
          osm_type: "way",
          osm_id: 500,
          tags: { building: "yes" },
          area_sqm: 150,
          center_lon: -83.02,
          center_lat: 40.01,
        })],
      } as never)
      .mockResolvedValueOnce({
        rows: [{ covering_areas: ["landuse:commercial"] }],
      } as never)
      .mockResolvedValueOnce({
        rows: [{ road_kinds: [] }],
      } as never);

    await expect(generateBuildingSchema("way/500", {}, true)).resolves.toBeUndefined();
  });

  it("returns house for a house-like residential building when nearby parking exists", async () => {
    jest.spyOn(Math, "random").mockReturnValue(0);
    mockedQuery
      .mockResolvedValueOnce({
        rows: [buildDetailRow({
          feature_id: "way/700",
          osm_type: "way",
          osm_id: 700,
          tags: { building: "yes" },
          area_sqm: 95,
          center_lon: -83.012,
          center_lat: 40.002,
        })],
      } as never)
      .mockResolvedValueOnce({
        rows: [{ covering_areas: ["landuse:residential"] }],
      } as never)
      .mockResolvedValueOnce({
        rows: [{ road_kinds: ["highway:residential", "highway:service"] }],
      } as never)
      .mockResolvedValueOnce({
        rows: [buildStandaloneRow({
          area_sqm: 95,
          neighbor_sample_count: 5,
          neighbor_average_area_sqm: 110,
          is_simple_rectangle: false,
        })],
      } as never)
      .mockResolvedValueOnce({
        rows: [{ has_nearby_parking: true }],
      } as never);

    const schema = await generateBuildingSchema("way/700", {});

    expect(schema?.category).toBe("house");
  });

  it("returns house for a house-like residential building when a nearby garage schema exists", async () => {
    jest.spyOn(Math, "random").mockReturnValue(0);
    mockedQuery
      .mockResolvedValueOnce({
        rows: [buildDetailRow({
          feature_id: "way/701",
          osm_type: "way",
          osm_id: 701,
          tags: { building: "yes" },
          area_sqm: 95,
          center_lon: -83.012,
          center_lat: 40.002,
        })],
      } as never)
      .mockResolvedValueOnce({
        rows: [{ covering_areas: ["landuse:residential"] }],
      } as never)
      .mockResolvedValueOnce({
        rows: [{ road_kinds: ["highway:residential"] }],
      } as never)
      .mockResolvedValueOnce({
        rows: [buildStandaloneRow({
          area_sqm: 95,
          neighbor_sample_count: 5,
          neighbor_average_area_sqm: 110,
          is_simple_rectangle: false,
        })],
      } as never)
      .mockResolvedValueOnce({
        rows: [{ has_nearby_parking: false }],
      } as never);

    const schema = await generateBuildingSchema("way/701", {
      "way/10": buildExistingSchema("way/10", "garage", 40.00205, -83.01205),
    });

    expect(schema?.category).toBe("house");
  });

  it("returns house&garage for a house-like residential building without parking or garage when random favors the composite", async () => {
    jest.spyOn(Math, "random").mockReturnValue(0);
    mockedQuery
      .mockResolvedValueOnce({
        rows: [buildDetailRow({
          feature_id: "way/702",
          osm_type: "way",
          osm_id: 702,
          tags: { building: "yes", "building:levels": "1" },
          area_sqm: 95,
          center_lon: -83.012,
          center_lat: 40.002,
        })],
      } as never)
      .mockResolvedValueOnce({
        rows: [{ covering_areas: ["landuse:residential"] }],
      } as never)
      .mockResolvedValueOnce({
        rows: [{ road_kinds: ["highway:residential"] }],
      } as never)
      .mockResolvedValueOnce({
        rows: [buildStandaloneRow({
          area_sqm: 95,
          neighbor_sample_count: 5,
          neighbor_average_area_sqm: 110,
          is_simple_rectangle: false,
        })],
      } as never)
      .mockResolvedValueOnce({
        rows: [{ has_nearby_parking: false }],
      } as never);

    const schema = await generateBuildingSchema("way/702", {});

    expect(schema?.category).toBe("house&garage");
  });

  it("returns house for a house-like residential building without parking or garage when random rejects the composite", async () => {
    jest.spyOn(Math, "random").mockReturnValue(0.95);
    mockedQuery
      .mockResolvedValueOnce({
        rows: [buildDetailRow({
          feature_id: "way/703",
          osm_type: "way",
          osm_id: 703,
          tags: { building: "yes" },
          area_sqm: 95,
          center_lon: -83.012,
          center_lat: 40.002,
        })],
      } as never)
      .mockResolvedValueOnce({
        rows: [{ covering_areas: ["landuse:residential"] }],
      } as never)
      .mockResolvedValueOnce({
        rows: [{ road_kinds: ["highway:residential"] }],
      } as never)
      .mockResolvedValueOnce({
        rows: [buildStandaloneRow({
          area_sqm: 95,
          neighbor_sample_count: 5,
          neighbor_average_area_sqm: 110,
          is_simple_rectangle: false,
        })],
      } as never)
      .mockResolvedValueOnce({
        rows: [{ has_nearby_parking: false }],
      } as never);

    const schema = await generateBuildingSchema("way/703", {});

    expect(schema?.category).toBe("house");
  });

  it("returns tool_shed for an accessory building when a nearby house&garage schema exists", async () => {
    jest.spyOn(Math, "random").mockReturnValue(0);
    mockedQuery
      .mockResolvedValueOnce({
        rows: [buildDetailRow({
          feature_id: "way/704",
          osm_type: "way",
          osm_id: 704,
          tags: { building: "yes" },
          area_sqm: 30,
          center_lon: -83.012,
          center_lat: 40.002,
        })],
      } as never)
      .mockResolvedValueOnce({
        rows: [{ covering_areas: ["landuse:residential"] }],
      } as never)
      .mockResolvedValueOnce({
        rows: [{ road_kinds: ["highway:residential"] }],
      } as never)
      .mockResolvedValueOnce({
        rows: [buildStandaloneRow({
          area_sqm: 30,
          neighbor_sample_count: 5,
          neighbor_average_area_sqm: 110,
          is_simple_rectangle: true,
        })],
      } as never)
      .mockResolvedValueOnce({
        rows: [{ has_nearby_parking: false }],
      } as never);

    const schema = await generateBuildingSchema("way/704", {
      "way/20": buildExistingSchema("way/20", "house&garage", 40.00205, -83.01205),
    });

    expect(schema?.category).toBe("tool_shed");
  });

  it("returns tool_shed for an accessory building with nearby parking when random favors tool_shed", async () => {
    jest.spyOn(Math, "random").mockReturnValue(0);
    mockedQuery
      .mockResolvedValueOnce({
        rows: [buildDetailRow({
          feature_id: "way/705",
          osm_type: "way",
          osm_id: 705,
          tags: { building: "yes" },
          area_sqm: 30,
          center_lon: -83.012,
          center_lat: 40.002,
        })],
      } as never)
      .mockResolvedValueOnce({
        rows: [{ covering_areas: ["landuse:residential"] }],
      } as never)
      .mockResolvedValueOnce({
        rows: [{ road_kinds: ["highway:residential"] }],
      } as never)
      .mockResolvedValueOnce({
        rows: [buildStandaloneRow({
          area_sqm: 30,
          neighbor_sample_count: 5,
          neighbor_average_area_sqm: 110,
          is_simple_rectangle: true,
        })],
      } as never)
      .mockResolvedValueOnce({
        rows: [{ has_nearby_parking: true }],
      } as never);

    const schema = await generateBuildingSchema("way/705", {});

    expect(schema?.category).toBe("tool_shed");
  });

  it("returns garage for an accessory building with nearby parking when random rejects tool_shed", async () => {
    jest.spyOn(Math, "random").mockReturnValue(0.95);
    mockedQuery
      .mockResolvedValueOnce({
        rows: [buildDetailRow({
          feature_id: "way/706",
          osm_type: "way",
          osm_id: 706,
          tags: { building: "yes" },
          area_sqm: 30,
          center_lon: -83.012,
          center_lat: 40.002,
        })],
      } as never)
      .mockResolvedValueOnce({
        rows: [{ covering_areas: ["landuse:residential"] }],
      } as never)
      .mockResolvedValueOnce({
        rows: [{ road_kinds: ["highway:residential"] }],
      } as never)
      .mockResolvedValueOnce({
        rows: [buildStandaloneRow({
          area_sqm: 30,
          neighbor_sample_count: 5,
          neighbor_average_area_sqm: 110,
          is_simple_rectangle: true,
        })],
      } as never)
      .mockResolvedValueOnce({
        rows: [{ has_nearby_parking: true }],
      } as never);

    const schema = await generateBuildingSchema("way/706", {});

    expect(schema?.category).toBe("garage");
  });

  it("returns garage for an accessory building without parking or composite house when random favors garage", async () => {
    jest.spyOn(Math, "random").mockReturnValue(0);
    mockedQuery
      .mockResolvedValueOnce({
        rows: [buildDetailRow({
          feature_id: "way/707",
          osm_type: "way",
          osm_id: 707,
          tags: { building: "yes" },
          area_sqm: 30,
          center_lon: -83.012,
          center_lat: 40.002,
        })],
      } as never)
      .mockResolvedValueOnce({
        rows: [{ covering_areas: ["landuse:residential"] }],
      } as never)
      .mockResolvedValueOnce({
        rows: [{ road_kinds: ["highway:residential"] }],
      } as never)
      .mockResolvedValueOnce({
        rows: [buildStandaloneRow({
          area_sqm: 30,
          neighbor_sample_count: 5,
          neighbor_average_area_sqm: 110,
          is_simple_rectangle: true,
        })],
      } as never)
      .mockResolvedValueOnce({
        rows: [{ has_nearby_parking: false }],
      } as never);

    const schema = await generateBuildingSchema("way/707", {});

    expect(schema?.category).toBe("garage");
  });

  it("returns tool_shed for an accessory building without parking or composite house when random rejects garage", async () => {
    jest.spyOn(Math, "random").mockReturnValue(0.95);
    mockedQuery
      .mockResolvedValueOnce({
        rows: [buildDetailRow({
          feature_id: "way/708",
          osm_type: "way",
          osm_id: 708,
          tags: { building: "yes" },
          area_sqm: 30,
          center_lon: -83.012,
          center_lat: 40.002,
        })],
      } as never)
      .mockResolvedValueOnce({
        rows: [{ covering_areas: ["landuse:residential"] }],
      } as never)
      .mockResolvedValueOnce({
        rows: [{ road_kinds: ["highway:residential"] }],
      } as never)
      .mockResolvedValueOnce({
        rows: [buildStandaloneRow({
          area_sqm: 30,
          neighbor_sample_count: 5,
          neighbor_average_area_sqm: 110,
          is_simple_rectangle: true,
        })],
      } as never)
      .mockResolvedValueOnce({
        rows: [{ has_nearby_parking: false }],
      } as never);

    const schema = await generateBuildingSchema("way/708", {});

    expect(schema?.category).toBe("tool_shed");
  });

  it("keeps house&garage on the residential pattern pool instead of treating it as a simple pattern", () => {
    jest.spyOn(Math, "random").mockReturnValue(0);

    const patternKey = selectResidentialPatternKey(buildCandidate({
      areaSqm: 85,
      buildingLevels: 1,
    }), "house&garage");

    expect(patternKey).toBe("studio");
  });

  it("does not classify an untagged building as residential when non-residential area weight dominates", async () => {
    jest.spyOn(Math, "random").mockReturnValue(0.99);
    mockedQuery
      .mockResolvedValueOnce({
        rows: [buildDetailRow({
          feature_id: "way/709",
          osm_type: "way",
          osm_id: 709,
          tags: { building: "yes" },
          area_sqm: 95,
          center_lon: -83.02,
          center_lat: 40.03,
        })],
      } as never)
      .mockResolvedValueOnce({
        rows: [{ covering_areas: ["landuse:commercial"] }],
      } as never)
      .mockResolvedValueOnce({
        rows: [{ road_kinds: ["highway:residential"] }],
      } as never);

    await expect(generateBuildingSchema("way/709", {}, true)).resolves.toBeUndefined();
  });
});

function buildStandaloneRow(overrides: Partial<{
  area_sqm: number;
  neighbor_sample_count: number;
  neighbor_average_area_sqm: number;
  is_simple_rectangle: boolean;
}> = {}) {
  return {
    area_sqm: 30,
    neighbor_sample_count: 4,
    neighbor_average_area_sqm: 80,
    is_simple_rectangle: true,
    ...overrides,
  };
}

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

function buildExistingSchema(featureId: string, category: string, lat: number, lon: number) {
  return {
    featureId,
    category,
    centerPosition: { lat, lon },
    theme: "default",
    levels: {},
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

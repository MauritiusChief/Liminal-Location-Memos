/// <reference types="jest" />

jest.mock("../src/db/client", () => ({
  query: jest.fn(),
}));

jest.mock("../src/db/sqlLoader", () => ({
  loadServiceSql: jest.fn().mockResolvedValue("SELECT 1"),
}));

import { query } from "../src/db/client";
import {
  generateBuildingSchema,
  isStandaloneResidentialBuilding,
} from "../src/services/gameSystem/buildingClassifier";

describe("buildingClassifier", () => {
  const mockedQuery = jest.mocked(query);

  beforeEach(() => {
    jest.resetAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("returns false for a small rectangular building that is clearly smaller than its neighbors", async () => {
    mockedQuery.mockResolvedValue({
      rows: [buildStandaloneRow({
        area_sqm: 30,
        neighbor_sample_count: 4,
        neighbor_average_area_sqm: 80,
        is_simple_rectangle: true,
      })],
    } as never);

    await expect(isStandaloneResidentialBuilding("way/123")).resolves.toBe(false);
  });

  it("returns true when the building is small but not a simple rectangle", async () => {
    mockedQuery.mockResolvedValue({
      rows: [buildStandaloneRow({
        area_sqm: 30,
        neighbor_sample_count: 4,
        neighbor_average_area_sqm: 80,
        is_simple_rectangle: false,
      })],
    } as never);

    await expect(isStandaloneResidentialBuilding("way/123")).resolves.toBe(true);
  });

  it("returns true when the building exceeds the absolute area cutoff", async () => {
    mockedQuery.mockResolvedValue({
      rows: [buildStandaloneRow({
        area_sqm: 46,
        neighbor_sample_count: 4,
        neighbor_average_area_sqm: 100,
        is_simple_rectangle: true,
      })],
    } as never);

    await expect(isStandaloneResidentialBuilding("way/123")).resolves.toBe(true);
  });

  it("returns true when the building is not small enough relative to its neighbors", async () => {
    mockedQuery.mockResolvedValue({
      rows: [buildStandaloneRow({
        area_sqm: 30,
        neighbor_sample_count: 4,
        neighbor_average_area_sqm: 40,
        is_simple_rectangle: true,
      })],
    } as never);

    await expect(isStandaloneResidentialBuilding("way/123")).resolves.toBe(true);
  });

  it("returns true when nearby building samples are insufficient", async () => {
    mockedQuery.mockResolvedValue({
      rows: [buildStandaloneRow({
        area_sqm: 30,
        neighbor_sample_count: 0,
        neighbor_average_area_sqm: 80,
        is_simple_rectangle: true,
      })],
    } as never);

    await expect(isStandaloneResidentialBuilding("way/123")).resolves.toBe(true);
  });

  it("returns true when the target building is missing in SQL results", async () => {
    mockedQuery.mockResolvedValue({ rows: [] } as never);

    await expect(isStandaloneResidentialBuilding("way/123")).resolves.toBe(true);
  });

  it("classifies a standalone house and picks a residential pattern", async () => {
    jest.spyOn(Math, "random").mockReturnValue(0);
    mockedQuery
      .mockResolvedValueOnce({
        rows: [buildDetailRow({
          feature_id: "way/123",
          osm_type: "way",
          osm_id: 123,
          tags: { building: "house", "building:levels": "1" },
          area_sqm: 80,
        })],
      } as never)
      .mockResolvedValueOnce({
        rows: [buildStandaloneRow({
          area_sqm: 80,
          neighbor_sample_count: 4,
          neighbor_average_area_sqm: 70,
          is_simple_rectangle: false,
        })],
      } as never);

    const schema = await generateBuildingSchema("way/123");

    expect(schema?.featureId).toBe("way/123");
  });

  it("returns undefined for unresolved buildings when skipComplex is true", async () => {
    mockedQuery.mockResolvedValueOnce({
      rows: [buildDetailRow({
        feature_id: "way/500",
        osm_type: "way",
        osm_id: 500,
        tags: { building: "commercial" },
        area_sqm: 150,
      })],
    } as never);

    await expect(generateBuildingSchema("way/500", true)).resolves.toBeUndefined();
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
  outline_references: any[];
  meta: Record<string, string | number>;
  tainted: boolean;
  contained_pois: any[];
  area_sqm: number;
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
    ...overrides,
  };
}

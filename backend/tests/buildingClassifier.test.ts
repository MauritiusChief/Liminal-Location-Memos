/// <reference types="jest" />

jest.mock("../src/db/client", () => ({
  query: jest.fn(),
}));

jest.mock("../src/db/sqlLoader", () => ({
  loadServiceSql: jest.fn().mockResolvedValue("SELECT 1"),
}));

import { query } from "../src/db/client";
import {
  isStandaloneResidentialBuilding,
  type StandaloneResidentialCandidate,
} from "../src/services/gameSystem/buildingClassifier";

describe("buildingClassifier", () => {
  const mockedQuery = jest.mocked(query);
  const candidate: StandaloneResidentialCandidate = {
    featureId: "way/123",
    category: "building",
    tags: {},
  };

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("returns false for a small rectangular building that is clearly smaller than its neighbors", async () => {
    mockedQuery.mockResolvedValue({
      rows: [{
        area_sqm: 30,
        neighbor_sample_count: 4,
        neighbor_average_area_sqm: 80,
        is_simple_rectangle: true,
      }],
    } as never);

    await expect(isStandaloneResidentialBuilding(candidate)).resolves.toBe(false);
  });

  it("returns true when the building is small but not a simple rectangle", async () => {
    mockedQuery.mockResolvedValue({
      rows: [{
        area_sqm: 30,
        neighbor_sample_count: 4,
        neighbor_average_area_sqm: 80,
        is_simple_rectangle: false,
      }],
    } as never);

    await expect(isStandaloneResidentialBuilding(candidate)).resolves.toBe(true);
  });

  it("returns true when the building exceeds the absolute area cutoff", async () => {
    mockedQuery.mockResolvedValue({
      rows: [{
        area_sqm: 46,
        neighbor_sample_count: 4,
        neighbor_average_area_sqm: 100,
        is_simple_rectangle: true,
      }],
    } as never);

    await expect(isStandaloneResidentialBuilding(candidate)).resolves.toBe(true);
  });

  it("returns true when the building is not small enough relative to its neighbors", async () => {
    mockedQuery.mockResolvedValue({
      rows: [{
        area_sqm: 30,
        neighbor_sample_count: 4,
        neighbor_average_area_sqm: 40,
        is_simple_rectangle: true,
      }],
    } as never);

    await expect(isStandaloneResidentialBuilding(candidate)).resolves.toBe(true);
  });

  it("returns true when nearby building samples are insufficient", async () => {
    mockedQuery.mockResolvedValue({
      rows: [{
        area_sqm: 30,
        neighbor_sample_count: 2,
        neighbor_average_area_sqm: 80,
        is_simple_rectangle: true,
      }],
    } as never);

    await expect(isStandaloneResidentialBuilding(candidate)).resolves.toBe(true);
  });

  it("returns true when the target building is missing in SQL results", async () => {
    mockedQuery.mockResolvedValue({ rows: [] } as never);

    await expect(isStandaloneResidentialBuilding(candidate)).resolves.toBe(true);
  });
});

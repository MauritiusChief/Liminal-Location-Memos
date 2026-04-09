/// <reference types="jest" />

jest.mock("../src/db/client", () => ({
  query: jest.fn(),
}));

jest.mock("overpass-ts", () => ({
  overpassJson: jest.fn(),
}));

jest.mock("../src/services/osmNormalization/osmNormalizer", () => ({
  convertOverpassToNormalizedFeatures: jest.fn(),
}));

jest.mock("../src/services/osmNormalization/osmNormalizedToDb", () => ({
  syncNormalizedFeaturesToDb: jest.fn(),
}));

import { query } from "../src/db/client";
import { overpassJson } from "overpass-ts";
import { convertOverpassToNormalizedFeatures } from "../src/services/osmNormalization/osmNormalizer";
import { syncNormalizedFeaturesToDb } from "../src/services/osmNormalization/osmNormalizedToDb";
import {
  ensureOsmCoverageForRequest,
  OsmCoverageSyncRetryExhaustedError,
  syncOverpassCoverage,
} from "../src/services/osmNormalization/osmGate";

describe("osmGate", () => {
  const mockedQuery = jest.mocked(query);
  const mockedOverpassJson = jest.mocked(overpassJson);
  const mockedConvertOverpassToNormalizedFeatures = jest.mocked(convertOverpassToNormalizedFeatures);
  const mockedSyncNormalizedFeaturesToDb = jest.mocked(syncNormalizedFeaturesToDb);

  beforeEach(() => {
    jest.resetAllMocks();
    mockedConvertOverpassToNormalizedFeatures.mockReturnValue([]);
    mockedSyncNormalizedFeaturesToDb.mockResolvedValue({
      buildings: 0,
      pois: 0,
      lines: 0,
      areas: 0,
    });
  });

  it("syncs 1000m coverage when no prior coverage record exists", async () => {
    mockedQuery.mockResolvedValue({ rows: [] } as never);
    mockedOverpassJson.mockResolvedValue({ elements: [] } as never);

    await ensureOsmCoverageForRequest({ lat: 1, lon: 2, radius: 300 });

    expect(mockedOverpassJson).toHaveBeenCalledTimes(1);
    expect(mockedSyncNormalizedFeaturesToDb).toHaveBeenCalledWith(
      [],
      expect.objectContaining({ lat: 1, lon: 2, radius: 1000 }),
    );
  });

  it("reuses coverage when the nearest center is within 500 meters", async () => {
    mockedQuery.mockResolvedValue({
      rows: [{ distance_meters: 500 }],
    } as never);

    await ensureOsmCoverageForRequest({ lat: 1, lon: 2, radius: 300 });

    expect(mockedOverpassJson).not.toHaveBeenCalled();
    expect(mockedSyncNormalizedFeaturesToDb).not.toHaveBeenCalled();
  });

  it("syncs coverage when the nearest center is farther than 500 meters", async () => {
    mockedQuery.mockResolvedValue({
      rows: [{ distance_meters: 501 }],
    } as never);
    mockedOverpassJson.mockResolvedValue({ elements: [] } as never);

    await ensureOsmCoverageForRequest({ lat: 1, lon: 2, radius: 300 });

    expect(mockedOverpassJson).toHaveBeenCalledTimes(1);
    expect(mockedSyncNormalizedFeaturesToDb).toHaveBeenCalledWith(
      [],
      expect.objectContaining({ lat: 1, lon: 2, radius: 1000 }),
    );
  });

  it("retries overpass sync and succeeds on the third attempt", async () => {
    mockedOverpassJson
      .mockRejectedValueOnce(new Error("attempt 1"))
      .mockRejectedValueOnce(new Error("attempt 2"))
      .mockResolvedValueOnce({ elements: [] } as never);

    await expect(syncOverpassCoverage({ lat: 1, lon: 2, radius: 1000 })).resolves.toEqual(
      expect.objectContaining({
        features: [],
        counts: 0,
      }),
    );

    expect(mockedOverpassJson).toHaveBeenCalledTimes(3);
  });

  it("throws an explicit error after retry budget is exhausted", async () => {
    mockedOverpassJson.mockRejectedValue(new Error("down"));

    await expect(syncOverpassCoverage({ lat: 1, lon: 2, radius: 1000 })).rejects.toBeInstanceOf(
      OsmCoverageSyncRetryExhaustedError,
    );

    expect(mockedOverpassJson).toHaveBeenCalledTimes(3);
  });
});

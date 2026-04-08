/// <reference types="jest" />

jest.mock("@/db/client.js", () => ({
  query: jest.fn(),
}));

jest.mock("@/db/sqlLoader.js", () => ({
  loadServiceSql: jest.fn(async () => "SELECT 1"),
}));

jest.mock("@/routes/apiTypes.js", () => ({}), { virtual: true });

import { query } from "../src/db/client";
import { bearingBetweenCoordinates } from "../src/services/geometry";
import { buildComputedMicroGridCells, fetchMicroGridFromDb } from "../src/services/scene/microGridObject";

const mockedQuery = jest.mocked(query);

describe("microGridObject", () => {
  beforeEach(() => {
    mockedQuery.mockReset();
  });

  it("builds a 12x12 rotated grid in TypeScript", () => {
    const origin = { lat: 39.9, lon: -83.0 };
    const northFacingCells = buildComputedMicroGridCells(origin, 0);
    const eastFacingCells = buildComputedMicroGridCells(origin, 90);

    expect(northFacingCells).toHaveLength(144);
    expect(eastFacingCells).toHaveLength(144);

    const northFacingTopLeft = northFacingCells.find((cell) => cell.row === 0 && cell.col === 0);
    const eastFacingTopLeft = eastFacingCells.find((cell) => cell.row === 0 && cell.col === 0);

    expect(northFacingTopLeft?.bbox).toHaveLength(4);
    expect(eastFacingTopLeft?.bbox).toHaveLength(4);

    const northFacingBearing = bearingBetweenCoordinates([origin.lon, origin.lat], northFacingTopLeft!.center);
    const eastFacingBearing = bearingBetweenCoordinates([origin.lon, origin.lat], eastFacingTopLeft!.center);

    expect(northFacingBearing).toBeCloseTo(315, 0);
    expect(eastFacingBearing).toBeCloseTo(45, 0);
  });

  it("sends one batched JSON payload to SQL and maps returned rows", async () => {
    mockedQuery.mockResolvedValue({
      rows: [
        {
          row: 0,
          col: 0,
          center_lon: -83.0001,
          center_lat: 39.9001,
          base_kind: "building",
          base_feature_id: "way/1",
          poi_feature_ids: ["node/2"],
          road_feature_ids: ["way/3"],
        },
      ],
    } as unknown as Awaited<ReturnType<typeof query>>);

    const rows = await fetchMicroGridFromDb({ lat: 39.9, lon: -83.0, radius: 100 }, 90);

    expect(mockedQuery).toHaveBeenCalledTimes(1);
    const [, params] = mockedQuery.mock.calls[0]!;
    const serializedCells = JSON.parse(String(params?.[0]));

    expect(serializedCells).toHaveLength(144);
    expect(serializedCells[0]).toMatchObject({
      row: 0,
      col: 0,
    });
    expect(serializedCells[0].bbox_wkt).toMatch(/^POLYGON\(\(/);

    expect(rows).toEqual([
      {
        row: 0,
        col: 0,
        center: [-83.0001, 39.9001],
        baseKind: "building",
        baseFeatureId: "way/1",
        poiFeatureIds: ["node/2"],
        roadFeatureIds: ["way/3"],
      },
    ]);
  });
});

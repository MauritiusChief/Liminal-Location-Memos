/// <reference types="jest" />

jest.mock("@/db/client.js", () => ({
  query: jest.fn(),
}), { virtual: true });

jest.mock("@/db/sqlLoader.js", () => ({
  loadServiceSql: jest.fn(async () => ""),
}), { virtual: true });

jest.mock("@/routes/apiTypes.js", () => ({}), { virtual: true });

import {
  applyPolarViewFeatureMarkder,
  buildMatricedPolarViewFeature,
  buildPolarView,
  type SampledPolarViewFeature,
} from "../src/services/scene/polarViewObject";

function buildTestRequest() {
  return {
    lat: 0,
    lon: 0,
    radius: 500,
  };
}

describe("polarViewObject metrics", () => {
  it("builds shared metrics first and line metrics on top", () => {
    const features: SampledPolarViewFeature[] = [
      {
        featureId: "building/1",
        osmId: 1,
        category: "building",
        geometryType: "Polygon",
        sampleCoordinates: [
          [0.0004, 0],
          [0.0005, 0.0001],
          [0.0006, 0],
        ],
        centerCoordinate: null,
      },
      {
        featureId: "line/1",
        osmId: 2,
        category: "line",
        geometryType: "LineString",
        sampleCoordinates: [
          [0.001, 0],
          [0.001, 0],
          [0.0015, 0],
          [0.002, 0],
          [0.0025, 0],
        ],
        centerCoordinate: [0.002, 0],
      },
      {
        featureId: "invalid/1",
        osmId: 3,
        category: "line",
        geometryType: "LineString",
        sampleCoordinates: [[0.003, 0]],
        centerCoordinate: null,
      },
    ];

    const metriced = buildMatricedPolarViewFeature(buildTestRequest(), features);

    expect(metriced).toHaveLength(2);

    const building = metriced.find((feature) => feature.featureId === "building/1");
    const line = metriced.find((feature) => feature.featureId === "line/1");

    expect(building).toMatchObject({
      category: "building",
      osmId: 1,
      geometryType: "Polygon",
    });
    expect(building?.nearestPoint.distanceMeters).toBeLessThan(building?.farthestPoint.distanceMeters ?? 0);
    expect(building?.centerPoint.coordinate).toEqual([0.0004, 0]);
    expect(building?.linePath).toBeUndefined();
    expect(building?.linePoints).toBeUndefined();
    expect(building?.orientationDegrees).toBeUndefined();

    expect(line).toMatchObject({
      category: "line",
      osmId: 2,
      geometryType: "LineString",
    });
    expect(line?.nearestPoint.distanceMeters).toBeCloseTo(111.195, 1);
    expect(line?.farthestPoint.distanceMeters).toBeCloseTo(277.988, 1);
    expect(line?.centerPoint.coordinate).toEqual([0.002, 0]);
    expect(line?.linePath).toHaveLength(4);
    expect(line?.linePoints).toHaveLength(4);
    expect(line?.orientationDegrees).toBeDefined();
    expect(line?.widestSpan.angleWidthDegrees).toBeGreaterThanOrEqual(0);
  });

  it("keeps level and cluster assembly stable for mixed feature categories", () => {
    const metriced = buildMatricedPolarViewFeature(buildTestRequest(), [
      {
        featureId: "building/2",
        osmId: 4,
        category: "building",
        geometryType: "Polygon",
        sampleCoordinates: [
          [0.00045, 0],
          [0.0005, 0.0001],
          [0.00055, 0],
        ],
        centerCoordinate: null,
      },
      {
        featureId: "line/2",
        osmId: 5,
        category: "line",
        geometryType: "LineString",
        sampleCoordinates: [
          [0.001, 0],
          [0.0015, 0],
          [0.002, 0],
          [0.0025, 0],
        ],
        centerCoordinate: [0.002, 0],
      },
    ]);

    const marked = applyPolarViewFeatureMarkder(metriced);
    const polarView = buildPolarView(buildTestRequest(), marked);

    expect(marked.map((feature) => feature.featureId).sort()).toEqual(["building/2", "line/2"]);
    expect(marked.find((feature) => feature.featureId === "building/2")?.levelMarker).toBe(1);
    expect(marked.find((feature) => feature.featureId === "line/2")?.levelMarker).toBe(2);

    expect(polarView.levels[0]!.clusters).toHaveLength(1);
    expect(polarView.levels[1]!.clusters).toHaveLength(1);
    expect(polarView.levels[2]!.clusters).toHaveLength(0);
  });

  it("builds line metrics from sampleCoordinates after deduping consecutive points", () => {
    const metriced = buildMatricedPolarViewFeature(buildTestRequest(), [
      {
        featureId: "line/3",
        osmId: 6,
        category: "line",
        geometryType: "LineString",
        sampleCoordinates: [
          [0.001, 0],
          [0.001, 0],
          [0.0015, 0],
          [0.002, 0],
          [0.0025, 0],
          [0.0025, 0],
        ],
        centerCoordinate: null,
      },
    ]);

    expect(metriced).toHaveLength(1);
    expect(metriced[0]?.linePath).toHaveLength(4);
    expect(metriced[0]?.linePoints).toHaveLength(4);
    expect(metriced[0]?.orientationDegrees).toBeDefined();
    expect(metriced[0]?.centerPoint.coordinate).toEqual([0.001, 0]);
  });
});

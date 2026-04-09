/// <reference types="jest" />

jest.mock("@/db/client.js", () => ({
  query: jest.fn(),
}), { virtual: true });

jest.mock("@/db/sqlLoader.js", () => ({
  loadServiceSql: jest.fn(async () => ""),
}), { virtual: true });

jest.mock("@/routes/apiTypes.js", () => ({}), { virtual: true });

import type { FeatureDetail } from "../src/services/featureDetail";
import {
  type SampledPolarViewFeature,
  buildPolarViewFeature
} from "../src/services/scene/polarViewObject";
import {
  applyClusterMarkder,
  buildPolarView,
} from "../src/services/scene/polarViewLabeled";
import { buildLeveledPolarView } from "../src/services/scene/polarViewOcclusion";

function buildTestRequest() {
  return {
    lat: 0,
    lon: 0,
    radius: 500,
  };
}

function buildFeatureDetailsMap(
  features: SampledPolarViewFeature[],
  overrides: Partial<Record<string, Partial<FeatureDetail>>> = {},
): ReadonlyMap<string, FeatureDetail> {
  return new Map(
    features.map((feature) => {
      const override = overrides[feature.featureId] || {};
      const baseTags = buildDefaultTags(feature);

      return [feature.featureId, {
        featureId: feature.featureId,
        osmId: feature.osmId,
        osmType: feature.osmType,
        category: feature.category,
        geometryType: feature.geometryType,
        tags: {
          ...baseTags,
          ...(override.tags || {}),
        },
        meta: override.meta,
        tainted: override.tainted,
        relationReferences: override.relationReferences,
        outlineReferences: override.outlineReferences,
        containedPoisReferences: override.containedPoisReferences,
      } satisfies FeatureDetail];
    }),
  );
}

function buildDefaultTags(feature: SampledPolarViewFeature): Record<string, string> {
  switch (feature.category) {
    case "building":
      return { building: "yes", name: `Building ${feature.osmId}` };
    case "line":
      return { highway: "residential", name: `Road ${feature.osmId}` };
    case "poi":
      return { amenity: "cafe", name: `POI ${feature.osmId}` };
    case "area":
      return { landuse: "park", name: `Area ${feature.osmId}` };
  }
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

    const metriced = buildPolarViewFeature(
      buildTestRequest(),
      features,
      buildFeatureDetailsMap(features),
    );

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
    expect(building?.featureDetail.tags.name).toBe("Building 1");
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
    expect(line?.featureDetail.tags.highway).toBe("residential");
    expect(line?.linePath).toHaveLength(4);
    expect(line?.linePoints).toHaveLength(4);
    expect(line?.orientationDegrees).toBeDefined();
    expect(line?.widestSpan.angleWidthDegrees).toBeGreaterThanOrEqual(0);
  });

  it("keeps level, label and cluster assembly stable for mixed feature categories", () => {
    const features: SampledPolarViewFeature[] = [
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
    ];

    const details = buildFeatureDetailsMap(features, {
      "building/2": { tags: { building: "yes", name: "North Building" } },
      "line/2": { tags: { highway: "residential", name: "East Road" } },
    });
    const metriced = buildPolarViewFeature(buildTestRequest(), features, details);
    const leveled = buildLeveledPolarView(buildTestRequest(), metriced);
    const clustered = applyClusterMarkder(leveled);
    const polarView = buildPolarView(clustered);
    const level1Features = clustered.levels[0]!.features;
    const level2Features = clustered.levels[1]!.features;

    expect(level1Features.map((feature) => feature.featureId)).toEqual(["building/2"]);
    expect(level2Features.map((feature) => feature.featureId)).toEqual(["line/2"]);
    expect(level1Features[0]?.levelMarker).toBe(1);
    expect(level2Features[0]?.levelMarker).toBe(2);
    expect(level1Features[0]?.baseLabel).toBe("North Building | building");
    expect(level2Features[0]?.baseLabel).toBe("highway:residential");
    expect([...level1Features, ...level2Features].every((feature) => typeof feature.clusterMarker === "string")).toBe(true);

    expect(polarView.levels[0]!.clusters).toHaveLength(1);
    expect(polarView.levels[1]!.clusters).toHaveLength(1);
    expect(polarView.levels[2]!.clusters).toHaveLength(0);
    expect(polarView.levels[0]!.clusters[0]!.features[0]!.baseLabel).toBe("North Building | building");
    expect(polarView.levels[1]!.clusters[0]!.features[0]!.baseLabel).toBe("highway:residential");
  });

  it("builds line metrics from sampleCoordinates after deduping consecutive points", () => {
    const features: SampledPolarViewFeature[] = [
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
    ];

    const metriced = buildPolarViewFeature(
      buildTestRequest(),
      features,
      buildFeatureDetailsMap(features),
    );

    expect(metriced).toHaveLength(1);
    expect(metriced[0]?.linePath).toHaveLength(4);
    expect(metriced[0]?.linePoints).toHaveLength(4);
    expect(metriced[0]?.orientationDegrees).toBeDefined();
    expect(metriced[0]?.centerPoint.coordinate).toEqual([0.001, 0]);
  });
});

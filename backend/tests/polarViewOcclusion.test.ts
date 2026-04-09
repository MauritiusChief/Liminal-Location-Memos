/// <reference types="jest" />

jest.mock("@/routes/apiTypes.js", () => ({}), { virtual: true });

import type { FeatureDetail } from "../src/services/featureDetail";
import type { PolarViewFeature } from "../src/services/scene/polarViewObject";
import { applyOcclusion, buildLeveledPolarView } from "../src/services/scene/polarViewOcclusion";

function buildDetail(
  category: FeatureDetail["category"],
  tags: Record<string, string> = {},
): FeatureDetail {
  return {
    featureId: `${category}/detail`,
    osmId: 1,
    category,
    geometryType: category === "line" ? "LineString" : "Polygon",
    tags,
  };
}

function buildFeature(input: {
  featureId: string;
  osmId: number;
  category: "building" | "poi" | "line" | "area";
  bearingDegrees?: number;
  distanceMeters?: number;
  clockwiseEarlyDegree?: number;
  angleWidthDegrees?: number;
  tags?: Record<string, string>;
}): PolarViewFeature {
  const bearingDegrees = input.bearingDegrees ?? 15;
  const distanceMeters = input.distanceMeters ?? 60;
  const angleWidthDegrees = input.angleWidthDegrees ?? 0;
  const clockwiseEarlyDegree = input.clockwiseEarlyDegree ?? bearingDegrees;
  const sample = {
    coordinate: [0.001, 0] as [number, number],
    distanceMeters,
    bearingDegrees,
  };

  return {
    featureId: input.featureId,
    osmId: input.osmId,
    category: input.category,
    geometryType: input.category === "line" ? "LineString" : "Polygon",
    featureDetail: buildDetail(input.category, input.tags),
    centerPoint: sample,
    nearestPoint: sample,
    farthestPoint: { ...sample, distanceMeters: distanceMeters + 20 },
    widestSpan: {
      clockwiseEarlyPoint: { ...sample, bearingDegrees: clockwiseEarlyDegree },
      clockwiseLatePoint: { ...sample, bearingDegrees: clockwiseEarlyDegree + angleWidthDegrees },
      angleWidthDegrees,
    },
  };
}

function applyOcclusionToFeatures(features: PolarViewFeature[]) {
  return applyOcclusion(buildLeveledPolarView({ lat: 0, lon: 0, radius: 1000 }, features));
}

function getLevelFeatureIds(result: ReturnType<typeof applyOcclusion>, level: 1 | 2 | 3, layer?: "a" | "b") {
  return (
    result.levels
      .find((entry) => entry.level === level && entry.layer === layer)?.features
      .map((feature) => feature.featureId) || []
  );
}

describe("applyOcclusion", () => {
  it("lets a level 1 building occlude a level 2 cluster in the same angular span", () => {
    const filtered = applyOcclusionToFeatures([
      buildFeature({
        featureId: "building/l1/occluder",
        osmId: 500,
        category: "building",
        distanceMeters: 60,
        angleWidthDegrees: 30,
        clockwiseEarlyDegree: 10,
      }),
      ...Array.from({ length: 15 }, (_, index) =>
        buildFeature({
          featureId: `building/l2/blocked/${index + 1}`,
          osmId: 510 + index,
          category: "building",
          distanceMeters: 150,
          bearingDegrees: 20,
          angleWidthDegrees: 1,
        }),
      ),
    ]);

    expect(getLevelFeatureIds(filtered, 2)).toEqual([]);
  });

  it("keeps a level 2 cluster when it sits inside a gap left by level 1 buildings", () => {
    const filtered = applyOcclusionToFeatures([
      buildFeature({
        featureId: "building/l1/occluder",
        osmId: 600,
        category: "building",
        distanceMeters: 60,
        angleWidthDegrees: 30,
        clockwiseEarlyDegree: 10,
      }),
      ...Array.from({ length: 15 }, (_, index) =>
        buildFeature({
          featureId: `building/l2/visible/${index + 1}`,
          osmId: 610 + index,
          category: "building",
          distanceMeters: 150,
          bearingDegrees: 60,
          angleWidthDegrees: 1,
        }),
      ),
    ]);

    expect(getLevelFeatureIds(filtered, 2)).toEqual(
      Array.from({ length: 15 }, (_, index) => `building/l2/visible/${index + 1}`),
    );
  });

  it("does not let non-building level 1 features occlude level 2", () => {
    const filtered = applyOcclusionToFeatures([
      buildFeature({
        featureId: "line/l1/occluder",
        osmId: 700,
        category: "line",
        distanceMeters: 60,
        angleWidthDegrees: 30,
        clockwiseEarlyDegree: 10,
      }),
      ...Array.from({ length: 15 }, (_, index) =>
        buildFeature({
          featureId: `building/l2/non-blocked/${index + 1}`,
          osmId: 710 + index,
          category: "building",
          distanceMeters: 150,
          bearingDegrees: 20,
          angleWidthDegrees: 1,
        }),
      ),
    ]);

    expect(getLevelFeatureIds(filtered, 2)).toEqual(
      Array.from({ length: 15 }, (_, index) => `building/l2/non-blocked/${index + 1}`),
    );
  });

  it("lets level 1 buildings occlude level 3 before level 2 is considered", () => {
    const filtered = applyOcclusionToFeatures([
      buildFeature({
        featureId: "building/l1/occluder",
        osmId: 800,
        category: "building",
        distanceMeters: 60,
        angleWidthDegrees: 30,
        clockwiseEarlyDegree: 10,
      }),
      ...Array.from({ length: 20 }, (_, index) =>
        buildFeature({
          featureId: `building/l3/blocked/${index + 1}`,
          osmId: 810 + index,
          category: "building",
          distanceMeters: 400,
          bearingDegrees: 20,
          angleWidthDegrees: 1,
        }),
      ),
    ]);

    expect(getLevelFeatureIds(filtered, 3, "a")).toEqual([]);
  });

  it("lets raw level 2 buildings occlude level 3", () => {
    const filtered = applyOcclusionToFeatures([
      buildFeature({
        featureId: "building/l2/occluder",
        osmId: 900,
        category: "building",
        distanceMeters: 150,
        angleWidthDegrees: 20,
        clockwiseEarlyDegree: 10,
      }),
      ...Array.from({ length: 20 }, (_, index) =>
        buildFeature({
          featureId: `building/l3/blocked-by-l2/${index + 1}`,
          osmId: 910 + index,
          category: "building",
          distanceMeters: 400,
          bearingDegrees: 20,
          angleWidthDegrees: 1,
        }),
      ),
    ]);

    expect(getLevelFeatureIds(filtered, 3, "a")).toEqual([]);
  });

  it("uses raw level 2 buildings as occluders even when they may later be filtered visually", () => {
    const filtered = applyOcclusionToFeatures([
      buildFeature({
        featureId: "building/l2/raw-occluder",
        osmId: 1000,
        category: "building",
        distanceMeters: 150,
        angleWidthDegrees: 11,
        clockwiseEarlyDegree: 10,
      }),
      ...Array.from({ length: 20 }, (_, index) =>
        buildFeature({
          featureId: `building/l3/blocked-by-hidden-l2/${index + 1}`,
          osmId: 1010 + index,
          category: "building",
          distanceMeters: 400,
          bearingDegrees: 15,
          angleWidthDegrees: 1,
        }),
      ),
    ]);

    expect(getLevelFeatureIds(filtered, 2)).toEqual(["building/l2/raw-occluder"]);
    expect(getLevelFeatureIds(filtered, 3, "a")).toEqual([]);
  });

  it("does not let non-building raw level 2 features occlude level 3", () => {
    const filtered = applyOcclusionToFeatures([
      buildFeature({
        featureId: "line/l2/non-occluder",
        osmId: 1100,
        category: "line",
        distanceMeters: 150,
        angleWidthDegrees: 20,
        clockwiseEarlyDegree: 10,
      }),
      ...Array.from({ length: 20 }, (_, index) =>
        buildFeature({
          featureId: `building/l3/not-blocked/${index + 1}`,
          osmId: 1110 + index,
          category: "building",
          distanceMeters: 400,
          bearingDegrees: 20,
          angleWidthDegrees: 1,
        }),
      ),
    ]);

    expect(getLevelFeatureIds(filtered, 3, "a")).toEqual(
      Array.from({ length: 20 }, (_, index) => `building/l3/not-blocked/${index + 1}`),
    );
  });

  it("handles building occlusion spans that cross the 360/0 seam", () => {
    const filtered = applyOcclusionToFeatures([
      buildFeature({
        featureId: "building/l1/seam-occluder",
        osmId: 1400,
        category: "building",
        distanceMeters: 60,
        angleWidthDegrees: 20,
        clockwiseEarlyDegree: 350,
      }),
      ...Array.from({ length: 15 }, (_, index) =>
        buildFeature({
          featureId: `building/l2/seam-blocked/${index + 1}`,
          osmId: 1410 + index,
          category: "building",
          distanceMeters: 150,
          bearingDegrees: 355,
          angleWidthDegrees: 1,
        }),
      ),
      ...Array.from({ length: 15 }, (_, index) =>
        buildFeature({
          featureId: `building/l2/seam-visible/${index + 1}`,
          osmId: 1430 + index,
          category: "building",
          distanceMeters: 150,
          bearingDegrees: 40,
          angleWidthDegrees: 1,
        }),
      ),
    ]);

    expect(getLevelFeatureIds(filtered, 2)).toEqual(
      Array.from({ length: 15 }, (_, index) => `building/l2/seam-visible/${index + 1}`),
    );
  });

  it("keeps a level 2 set when at least one member remains visible through the gap", () => {
    const filtered = applyOcclusionToFeatures([
      buildFeature({
        featureId: "building/l1/occluder",
        osmId: 1500,
        category: "building",
        distanceMeters: 60,
        angleWidthDegrees: 30,
        clockwiseEarlyDegree: 10,
      }),
      buildFeature({
        featureId: "building/l2/hidden-member",
        osmId: 1501,
        category: "building",
        distanceMeters: 150,
        bearingDegrees: 20,
        angleWidthDegrees: 16,
      }),
      buildFeature({
        featureId: "building/l2/visible-member",
        osmId: 1502,
        category: "building",
        distanceMeters: 150,
        bearingDegrees: 60,
        angleWidthDegrees: 16,
      }),
    ]);

    expect(getLevelFeatureIds(filtered, 2)).toEqual(["building/l2/visible-member"]);
  });
});

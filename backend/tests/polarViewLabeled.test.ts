/// <reference types="jest" />

jest.mock("@/routes/apiTypes.js", () => ({}), { virtual: true });

import type { PolarViewFeature } from "../src/services/scene/polarViewObject";
import type { LeveledPolarView } from "../src/services/scene/polarViewOcclusion";
import { applyClusterMarkder, buildPolarView } from "../src/services/scene/polarViewLabeled";

function buildFeature(input: {
  featureId: string;
  osmId: number;
  bearingDegrees: number;
  distanceMeters?: number;
  category?: "building" | "area" | "poi" | "line";
  name?: string;
  tags?: Record<string, string>;
}): PolarViewFeature {
  const distanceMeters = input.distanceMeters ?? 60;
  const category = input.category ?? "building";
  const geometryType = category === "line" ? "LineString" : "Polygon";
  const sample = {
    coordinate: [0.001, 0] as [number, number],
    distanceMeters,
    bearingDegrees: input.bearingDegrees,
  };

  return {
    featureId: input.featureId,
    osmId: input.osmId,
    category,
    geometryType,
    featureDetail: {
      featureId: input.featureId,
      osmId: input.osmId,
      category,
      geometryType,
      tags: input.tags ?? buildTags(category, input.name ?? "Shared"),
    },
    centerPoint: sample,
    nearestPoint: sample,
    farthestPoint: { ...sample, distanceMeters: distanceMeters + 5 },
    widestSpan: {
      clockwiseEarlyPoint: sample,
      clockwiseLatePoint: sample,
      angleWidthDegrees: 0,
    },
  };
}

function buildTags(
  category: "building" | "area" | "poi" | "line",
  name: string,
): Record<string, string> {
  switch (category) {
    case "building":
      return { building: "yes", name };
    case "area":
      return { landuse: "park", name };
    case "poi":
      return { amenity: "cafe", name };
    case "line":
      return { highway: "residential", name };
  }
}

function buildLeveledPolarView(levels: Partial<Record<1 | 2 | 3 | 4, PolarViewFeature[]>>): LeveledPolarView {
  return {
    center: { lat: 0, lon: 0 },
    maxRadiusMeters: 1000,
    levels: [
      { level: 1, distanceRangeMeters: [30, 100], features: levels[1] ?? [] },
      { level: 2, distanceRangeMeters: [100, 300], features: levels[2] ?? [] },
      { level: 3, layer: "a", distanceRangeMeters: [300, 500], features: levels[3] ?? [] },
      { level: 3, layer: "b", distanceRangeMeters: [500, 1000], features: levels[4] ?? [] },
    ],
  };
}

function getClusterMarkersById(clustered: ReturnType<typeof applyClusterMarkder>): Map<string, string> {
  return new Map(
    clustered.levels.flatMap((level) =>
      level.features.map((feature) => [feature.featureId, feature.clusterMarker] as const),
    ),
  );
}

describe("applyClusterMarkder", () => {
  it("marks a singleton as its own feature id", () => {
    const clustered = applyClusterMarkder(buildLeveledPolarView({
      1: [buildFeature({ featureId: "building/1", osmId: 1, bearingDegrees: 20 })],
    }));

    expect(clustered.levels[0]?.features).toHaveLength(1);
    expect(clustered.levels[0]?.features[0]?.clusterMarker).toBe("building/1");
  });

  it("keeps same-label points separated when angular distance exceeds the threshold", () => {
    const clustered = applyClusterMarkder(buildLeveledPolarView({
      1: [
        buildFeature({ featureId: "building/1", osmId: 1, bearingDegrees: 10 }),
        buildFeature({ featureId: "building/2", osmId: 2, bearingDegrees: 30 }),
        buildFeature({ featureId: "building/3", osmId: 3, bearingDegrees: 50 }),
      ],
    }));

    expect(clustered.levels[0]?.features.map((feature) => feature.clusterMarker)).toEqual([
      "building/1",
      "building/2",
      "building/3",
    ]);
  });

  it("clusters nearby same-label level 1 buildings once the density threshold is met", () => {
    const clustered = applyClusterMarkder(buildLeveledPolarView({
      1: [
        buildFeature({ featureId: "building/1", osmId: 1, bearingDegrees: 10 }),
        buildFeature({ featureId: "building/2", osmId: 2, bearingDegrees: 12 }),
        buildFeature({ featureId: "building/3", osmId: 3, bearingDegrees: 14 }),
        buildFeature({ featureId: "building/4", osmId: 4, bearingDegrees: 13 }),
      ],
    }));
    const polarView = buildPolarView(clustered);
    const cluster = polarView.levels[0]?.clusters[0];

    expect(new Set(clustered.levels[0]?.features.map((feature) => feature.clusterMarker))).toEqual(
      new Set(["L1:Shared | building:C0"]),
    );
    expect(clustered.levels[0]?.features.some((feature) => feature.clusterMarker === "PLACE_HOLDER")).toBe(false);
    expect(cluster?.memberCount).toBe(4);
    expect(cluster?.clusterMarker).toBe("L1:Shared | building:C0");
  });

  it("absorbs an earlier noise point into a later cluster expansion", () => {
    const clustered = applyClusterMarkder(buildLeveledPolarView({
      1: [
        buildFeature({ featureId: "building/1", osmId: 1, bearingDegrees: 10.1 }),
        buildFeature({ featureId: "building/2", osmId: 2, bearingDegrees: 14.9 }),
        buildFeature({ featureId: "building/3", osmId: 3, bearingDegrees: 18.9 }),
        buildFeature({ featureId: "building/4", osmId: 4, bearingDegrees: 19.2 }),
      ],
    }));
    const markerById = getClusterMarkersById(clustered);

    expect(markerById.get("building/1")).toBe("L1:Shared | building:C0");
    expect(markerById.get("building/2")).toBe("L1:Shared | building:C0");
    expect(markerById.get("building/3")).toBe("L1:Shared | building:C0");
    expect(markerById.get("building/4")).toBe("L1:Shared | building:C0");
  });

  it("clusters correctly across the 360/0 degree seam", () => {
    const clustered = applyClusterMarkder(buildLeveledPolarView({
      2: [
        buildFeature({ featureId: "line/1", osmId: 1, bearingDegrees: 358, distanceMeters: 180, category: "line" }),
        buildFeature({ featureId: "line/2", osmId: 2, bearingDegrees: 1, distanceMeters: 180, category: "line" }),
        buildFeature({ featureId: "line/3", osmId: 3, bearingDegrees: 3, distanceMeters: 180, category: "line" }),
      ],
    }));

    expect(new Set(clustered.levels[1]?.features.map((feature) => feature.clusterMarker))).toEqual(
      new Set(["L2:highway:residential:C0"]),
    );
    expect(clustered.levels[1]?.features.some((feature) => feature.clusterMarker === "PLACE_HOLDER")).toBe(false);
  });

  it("does not merge features across levels or base labels", () => {
    const clustered = applyClusterMarkder(buildLeveledPolarView({
      1: [
        buildFeature({ featureId: "building/1", osmId: 1, bearingDegrees: 10, name: "North" }),
        buildFeature({ featureId: "building/2", osmId: 2, bearingDegrees: 12, name: "South" }),
        buildFeature({ featureId: "building/3", osmId: 3, bearingDegrees: 14, name: "North" }),
        buildFeature({ featureId: "building/4", osmId: 4, bearingDegrees: 15, name: "North" }),
        buildFeature({ featureId: "building/8", osmId: 8, bearingDegrees: 13, name: "North" }),
      ],
      2: [
        buildFeature({ featureId: "building/5", osmId: 5, bearingDegrees: 13, distanceMeters: 160, name: "North" }),
        buildFeature({ featureId: "building/6", osmId: 6, bearingDegrees: 14, distanceMeters: 170, name: "North" }),
        buildFeature({ featureId: "building/7", osmId: 7, bearingDegrees: 15, distanceMeters: 180, name: "North" }),
      ],
    }));
    const markerById = getClusterMarkersById(clustered);

    expect(markerById.get("building/1")).toBe("L1:North | building:C0");
    expect(markerById.get("building/3")).toBe("L1:North | building:C0");
    expect(markerById.get("building/4")).toBe("L1:North | building:C0");
    expect(markerById.get("building/8")).toBe("L1:North | building:C0");
    expect(markerById.get("building/2")).toBe("building/2");
    expect(markerById.get("building/5")).toBe("L2:North | building:C0");
    expect(markerById.get("building/6")).toBe("L2:North | building:C0");
    expect(markerById.get("building/7")).toBe("L2:North | building:C0");
  });
});

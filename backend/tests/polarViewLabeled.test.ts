/// <reference types="jest" />

jest.mock("@/routes/apiTypes.js", () => ({}), { virtual: true });

import type { MarkedPolarViewFeature } from "../src/services/scene/polarViewLabeled";
import { applyClusterMarkder } from "../src/services/scene/polarViewLabeled";

function buildMarkedFeature(input: {
  featureId: string;
  osmId: number;
  bearingDegrees: number;
  levelMarker?: 1 | 2 | 3;
  baseLabel?: string;
}): MarkedPolarViewFeature {
  const levelMarker = input.levelMarker ?? 1;
  const baseLabel = input.baseLabel ?? "building";
  const sample = {
    coordinate: [0.001, 0] as [number, number],
    distanceMeters: 60,
    bearingDegrees: input.bearingDegrees,
  };

  return {
    featureId: input.featureId,
    osmId: input.osmId,
    category: "building",
    geometryType: "Polygon",
    featureDetail: {
      featureId: input.featureId,
      osmId: input.osmId,
      category: "building",
      geometryType: "Polygon",
      tags: { building: "yes", name: input.featureId },
    },
    centerPoint: sample,
    nearestPoint: sample,
    farthestPoint: { ...sample, distanceMeters: 65 },
    widestSpan: {
      clockwiseEarlyPoint: sample,
      clockwiseLatePoint: sample,
      angleWidthDegrees: 0,
    },
    clusterMarker: "PLACE_HOLDER",
    levelMarker,
    baseLabel,
  };
}

describe("applyClusterMarkder", () => {
  it("marks a singleton as its own feature id instead of leaving PLACE_HOLDER", () => {
    const features = [
      buildMarkedFeature({ featureId: "building/1", osmId: 1, bearingDegrees: 20 }),
    ];

    const clustered = applyClusterMarkder(features);

    expect(clustered).toHaveLength(1);
    expect(clustered[0]?.clusterMarker).toBe("building/1");
  });

  it("marks non-clustered points as their own feature ids", () => {
    const features = [
      buildMarkedFeature({ featureId: "building/1", osmId: 1, bearingDegrees: 10 }),
      buildMarkedFeature({ featureId: "building/2", osmId: 2, bearingDegrees: 30 }),
      buildMarkedFeature({ featureId: "building/3", osmId: 3, bearingDegrees: 50 }),
    ];

    const clustered = applyClusterMarkder(features);

    expect(clustered.map((feature) => feature.clusterMarker)).toEqual([
      "building/1",
      "building/2",
      "building/3",
    ]);
  });

  it("assigns the same cluster marker to nearby points and never leaks PLACE_HOLDER", () => {
    const features = [
      buildMarkedFeature({ featureId: "building/1", osmId: 1, bearingDegrees: 10 }),
      buildMarkedFeature({ featureId: "building/2", osmId: 2, bearingDegrees: 12 }),
      buildMarkedFeature({ featureId: "building/3", osmId: 3, bearingDegrees: 14 }),
    ];

    const clustered = applyClusterMarkder(features);
    const clusterMarkers = new Set(clustered.map((feature) => feature.clusterMarker));

    expect(clusterMarkers).toEqual(new Set(["L1:building:C0"]));
    expect(clustered.some((feature) => feature.clusterMarker === "PLACE_HOLDER")).toBe(false);
  });

  it("absorbs an earlier noise point into a later cluster expansion", () => {
    const features = [
      buildMarkedFeature({ featureId: "building/1", osmId: 1, bearingDegrees: 10.1 }),
      buildMarkedFeature({ featureId: "building/2", osmId: 2, bearingDegrees: 14.9 }),
      buildMarkedFeature({ featureId: "building/3", osmId: 3, bearingDegrees: 18.9 }),
      buildMarkedFeature({ featureId: "building/4", osmId: 4, bearingDegrees: 19.2 }),
    ];

    const clustered = applyClusterMarkder(features);
    const markerById = new Map(clustered.map((feature) => [feature.featureId, feature.clusterMarker]));

    expect(markerById.get("building/1")).toBe("L1:building:C0");
    expect(markerById.get("building/2")).toBe("L1:building:C0");
    expect(markerById.get("building/3")).toBe("L1:building:C0");
    expect(markerById.get("building/4")).toBe("L1:building:C0");
  });

  it("clusters points correctly across the 360/0 degree seam", () => {
    const features = [
      buildMarkedFeature({ featureId: "building/1", osmId: 1, bearingDegrees: 358 }),
      buildMarkedFeature({ featureId: "building/2", osmId: 2, bearingDegrees: 1 }),
      buildMarkedFeature({ featureId: "building/3", osmId: 3, bearingDegrees: 3 }),
    ];

    const clustered = applyClusterMarkder(features);

    expect(new Set(clustered.map((feature) => feature.clusterMarker))).toEqual(new Set(["L1:building:C0"]));
    expect(clustered.some((feature) => feature.clusterMarker === "PLACE_HOLDER")).toBe(false);
  });
});

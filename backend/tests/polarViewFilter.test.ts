/// <reference types="jest" />

jest.mock("@/db/client.js", () => ({
  query: jest.fn(),
}), { virtual: true });

jest.mock("@/db/sqlLoader.js", () => ({
  loadServiceSql: jest.fn(async () => ""),
}), { virtual: true });

jest.mock("@/routes/apiTypes.js", () => ({}), { virtual: true });

import type { FeatureDetail } from "../src/services/featureDetail";
import type { PolarView } from "../src/services/scene/polarViewLabeled";
import { applyVisualFilter } from "../src/services/scene/polarViewFilter";

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
  levelMarker?: 1 | 2 | 3;
  bearingDegrees?: number;
  distanceMeters?: number;
  clockwiseEarlyDegree?: number;
  angleWidthDegrees?: number;
  tags?: Record<string, string>;
}): PolarView["levels"][number]["clusters"][number]["features"][number] {
  const levelMarker = input.levelMarker || 1;
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
    clusterMarker: `${input.featureId}#cluster`,
    levelMarker,
    baseLabel: `${input.category}:${input.featureId}`,
  };
}

function buildCluster(
  clusterMarker: string,
  features: Array<PolarView["levels"][number]["clusters"][number]["features"][number]>,
): PolarView["levels"][number]["clusters"][number] {
  return {
    clusterMarker,
    memberCount: features.length,
    centerBearingDegrees: 20,
    features: features.map((feature) => ({ ...feature, clusterMarker })),
  };
}

function buildPolarView(
  clustersByLevel: Partial<Record<1 | 2 | 3, PolarView["levels"][number]["clusters"]>>,
): PolarView {
  return {
    center: { lat: 0, lon: 0 },
    maxRadiusMeters: 1000,
    levels: [
      { level: 1, distanceRangeMeters: [30, 100], clusters: clustersByLevel[1] || [] },
      { level: 2, distanceRangeMeters: [100, 300], clusters: clustersByLevel[2] || [] },
      { level: 3, distanceRangeMeters: [300, 1000], clusters: clustersByLevel[3] || [] },
    ],
  };
}

function getLevelClusters(result: PolarView, level: 1 | 2 | 3) {
  return result.levels.find((entry) => entry.level === level)?.clusters || [];
}

function getLevelFeatureIds(result: PolarView, level: 1 | 2 | 3) {
  return getLevelClusters(result, level).flatMap((cluster) => cluster.features.map((feature) => feature.featureId));
}

describe("applyVisualFilter", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("falls back to naked_eye when filter id is unknown", () => {
    const polarView = buildPolarView({
      1: [buildCluster("cluster/building/include", [
        buildFeature({ featureId: "building/include", osmId: 1, category: "building", angleWidthDegrees: 12 }),
      ])],
    });

    const filtered = applyVisualFilter("missing_filter", polarView);

    expect(getLevelClusters(filtered, 1)).toHaveLength(1);
    expect(getLevelClusters(filtered, 1)[0]?.features[0]?.featureId).toBe("building/include");
  });

  it("keeps significant buildings even when angle and cluster count are small", () => {
    const polarView = buildPolarView({
      1: [buildCluster("cluster/building/significant", [
        buildFeature({
          featureId: "building/significant",
          osmId: 2,
          category: "building",
          angleWidthDegrees: 1,
          tags: { height: "40" },
        }),
      ])],
    });

    const filtered = applyVisualFilter("naked_eye", polarView);

    expect(getLevelClusters(filtered, 1)).toHaveLength(1);
    expect(getLevelClusters(filtered, 1)[0]?.features[0]?.featureId).toBe("building/significant");
  });

  it("keeps significant POIs even when cluster count is small", () => {
    const polarView = buildPolarView({
      1: [buildCluster("cluster/poi/significant", [
        buildFeature({
          featureId: "poi/significant",
          osmId: 3,
          category: "poi",
          angleWidthDegrees: 0,
          tags: { man_made: "tower" },
        }),
      ])],
    });

    const filtered = applyVisualFilter("naked_eye", polarView);

    expect(getLevelClusters(filtered, 1)).toHaveLength(1);
    expect(getLevelClusters(filtered, 1)[0]?.features[0]?.featureId).toBe("poi/significant");
  });

  it("keeps a single feature when its angle width reaches includeDegreeThreshold", () => {
    const polarView = buildPolarView({
      1: [buildCluster("cluster/area/include", [
        buildFeature({ featureId: "area/include", osmId: 4, category: "area", angleWidthDegrees: 16 }),
      ])],
    });

    const filtered = applyVisualFilter("naked_eye", polarView);

    expect(getLevelClusters(filtered, 1)).toHaveLength(1);
    expect(getLevelClusters(filtered, 1)[0]?.features[0]?.featureId).toBe("area/include");
  });

  it("keeps a whole cluster when any member reaches includeDegreeThreshold", () => {
    const polarView = buildPolarView({
      1: [buildCluster("cluster/line/include", [
        buildFeature({ featureId: "line/a", osmId: 5, category: "line", angleWidthDegrees: 16 }),
        buildFeature({ featureId: "line/b", osmId: 6, category: "line", angleWidthDegrees: 1 }),
      ])],
    });

    const filtered = applyVisualFilter("naked_eye", polarView);

    expect(getLevelClusters(filtered, 1)).toHaveLength(1);
    expect(getLevelClusters(filtered, 1)[0]?.memberCount).toBe(2);
    expect(getLevelClusters(filtered, 1)[0]?.features.map((feature) => feature.featureId)).toEqual(["line/a", "line/b"]);
  });

  it("keeps a cluster when memberCount reaches includeCountThreshold", () => {
    const poiCluster = buildCluster(
      "cluster/poi/dense",
      Array.from({ length: 10 }, (_, index) =>
        buildFeature({ featureId: `poi/dense/${index + 1}`, osmId: 100 + index, category: "poi" }),
      ),
    );
    const polarView = buildPolarView({ 1: [poiCluster] });

    const filtered = applyVisualFilter("naked_eye", polarView);

    expect(getLevelClusters(filtered, 1)).toHaveLength(1);
    expect(getLevelClusters(filtered, 1)[0]?.memberCount).toBe(10);
  });

  it("drops a single feature when angle width is below excludeDegreeThreshold", () => {
    jest.spyOn(Math, "random").mockReturnValue(0.99);

    const polarView = buildPolarView({
      1: [buildCluster("cluster/building/exclude", [
        buildFeature({ featureId: "building/exclude", osmId: 7, category: "building", angleWidthDegrees: 3 }),
      ])],
    });

    const filtered = applyVisualFilter("naked_eye", polarView);

    expect(getLevelClusters(filtered, 1)).toHaveLength(0);
  });

  it("drops a cluster when memberCount is at or below excludeCountThreshold", () => {
    jest.spyOn(Math, "random").mockReturnValue(0.99);

    const polarView = buildPolarView({
      2: [buildCluster("cluster/building/exclude-count", Array.from({ length: 5 }, (_, index) =>
        buildFeature({
          featureId: `building/exclude-count/${index + 1}`,
          osmId: 200 + index,
          category: "building",
          levelMarker: 2,
          angleWidthDegrees: 1,
        }),
      ))],
    });

    const filtered = applyVisualFilter("naked_eye", polarView);

    expect(getLevelClusters(filtered, 2)).toHaveLength(0);
  });

  it("applies POI filtering by count only, without using angle width", () => {
    const poiCluster = buildCluster(
      "cluster/poi/count-only",
      Array.from({ length: 10 }, (_, index) =>
        buildFeature({
          featureId: `poi/count-only/${index + 1}`,
          osmId: 300 + index,
          category: "poi",
          angleWidthDegrees: 999,
        }),
      ),
    );

    const filtered = applyVisualFilter("naked_eye", buildPolarView({ 1: [poiCluster] }));

    expect(getLevelClusters(filtered, 1)).toHaveLength(1);
    expect(getLevelClusters(filtered, 1)[0]?.memberCount).toBe(10);
  });

  it("keeps a random single feature when Math.random clears the hide rate", () => {
    jest.spyOn(Math, "random").mockReturnValue(0.95);

    const polarView = buildPolarView({
      1: [buildCluster("cluster/building/random-keep", [
        buildFeature({ featureId: "building/random-keep", osmId: 8, category: "building", angleWidthDegrees: 6 }),
      ])],
    });

    const filtered = applyVisualFilter("naked_eye", polarView);

    expect(getLevelClusters(filtered, 1)).toHaveLength(1);
    expect(getLevelClusters(filtered, 1)[0]?.memberCount).toBe(1);
  });

  it("hides a random cluster when Math.random falls below the hide rate and preserves filtered memberCount", () => {
    const sourceCluster = buildCluster("cluster/building/random-hide", Array.from({ length: 6 }, (_, index) =>
      buildFeature({
        featureId: `building/random-hide/${index + 1}`,
        osmId: 400 + index,
        category: "building",
        levelMarker: 2,
        angleWidthDegrees: 11,
      }),
    ));

    jest.spyOn(Math, "random").mockReturnValue(0.1);
    const hidden = applyVisualFilter("naked_eye", buildPolarView({ 2: [sourceCluster] }));
    expect(getLevelClusters(hidden, 2)).toHaveLength(0);

    jest.spyOn(Math, "random").mockReturnValue(0.95);
    const kept = applyVisualFilter("naked_eye", buildPolarView({ 2: [sourceCluster] }));
    expect(getLevelClusters(kept, 2)).toHaveLength(1);
    expect(getLevelClusters(kept, 2)[0]?.memberCount).toBe(getLevelClusters(kept, 2)[0]?.features.length);
  });

  it("keeps significant buildings even when they are occluded", () => {
    const filtered = applyVisualFilter("naked_eye", buildPolarView({
      1: [buildCluster("cluster/l1/occluder", [
        buildFeature({
          featureId: "building/l1/occluder",
          osmId: 1200,
          category: "building",
          angleWidthDegrees: 30,
          clockwiseEarlyDegree: 10,
        }),
      ])],
      2: [buildCluster("cluster/l2/significant", [
        buildFeature({
          featureId: "building/l2/significant",
          osmId: 1201,
          category: "building",
          levelMarker: 2,
          bearingDegrees: 20,
          angleWidthDegrees: 1,
          tags: { height: "40" },
        }),
      ])],
    }));

    expect(getLevelFeatureIds(filtered, 2)).toEqual(["building/l2/significant"]);
  });

  it("keeps significant tower POIs even when they are occluded", () => {
    const filtered = applyVisualFilter("naked_eye", buildPolarView({
      1: [buildCluster("cluster/l1/occluder", [
        buildFeature({
          featureId: "building/l1/occluder",
          osmId: 1300,
          category: "building",
          angleWidthDegrees: 30,
          clockwiseEarlyDegree: 10,
        }),
      ])],
      2: [buildCluster("cluster/l2/significant-poi", [
        buildFeature({
          featureId: "poi/l2/significant",
          osmId: 1301,
          category: "poi",
          levelMarker: 2,
          bearingDegrees: 20,
          tags: { man_made: "tower" },
        }),
      ])],
    }));

    expect(getLevelFeatureIds(filtered, 2)).toEqual(["poi/l2/significant"]);
  });

});

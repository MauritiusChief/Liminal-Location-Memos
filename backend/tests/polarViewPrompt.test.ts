/// <reference types="jest" />

jest.mock("@/routes/apiTypes.js", () => ({}), { virtual: true });

import type { SceneFeatureDetail } from "../src/services/scene/sceneUtilFeatureDetail";
import type { PolarView, PolarViewCluster } from "../src/services/scene/polarViewLabeled";
import { buildPolarViewPrompt } from "../src/services/scene/polarViewPrompt";

type PolarFeatureCategory = "building" | "poi" | "line" | "area";
type MarkedPolarViewFeature = PolarViewCluster["features"][number];

function buildDetail(
  category: PolarFeatureCategory,
  tags: Record<string, string> = {},
): SceneFeatureDetail {
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
  category: PolarFeatureCategory;
  levelMarker?: 1 | 2 | 3;
  distanceMeters?: number;
  bearingDegrees?: number;
  angleWidthDegrees?: number;
  baseLabel?: string;
  tags?: Record<string, string>;
  linePoints?: Array<{ distanceMeters: number; bearingDegrees: number }>;
  orientationDegrees?: number;
}): MarkedPolarViewFeature {
  const distanceMeters = input.distanceMeters ?? 60;
  const bearingDegrees = input.bearingDegrees ?? 20;
  const angleWidthDegrees = input.angleWidthDegrees ?? 8;
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
    farthestPoint: { ...sample, distanceMeters: distanceMeters + 10 },
    widestSpan: {
      clockwiseEarlyPoint: sample,
      clockwiseLatePoint: { ...sample, bearingDegrees: bearingDegrees + angleWidthDegrees },
      angleWidthDegrees,
    },
    linePoints: input.linePoints?.map((point) => ({
      coordinate: [0.001, 0] as [number, number],
      distanceMeters: point.distanceMeters,
      bearingDegrees: point.bearingDegrees,
    })),
    orientationDegrees: input.orientationDegrees,
    clusterMarker: `${input.featureId}#cluster`,
    levelMarker: input.levelMarker ?? 1,
    baseLabel: input.baseLabel ?? `${input.category}:${input.featureId}`,
  };
}

function buildCluster(
  clusterMarker: string,
  centerBearingDegrees: number,
  features: MarkedPolarViewFeature[],
): PolarViewCluster {
  return {
    clusterMarker,
    memberCount: features.length,
    centerBearingDegrees,
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

describe("buildPolarViewPrompt", () => {
  it("renders single-feature blocks for building, poi, line and area", () => {
    const lineFeature = buildFeature({
      featureId: "line/1",
      osmId: 3,
      category: "line",
      levelMarker: 1,
      baseLabel: "Main St - highway:residential",
      tags: { name: "Main St", highway: "residential" },
      linePoints: [
        { distanceMeters: 61, bearingDegrees: 20 },
        { distanceMeters: 65, bearingDegrees: 25 },
        { distanceMeters: 70, bearingDegrees: 30 },
        { distanceMeters: 75, bearingDegrees: 35 },
      ],
      orientationDegrees: 90,
    });

    const polarView = buildPolarView({
      1: [
        buildCluster("cluster/building", 18, [
          buildFeature({
            featureId: "building/1",
            osmId: 1,
            category: "building",
            baseLabel: "North Building | building",
            tags: { name: "North Building", building: "yes" },
          }),
        ]),
        buildCluster("cluster/poi", 25, [
          buildFeature({
            featureId: "poi/1",
            osmId: 2,
            category: "poi",
            baseLabel: "Coffee Lab - amenity:cafe",
            tags: { name: "Coffee Lab", amenity: "cafe" },
          }),
        ]),
        buildCluster("cluster/line", 30, [lineFeature]),
        buildCluster("cluster/area", 35, [
          buildFeature({
            featureId: "area/1",
            osmId: 4,
            category: "area",
            baseLabel: "Central Park - leisure:park",
            tags: { name: "Central Park", leisure: "park" },
          }),
        ]),
      ],
    });

    const prompt = buildPolarViewPrompt(polarView);

    expect(prompt).toContain("## 极坐标摘要");
    expect(prompt).toContain("North Building | building:");
    expect(prompt).toContain("Coffee Lab - amenity:cafe:");
    expect(prompt).toContain("Main St - highway:residential:");
    expect(prompt).toContain("Central Park - leisure:park:");
    expect(prompt).toContain("最近点距离60m / 方位20°");
    expect(prompt).toContain("线顶点抽样：点1距离61m / 方位20°");
    expect(prompt).toContain("主走向90°");
    expect(prompt).toContain("起终点开角：边界点1距离60m / 方位20°");
    expect(prompt).toContain("name: Main St");
    expect(prompt).toContain("highway: residential");
  });

  it("renders cluster summary with representative features and omission counts", () => {
    const polarView = buildPolarView({
      2: [
        buildCluster(
          "cluster/buildings",
          48,
          [
            buildFeature({
              featureId: "building/a",
              osmId: 10,
              category: "building",
              levelMarker: 2,
              distanceMeters: 120,
              angleWidthDegrees: 2,
              baseLabel: "Tower Cluster | building",
              tags: { name: "Tower A", building: "apartments" },
            }),
            buildFeature({
              featureId: "building/b",
              osmId: 11,
              category: "building",
              levelMarker: 2,
              distanceMeters: 130,
              angleWidthDegrees: 4,
              baseLabel: "Tower Cluster | building",
              tags: { name: "Tower B", building: "apartments" },
            }),
            buildFeature({
              featureId: "building/c",
              osmId: 12,
              category: "building",
              levelMarker: 2,
              distanceMeters: 140,
              angleWidthDegrees: 6,
              baseLabel: "Tower Cluster | building",
              tags: { name: "Tower C", building: "apartments" },
            }),
            buildFeature({
              featureId: "building/d",
              osmId: 13,
              category: "building",
              levelMarker: 2,
              distanceMeters: 150,
              angleWidthDegrees: 8,
              baseLabel: "Tower Cluster | building",
              tags: { name: "Tower D", building: "apartments" },
            }),
          ],
        ),
      ],
    });

    const prompt = buildPolarViewPrompt(polarView);

    expect(prompt).toContain("## 等级1到等级2（30米到300米极坐标摘要）");
    expect(prompt).toContain("Tower Cluster | building:");
    expect(prompt).toContain("群中心方位48°，共4个要素，展示3个代表要素，其余1个仅保留数量");
    expect(prompt).toContain("(id=building/b)");
    expect(prompt).toContain("(id=building/c)");
    expect(prompt).toContain("(id=building/d)");
    expect(prompt).not.toContain("(id=building/a)");
  });

  it("falls back to the first feature when no cluster member reaches the level threshold", () => {
    const polarView = buildPolarView({
      3: [
        buildCluster("cluster/areas", 210, [
          buildFeature({
            featureId: "area/a",
            osmId: 20,
            category: "area",
            levelMarker: 3,
            distanceMeters: 320,
            angleWidthDegrees: 1,
            baseLabel: "远处绿地 - landuse:grass",
            tags: { name: "远处绿地", landuse: "grass" },
          }),
          buildFeature({
            featureId: "area/b",
            osmId: 21,
            category: "area",
            levelMarker: 3,
            distanceMeters: 340,
            angleWidthDegrees: 2,
            baseLabel: "远处绿地 - landuse:grass",
            tags: { name: "远处绿地B", landuse: "grass" },
          }),
        ]),
      ],
    });

    const prompt = buildPolarViewPrompt(polarView);

    expect(prompt).toContain("## 等级1到等级3（30米到1公里极坐标摘要）");
    expect(prompt).toContain("群中心方位210°，共2个要素，展示1个代表要素，其余1个仅保留数量");
    expect(prompt).toContain("(id=area/a)");
    expect(prompt).not.toContain("(id=area/b)");
  });

  it("renders information-insufficient blocks when a level/category has no content", () => {
    const prompt = buildPolarViewPrompt(buildPolarView({}));

    expect(prompt).toContain("## 极坐标摘要：无");
    expect(prompt).toContain("#### 等级1(100m~30m)：\n信息不足，未生成极坐标摘要");
    expect(prompt).toContain("#### 等级2(300m~100m)：\n信息不足，未生成极坐标摘要");
    expect(prompt).toContain("#### 等级3(1km~300m)：\n信息不足，未生成极坐标摘要");
  });
});

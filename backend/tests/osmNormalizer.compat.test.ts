/// <reference types="jest" />

import { convertOverpassToNormalizedFeatures as convertNew } from "../src/services/osmNormalization/osmNormalizer";
import { convertOverpassToNormalizedFeatures as convertLegacy } from "../src/services/overpassNormalization";

type AnyRecord = Record<string, unknown>;

type CanonicalRelationReference = {
  role: string;
  rel: number;
  reltags: Record<string, string>;
};

type CanonicalOutlineReference = {
  osmType: string;
  osmId: number;
  role: string;
  rel: number;
  reltags: Record<string, string>;
  tags: Record<string, string>;
};

type CanonicalFeature = {
  id: string;
  geometry: unknown;
  properties: {
    osmType: string;
    osmId: number;
    tags: Record<string, string>;
    relationReferences: CanonicalRelationReference[];
    outlineReferences: CanonicalOutlineReference[];
    meta: Record<string, string | number>;
    tainted: boolean;
    containedPoiReferences: unknown[];
  };
};

function sortObject<T extends Record<string, unknown>>(value: T): T {
  const sortedEntries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
  return Object.fromEntries(sortedEntries) as T;
}

function normalizeRelations(value: unknown): CanonicalRelationReference[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry): CanonicalRelationReference | null => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      const record = entry as AnyRecord;
      if (typeof record.role !== "string" || typeof record.rel !== "number") {
        return null;
      }
      const reltags = (record.reltags && typeof record.reltags === "object" && !Array.isArray(record.reltags))
        ? Object.fromEntries(
            Object.entries(record.reltags as AnyRecord)
              .filter(([, v]) => typeof v === "string")
              .map(([k, v]) => [k, v as string]),
          )
        : {};

      return {
        role: record.role,
        rel: record.rel,
        reltags: sortObject(reltags),
      };
    })
    .filter((entry): entry is CanonicalRelationReference => entry !== null)
    .sort((a, b) => {
      if (a.rel !== b.rel) return a.rel - b.rel;
      if (a.role !== b.role) return a.role.localeCompare(b.role);
      return JSON.stringify(a.reltags).localeCompare(JSON.stringify(b.reltags));
    });
}

function normalizeOutlineReferences(value: unknown): CanonicalOutlineReference[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry): CanonicalOutlineReference | null => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      const record = entry as AnyRecord;
      if (
        typeof record.osmType !== "string" ||
        typeof record.osmId !== "number" ||
        typeof record.role !== "string" ||
        typeof record.rel !== "number"
      ) {
        return null;
      }

      const reltags = (record.reltags && typeof record.reltags === "object" && !Array.isArray(record.reltags))
        ? Object.fromEntries(
            Object.entries(record.reltags as AnyRecord)
              .filter(([, v]) => typeof v === "string")
              .map(([k, v]) => [k, v as string]),
          )
        : {};
      const tags = (record.tags && typeof record.tags === "object" && !Array.isArray(record.tags))
        ? Object.fromEntries(
            Object.entries(record.tags as AnyRecord)
              .filter(([, v]) => typeof v === "string")
              .map(([k, v]) => [k, v as string]),
          )
        : {};

      return {
        osmType: record.osmType,
        osmId: record.osmId,
        role: record.role,
        rel: record.rel,
        reltags: sortObject(reltags),
        tags: sortObject(tags),
      };
    })
    .filter((entry): entry is CanonicalOutlineReference => entry !== null)
    .sort((a, b) => {
      if (a.rel !== b.rel) return a.rel - b.rel;
      if (a.osmType !== b.osmType) return a.osmType.localeCompare(b.osmType);
      if (a.osmId !== b.osmId) return a.osmId - b.osmId;
      return a.role.localeCompare(b.role);
    });
}

function normalizeMeta(value: unknown): Record<string, string | number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const entries = Object.entries(value as AnyRecord)
    .filter(([, v]) => typeof v === "string" || typeof v === "number")
    .sort(([a], [b]) => a.localeCompare(b));
  return Object.fromEntries(entries) as Record<string, string | number>;
}

function normalizeTags(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const entries = Object.entries(value as AnyRecord)
    .filter(([, v]) => typeof v === "string")
    .sort(([a], [b]) => a.localeCompare(b));
  return Object.fromEntries(entries) as Record<string, string>;
}

function canonicalizeFeature(feature: unknown): CanonicalFeature {
  const record = feature as AnyRecord;
  const properties = (record.properties ?? {}) as AnyRecord;
  const relationReferences = normalizeRelations(
    properties.relationReferences ?? properties.relations,
  );
  const containedPoiReferences = Array.isArray(properties.containedPoiReferences)
    ? properties.containedPoiReferences
    : Array.isArray(properties.containedPois)
      ? properties.containedPois
      : [];

  return {
    id: String(record.id),
    geometry: record.geometry,
    properties: {
      osmType: String(properties.osmType),
      osmId: Number(properties.osmId),
      tags: normalizeTags(properties.tags),
      relationReferences,
      outlineReferences: normalizeOutlineReferences(properties.outlineReferences),
      meta: normalizeMeta(properties.meta),
      tainted: Boolean(properties.tainted),
      containedPoiReferences,
    },
  };
}

function canonicalizeFeatures(features: unknown[]): CanonicalFeature[] {
  return features
    .map(canonicalizeFeature)
    .sort((a, b) => a.id.localeCompare(b.id));
}

function assertSemanticParity(raw: unknown): void {
  const normalizedNew = canonicalizeFeatures(convertNew(raw as never) as unknown[]);
  const normalizedLegacy = canonicalizeFeatures(convertLegacy(raw as never) as unknown[]);
  expect(normalizedNew).toEqual(normalizedLegacy);
}

function node(id: number, lat: number, lon: number): AnyRecord {
  return { type: "node", id, lat, lon };
}

function closedWayGeometry(nodeIds: number[], coords: Array<[number, number]>, tags: AnyRecord = {}): AnyRecord {
  return {
    type: "way",
    id: nodeIds[0] * 10,
    nodes: nodeIds,
    geometry: coords.map(([lat, lon]) => ({ lat, lon })),
    tags,
  };
}

describe("convertOverpassToNormalizedFeatures compatibility", () => {
  it("keeps basic standalone features consistently", () => {
    const raw = {
      elements: [
        node(1, 30.0, 120.0),
        node(2, 30.0, 120.001),
        {
          type: "way",
          id: 100,
          nodes: [1, 2],
          geometry: [{ lat: 30.0, lon: 120.0 }, { lat: 30.0, lon: 120.001 }],
          tags: { name: "Basic Road", highway: "residential", lanes: 2 },
          meta: { version: 3, user: "demo", flagged: true },
          tainted: true,
        },
      ],
    };

    assertSemanticParity(raw);
  });

  it("handles route relation/member line absorption consistently", () => {
    const raw = {
      elements: [
        node(10, 30.1, 120.1),
        node(11, 30.1, 120.11),
        {
          type: "way",
          id: 101,
          nodes: [10, 11],
          geometry: [{ lat: 30.1, lon: 120.1 }, { lat: 30.1, lon: 120.11 }],
          tags: { highway: "service", name: "Route Segment" },
        },
        {
          type: "relation",
          id: 1001,
          members: [{ type: "way", ref: 101, role: "" }],
          tags: { type: "route", route: "road", name: "Demo Route" },
        },
      ],
    };

    assertSemanticParity(raw);
  });

  it("handles multipolygon coverage consistently", () => {
    const raw = {
      elements: [
        node(20, 30.2, 120.2),
        node(21, 30.2, 120.21),
        node(22, 30.21, 120.21),
        node(23, 30.21, 120.2),
        {
          type: "way",
          id: 102,
          nodes: [20, 21, 22, 23, 20],
          geometry: [
            { lat: 30.2, lon: 120.2 },
            { lat: 30.2, lon: 120.21 },
            { lat: 30.21, lon: 120.21 },
            { lat: 30.21, lon: 120.2 },
            { lat: 30.2, lon: 120.2 },
          ],
          tags: { landuse: "grass", name: "Outer" },
        },
        {
          type: "relation",
          id: 1002,
          members: [{ type: "way", ref: 102, role: "outer" }],
          tags: { type: "multipolygon", landuse: "grass", name: "Area Relation" },
        },
      ],
    };

    assertSemanticParity(raw);
  });

  it("handles building relation outline/part consistently", () => {
    const raw = {
      elements: [
        node(30, 30.3, 120.3),
        node(31, 30.3, 120.31),
        node(32, 30.31, 120.31),
        node(33, 30.31, 120.3),
        node(34, 30.3005, 120.3005),
        node(35, 30.3005, 120.305),
        node(36, 30.305, 120.305),
        node(37, 30.305, 120.3005),
        {
          type: "way",
          id: 301,
          nodes: [30, 31, 32, 33, 30],
          geometry: [
            { lat: 30.3, lon: 120.3 },
            { lat: 30.3, lon: 120.31 },
            { lat: 30.31, lon: 120.31 },
            { lat: 30.31, lon: 120.3 },
            { lat: 30.3, lon: 120.3 },
          ],
          tags: { building: "yes", height: "20" },
        },
        {
          type: "way",
          id: 302,
          nodes: [34, 35, 36, 37, 34],
          geometry: [
            { lat: 30.3005, lon: 120.3005 },
            { lat: 30.3005, lon: 120.305 },
            { lat: 30.305, lon: 120.305 },
            { lat: 30.305, lon: 120.3005 },
            { lat: 30.3005, lon: 120.3005 },
          ],
          tags: { building: "part", "building:levels": "5" },
        },
        {
          type: "relation",
          id: 1003,
          members: [
            { type: "way", ref: 301, role: "outline" },
            { type: "way", ref: 302, role: "part" },
          ],
          tags: { type: "building", building: "commercial", name: "Complex A" },
        },
      ],
    };

    assertSemanticParity(raw);
  });

  it("cleans invalid or incomplete inputs consistently", () => {
    const raw = {
      elements: [
        {
          type: "way",
          id: 401,
          tags: { highway: "service", name: 1001 },
          meta: { version: 1, user: "x", broken: { nested: true } },
        },
        {
          type: "relation",
          id: 1401,
          members: [{ type: "way", ref: 401, role: 100 }],
          tags: { type: "route", route: "bus", note: 123 },
        },
      ],
    };

    assertSemanticParity(raw);
  });
});

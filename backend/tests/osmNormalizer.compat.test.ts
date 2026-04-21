/// <reference types="jest" />

import { convertOverpassToNormalizedFeatures as convertNew } from "../src/services/osmNormalization/osmNormalizer";

type AnyRecord = Record<string, unknown>;

type CanonicalRelationReference = {
  role: string;
  rel: number;
  reltags: Record<string, string>;
};

type CanonicalOutlineReference = {
  osmType: string;
  osmId: number;
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
        typeof record.osmId !== "number"
      ) {
        return null;
      }

      return {
        osmType: record.osmType,
        osmId: record.osmId,
      };
    })
    .filter((entry): entry is CanonicalOutlineReference => entry !== null)
    .sort((a, b) => {
      if (a.osmType !== b.osmType) return a.osmType.localeCompare(b.osmType);
      return a.osmId - b.osmId;
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

const EXPECTED_BY_CASE: Record<string, CanonicalFeature[]> = {
  "keeps basic standalone features consistently": [
    {
      "id": "way/100",
      "geometry": {
        "type": "LineString",
        "coordinates": [
          [
            120,
            30
          ],
          [
            120.001,
            30
          ]
        ]
      },
      "properties": {
        "osmType": "way",
        "osmId": 100,
        "tags": {
          "highway": "residential",
          "name": "Basic Road"
        },
        "relationReferences": [],
        "outlineReferences": [],
        "meta": {},
        "tainted": false,
        "containedPoiReferences": []
      }
    }
  ],
  "handles route relation/member line absorption consistently": [],
  "handles multipolygon coverage consistently": [
    {
      "id": "relation/1002",
      "geometry": {
        "type": "Polygon",
        "coordinates": [
          [
            [
              120.2,
              30.2
            ],
            [
              120.21,
              30.2
            ],
            [
              120.21,
              30.21
            ],
            [
              120.2,
              30.21
            ],
            [
              120.2,
              30.2
            ]
          ]
        ]
      },
      "properties": {
        "osmType": "relation",
        "osmId": 1002,
        "tags": {
          "landuse": "grass",
          "name": "Area Relation",
          "type": "multipolygon"
        },
        "relationReferences": [],
        "outlineReferences": [],
        "meta": {},
        "tainted": false,
        "containedPoiReferences": []
      }
    }
  ],
  "handles building relation outline/part consistently": [
    {
      "id": "way/301",
      "geometry": {
        "type": "Polygon",
        "coordinates": [
          [
            [
              120.3,
              30.3
            ],
            [
              120.31,
              30.3
            ],
            [
              120.31,
              30.31
            ],
            [
              120.3,
              30.31
            ],
            [
              120.3,
              30.3
            ]
          ]
        ]
      },
      "properties": {
        "osmType": "way",
        "osmId": 301,
        "tags": {
          "building": "yes",
          "height": "20"
        },
        "relationReferences": [
          {
            "role": "outline",
            "rel": 1003,
            "reltags": {
              "building": "commercial",
              "name": "Complex A",
              "type": "building"
            }
          }
        ],
        "outlineReferences": [],
        "meta": {},
        "tainted": false,
        "containedPoiReferences": []
      }
    },
    {
      "id": "way/302",
      "geometry": {
        "type": "Polygon",
        "coordinates": [
          [
            [
              120.3005,
              30.3005
            ],
            [
              120.305,
              30.3005
            ],
            [
              120.305,
              30.305
            ],
            [
              120.3005,
              30.305
            ],
            [
              120.3005,
              30.3005
            ]
          ]
        ]
      },
      "properties": {
        "osmType": "way",
        "osmId": 302,
        "tags": {
          "building": "part",
          "building:levels": "5",
          "height": "20",
          "name": "Complex A",
          "type": "building"
        },
        "relationReferences": [
          {
            "role": "part",
            "rel": 1003,
            "reltags": {
              "building": "commercial",
              "name": "Complex A",
              "type": "building"
            }
          }
        ],
        "outlineReferences": [
          {
            "osmType": "way",
            "osmId": 301
          }
        ],
        "meta": {},
        "tainted": false,
        "containedPoiReferences": []
      }
    }
  ],
  "cleans invalid or incomplete inputs consistently": [],
  "handles body+skel duplicated way tag merge order consistently": [
    {
      "id": "way/5001",
      "geometry": {
        "type": "LineString",
        "coordinates": [
          [
            121,
            31
          ],
          [
            121.01,
            31
          ]
        ]
      },
      "properties": {
        "osmType": "way",
        "osmId": 5001,
        "tags": {
          "highway": "residential",
          "name": "Body Way",
          "surface": "asphalt"
        },
        "relationReferences": [],
        "outlineReferences": [],
        "meta": {},
        "tainted": false,
        "containedPoiReferences": []
      }
    }
  ],
  "keeps building relation refs when same feature also belongs to route relation": [
    {
      "id": "way/5101",
      "geometry": {
        "type": "Polygon",
        "coordinates": [
          [
            [
              121.1,
              31.1
            ],
            [
              121.11,
              31.1
            ],
            [
              121.11,
              31.11
            ],
            [
              121.1,
              31.11
            ],
            [
              121.1,
              31.1
            ]
          ]
        ]
      },
      "properties": {
        "osmType": "way",
        "osmId": 5101,
        "tags": {
          "building": "yes",
          "height": "18"
        },
        "relationReferences": [
          {
            "role": "outline",
            "rel": 9101,
            "reltags": {
              "building": "office",
              "name": "Mixed Membership Building",
              "type": "building"
            }
          }
        ],
        "outlineReferences": [],
        "meta": {},
        "tainted": false,
        "containedPoiReferences": []
      }
    },
    {
      "id": "way/5102",
      "geometry": {
        "type": "Polygon",
        "coordinates": [
          [
            [
              121.1002,
              31.1002
            ],
            [
              121.105,
              31.1002
            ],
            [
              121.105,
              31.105
            ],
            [
              121.1002,
              31.105
            ],
            [
              121.1002,
              31.1002
            ]
          ]
        ]
      },
      "properties": {
        "osmType": "way",
        "osmId": 5102,
        "tags": {
          "building": "part",
          "building:levels": "4",
          "height": "18",
          "name": "Mixed Membership Building",
          "type": "building"
        },
        "relationReferences": [
          {
            "role": "part",
            "rel": 9101,
            "reltags": {
              "building": "office",
              "name": "Mixed Membership Building",
              "type": "building"
            }
          }
        ],
        "outlineReferences": [
          {
            "osmType": "way",
            "osmId": 5101
          }
        ],
        "meta": {},
        "tainted": false,
        "containedPoiReferences": []
      }
    }
  ],
  "filters boundary outer/inner outline lines consistently": [
    {
      "id": "relation/9201",
      "geometry": {
        "type": "Polygon",
        "coordinates": [
          [
            [
              121.2,
              31.2
            ],
            [
              121.22,
              31.2
            ],
            [
              121.22,
              31.22
            ],
            [
              121.2,
              31.22
            ],
            [
              121.2,
              31.2
            ]
          ]
        ]
      },
      "properties": {
        "osmType": "relation",
        "osmId": 9201,
        "tags": {
          "boundary": "administrative",
          "name": "Boundary Area",
          "type": "boundary"
        },
        "relationReferences": [],
        "outlineReferences": [],
        "meta": {},
        "tainted": false,
        "containedPoiReferences": []
      }
    }
  ],
  "dedupes duplicated building outline references consistently": [
    {
      "id": "way/5301",
      "geometry": {
        "type": "Polygon",
        "coordinates": [
          [
            [
              121.3,
              31.3
            ],
            [
              121.31,
              31.3
            ],
            [
              121.31,
              31.31
            ],
            [
              121.3,
              31.31
            ],
            [
              121.3,
              31.3
            ]
          ]
        ]
      },
      "properties": {
        "osmType": "way",
        "osmId": 5301,
        "tags": {
          "building": "yes",
          "name": "Outline A"
        },
        "relationReferences": [
          {
            "role": "outline",
            "rel": 9301,
            "reltags": {
              "building": "yes",
              "name": "Duplicate Outline Building",
              "type": "building"
            }
          }
        ],
        "outlineReferences": [],
        "meta": {},
        "tainted": false,
        "containedPoiReferences": []
      }
    },
    {
      "id": "way/5302",
      "geometry": {
        "type": "Polygon",
        "coordinates": [
          [
            [
              121.3002,
              31.3002
            ],
            [
              121.305,
              31.3002
            ],
            [
              121.305,
              31.305
            ],
            [
              121.3002,
              31.305
            ],
            [
              121.3002,
              31.3002
            ]
          ]
        ]
      },
      "properties": {
        "osmType": "way",
        "osmId": 5302,
        "tags": {
          "building": "part",
          "name": "Duplicate Outline Building",
          "type": "building"
        },
        "relationReferences": [
          {
            "role": "part",
            "rel": 9301,
            "reltags": {
              "building": "yes",
              "name": "Duplicate Outline Building",
              "type": "building"
            }
          }
        ],
        "outlineReferences": [
          {
            "osmType": "way",
            "osmId": 5301
          }
        ],
        "meta": {},
        "tainted": false,
        "containedPoiReferences": []
      }
    }
  ],
  "cleans invalid relation members consistently": [],
  "handles malformed element with missing numeric id while geometry exists": [
    {
      "id": "way/5501",
      "geometry": {
        "type": "LineString",
        "coordinates": [
          [
            121.5,
            31.5
          ],
          [
            121.51,
            31.5
          ]
        ]
      },
      "properties": {
        "osmType": "way",
        "osmId": 5501,
        "tags": {
          "highway": "residential",
          "name": "Malformed Id Way"
        },
        "relationReferences": [],
        "outlineReferences": [],
        "meta": {},
        "tainted": false,
        "containedPoiReferences": []
      }
    }
  ],
  "filters non-string values from tags and reltags consistently": [],
  "keeps member line when osmtogeojson skips non-abstract line relations": [
    {
      "id": "way/5701",
      "geometry": {
        "type": "LineString",
        "coordinates": [
          [
            121.7,
            31.7
          ],
          [
            121.71,
            31.7
          ]
        ]
      },
      "properties": {
        "osmType": "way",
        "osmId": 5701,
        "tags": {
          "name": "Hybrid Membership Line",
          "waterway": "canal"
        },
        "relationReferences": [
          {
            "role": "",
            "rel": 9701,
            "reltags": {
              "name": "Waterway Relation",
              "type": "waterway",
              "waterway": "canal"
            }
          },
          {
            "role": "",
            "rel": 9702,
            "reltags": {
              "name": "Non Line Relation",
              "network": "local",
              "type": "network"
            }
          }
        ],
        "outlineReferences": [],
        "meta": {},
        "tainted": false,
        "containedPoiReferences": []
      }
    }
  ],
  "merges ring building outer inner tags into relation carrier": [
    {
      "id": "relation/9801",
      "geometry": {
        "type": "Polygon",
        "coordinates": [
          [
            [
              121.8,
              31.8
            ],
            [
              121.82,
              31.8
            ],
            [
              121.82,
              31.82
            ],
            [
              121.8,
              31.82
            ],
            [
              121.8,
              31.8
            ]
          ],
          [
            [
              121.805,
              31.805
            ],
            [
              121.805,
              31.815
            ],
            [
              121.815,
              31.815
            ],
            [
              121.815,
              31.805
            ],
            [
              121.805,
              31.805
            ]
          ]
        ]
      },
      "properties": {
        "osmType": "relation",
        "osmId": 9801,
        "tags": {
          "building": "stadium",
          "building:levels": "2",
          "height": "22",
          "name": "Ring Stadium",
          "type": "multipolygon"
        },
        "relationReferences": [],
        "outlineReferences": [],
        "meta": {},
        "tainted": false,
        "containedPoiReferences": []
      }
    }
  ]
};

function assertCanonicalResult(caseName: string, raw: unknown): void {
  const expected = EXPECTED_BY_CASE[caseName];
  if (!expected) {
    throw new Error(`Missing expected baseline for case: ${caseName}`);
  }
  const normalized = canonicalizeFeatures(convertNew(raw as never) as unknown[]);
  expect(normalized).toEqual(expected);
}

function node(id: number, lat: number, lon: number): AnyRecord {
  return { type: "node", id, lat, lon };
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

    assertCanonicalResult("keeps basic standalone features consistently", raw);
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

    assertCanonicalResult("handles route relation/member line absorption consistently", raw);
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

    assertCanonicalResult("handles multipolygon coverage consistently", raw);
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

    assertCanonicalResult("handles building relation outline/part consistently", raw);
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

    assertCanonicalResult("cleans invalid or incomplete inputs consistently", raw);
  });
});

describe("edge cases likely to diverge", () => {
  it("handles body+skel duplicated way tag merge order consistently", () => {
    const raw = {
      elements: [
        node(1001, 31.0, 121.0),
        node(1002, 31.0, 121.01),
        {
          type: "way",
          id: 5001,
          nodes: [1001, 1002],
          geometry: [{ lat: 31.0, lon: 121.0 }, { lat: 31.0, lon: 121.01 }],
          tags: { highway: "residential", name: "Body Way", surface: "asphalt" },
        },
        {
          type: "way",
          id: 5001,
          nodes: [1001, 1002],
          geometry: [{ lat: 31.0, lon: 121.0 }, { lat: 31.0, lon: 121.01 }],
          tags: { highway: "residential" },
        },
      ],
    };

    assertCanonicalResult("handles body+skel duplicated way tag merge order consistently", raw);
  });

  it("keeps building relation refs when same feature also belongs to route relation", () => {
    const raw = {
      elements: [
        node(1101, 31.1, 121.1),
        node(1102, 31.1, 121.11),
        node(1103, 31.11, 121.11),
        node(1104, 31.11, 121.1),
        node(1105, 31.1002, 121.1002),
        node(1106, 31.1002, 121.105),
        node(1107, 31.105, 121.105),
        node(1108, 31.105, 121.1002),
        {
          type: "way",
          id: 5101,
          nodes: [1101, 1102, 1103, 1104, 1101],
          geometry: [
            { lat: 31.1, lon: 121.1 },
            { lat: 31.1, lon: 121.11 },
            { lat: 31.11, lon: 121.11 },
            { lat: 31.11, lon: 121.1 },
            { lat: 31.1, lon: 121.1 },
          ],
          tags: { building: "yes", height: "18" },
        },
        {
          type: "way",
          id: 5102,
          nodes: [1105, 1106, 1107, 1108, 1105],
          geometry: [
            { lat: 31.1002, lon: 121.1002 },
            { lat: 31.1002, lon: 121.105 },
            { lat: 31.105, lon: 121.105 },
            { lat: 31.105, lon: 121.1002 },
            { lat: 31.1002, lon: 121.1002 },
          ],
          tags: { building: "part", "building:levels": "4" },
        },
        {
          type: "relation",
          id: 9101,
          members: [
            { type: "way", ref: 5101, role: "outline" },
            { type: "way", ref: 5102, role: "part" },
          ],
          tags: { type: "building", building: "office", name: "Mixed Membership Building" },
        },
        {
          type: "relation",
          id: 9102,
          members: [{ type: "way", ref: 5102, role: "" }],
          tags: { type: "route", route: "road", name: "Overlay Route" },
        },
      ],
    };

    assertCanonicalResult("keeps building relation refs when same feature also belongs to route relation", raw);
  });

  it("filters boundary outer/inner outline lines consistently", () => {
    const raw = {
      elements: [
        node(1201, 31.2, 121.2),
        node(1202, 31.2, 121.22),
        node(1203, 31.22, 121.22),
        node(1204, 31.22, 121.2),
        {
          type: "way",
          id: 5201,
          nodes: [1201, 1202, 1203, 1204, 1201],
          geometry: [
            { lat: 31.2, lon: 121.2 },
            { lat: 31.2, lon: 121.22 },
            { lat: 31.22, lon: 121.22 },
            { lat: 31.22, lon: 121.2 },
            { lat: 31.2, lon: 121.2 },
          ],
          tags: { boundary: "administrative" },
        },
        {
          type: "relation",
          id: 9201,
          members: [{ type: "way", ref: 5201, role: "outer" }],
          tags: { type: "boundary", boundary: "administrative", name: "Boundary Area" },
        },
      ],
    };

    assertCanonicalResult("filters boundary outer/inner outline lines consistently", raw);
  });

  it("dedupes duplicated building outline references consistently", () => {
    const raw = {
      elements: [
        node(1301, 31.3, 121.3),
        node(1302, 31.3, 121.31),
        node(1303, 31.31, 121.31),
        node(1304, 31.31, 121.3),
        node(1305, 31.3002, 121.3002),
        node(1306, 31.3002, 121.305),
        node(1307, 31.305, 121.305),
        node(1308, 31.305, 121.3002),
        {
          type: "way",
          id: 5301,
          nodes: [1301, 1302, 1303, 1304, 1301],
          geometry: [
            { lat: 31.3, lon: 121.3 },
            { lat: 31.3, lon: 121.31 },
            { lat: 31.31, lon: 121.31 },
            { lat: 31.31, lon: 121.3 },
            { lat: 31.3, lon: 121.3 },
          ],
          tags: { building: "yes", name: "Outline A" },
        },
        {
          type: "way",
          id: 5302,
          nodes: [1305, 1306, 1307, 1308, 1305],
          geometry: [
            { lat: 31.3002, lon: 121.3002 },
            { lat: 31.3002, lon: 121.305 },
            { lat: 31.305, lon: 121.305 },
            { lat: 31.305, lon: 121.3002 },
            { lat: 31.3002, lon: 121.3002 },
          ],
          tags: { building: "part" },
        },
        {
          type: "relation",
          id: 9301,
          members: [
            { type: "way", ref: 5301, role: "outline" },
            { type: "way", ref: 5301, role: "outline" },
            { type: "way", ref: 5302, role: "part" },
          ],
          tags: { type: "building", building: "yes", name: "Duplicate Outline Building" },
        },
      ],
    };

    assertCanonicalResult("dedupes duplicated building outline references consistently", raw);
  });

  it("cleans invalid relation members consistently", () => {
    const raw = {
      elements: [
        node(1401, 31.4, 121.4),
        node(1402, 31.4, 121.41),
        {
          type: "way",
          id: 5401,
          nodes: [1401, 1402],
          geometry: [{ lat: 31.4, lon: 121.4 }, { lat: 31.4, lon: 121.41 }],
          tags: { highway: "service", name: "Dirty Member Road" },
        },
        {
          type: "relation",
          id: 9401,
          members: [
            { type: "way", ref: 5401, role: "" },
            { type: "way", ref: "5401", role: "" },
            { type: "way", ref: 5401, role: 1 },
            { type: 1, ref: 5401, role: "" },
          ],
          tags: { type: "route", route: "road", name: "Dirty Route Members" },
        },
      ],
    };

    assertCanonicalResult("cleans invalid relation members consistently", raw);
  });

  it("handles malformed element with missing numeric id while geometry exists", () => {
    const raw = {
      elements: [
        node(1501, 31.5, 121.5),
        node(1502, 31.5, 121.51),
        {
          type: "way",
          id: "5501",
          nodes: [1501, 1502],
          geometry: [{ lat: 31.5, lon: 121.5 }, { lat: 31.5, lon: 121.51 }],
          tags: { highway: "residential", name: "Malformed Id Way" },
        },
      ],
    };

    assertCanonicalResult("handles malformed element with missing numeric id while geometry exists", raw);
  });

  it("filters non-string values from tags and reltags consistently", () => {
    const raw = {
      elements: [
        node(1601, 31.6, 121.6),
        node(1602, 31.6, 121.61),
        {
          type: "way",
          id: 5601,
          nodes: [1601, 1602],
          geometry: [{ lat: 31.6, lon: 121.6 }, { lat: 31.6, lon: 121.61 }],
          tags: { highway: "service", lanes: 2, covered: true, name: "Mixed Value Way" },
        },
        {
          type: "relation",
          id: 9601,
          members: [{ type: "way", ref: 5601, role: "" }],
          tags: { type: "route", route: "road", priority: 1, active: false },
        },
      ],
    };

    assertCanonicalResult("filters non-string values from tags and reltags consistently", raw);
  });

  it("keeps member line when osmtogeojson skips non-abstract line relations", () => {
    const raw = {
      elements: [
        node(1701, 31.7, 121.7),
        node(1702, 31.7, 121.71),
        {
          type: "way",
          id: 5701,
          nodes: [1701, 1702],
          geometry: [{ lat: 31.7, lon: 121.7 }, { lat: 31.7, lon: 121.71 }],
          tags: { waterway: "canal", name: "Hybrid Membership Line" },
        },
        {
          type: "relation",
          id: 9701,
          members: [{ type: "way", ref: 5701, role: "" }],
          tags: { type: "waterway", waterway: "canal", name: "Waterway Relation" },
        },
        {
          type: "relation",
          id: 9702,
          members: [{ type: "way", ref: 5701, role: "" }],
          tags: { type: "network", network: "local", name: "Non Line Relation" },
        },
      ],
    };

    assertCanonicalResult("keeps member line when osmtogeojson skips non-abstract line relations", raw);
  });

  it("merges ring building outer inner tags into relation carrier", () => {
    const raw = {
      elements: [
        node(1801, 31.8, 121.8),
        node(1802, 31.8, 121.82),
        node(1803, 31.82, 121.82),
        node(1804, 31.82, 121.8),
        node(1805, 31.805, 121.805),
        node(1806, 31.805, 121.815),
        node(1807, 31.815, 121.815),
        node(1808, 31.815, 121.805),
        {
          type: "way",
          id: 5801,
          nodes: [1801, 1802, 1803, 1804, 1801],
          geometry: [
            { lat: 31.8, lon: 121.8 },
            { lat: 31.8, lon: 121.82 },
            { lat: 31.82, lon: 121.82 },
            { lat: 31.82, lon: 121.8 },
            { lat: 31.8, lon: 121.8 },
          ],
          tags: { building: "yes", height: "22" },
        },
        {
          type: "way",
          id: 5802,
          nodes: [1805, 1806, 1807, 1808, 1805],
          geometry: [
            { lat: 31.805, lon: 121.805 },
            { lat: 31.805, lon: 121.815 },
            { lat: 31.815, lon: 121.815 },
            { lat: 31.815, lon: 121.805 },
            { lat: 31.805, lon: 121.805 },
          ],
          tags: { "building:levels": "2" },
        },
        {
          type: "relation",
          id: 9801,
          members: [
            { type: "way", ref: 5801, role: "outer" },
            { type: "way", ref: 5802, role: "inner" },
          ],
          tags: { type: "multipolygon", building: "stadium", name: "Ring Stadium" },
        },
      ],
    };

    assertCanonicalResult("merges ring building outer inner tags into relation carrier", raw);
  });
});

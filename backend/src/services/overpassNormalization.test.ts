import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildNormalizedOverpassQuery, normalizeOverpassData, type OverpassJsonResponse } from './overpassNormalization.js';

function loadSample(name: string): OverpassJsonResponse {
  const filePath = fileURLToPath(new URL(`../../../_designer_note/${name}`, import.meta.url));
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as OverpassJsonResponse;
}

test('buildNormalizedOverpassQuery keeps relation expansion and geometry output', () => {
  const query = buildNormalizedOverpassQuery({
    lat: 34.02466920711174,
    lon: -84.09143822250903,
    radius: 30,
    featureCategories: ['building', 'landuse'],
  });

  assert.match(query, /way\(around:30,34\.02466920711174,-84\.09143822250903\)\[building\];/);
  assert.match(query, /relation\(around:30,34\.02466920711174,-84\.09143822250903\)\[type=multipolygon\]\[landuse\];/);
  assert.match(query, /out body geom;/);
  assert.match(query, />;\nout skel geom;/);
});

test('normalizeOverpassData keeps polygon building features from sample 2', () => {
  const sample = loadSample('example_overpass_respond2.json');
  const result = normalizeOverpassData(sample, { requestedCategories: ['building'] });

  assert.equal(result.geojson.type, 'FeatureCollection');
  assert.ok(result.geojson.features.length > 0);
  assert.ok(result.geojson.features.every((feature) => feature.geometry.type === 'Polygon' || feature.geometry.type === 'MultiPolygon'));
  assert.ok(result.geojson.features.some((feature) => feature.properties.tags.building === 'yes'));
});

test('normalizeOverpassData tolerates incomplete relation inputs from sample 1', () => {
  const sample = loadSample('example_overpass_respond1.json');
  const result = normalizeOverpassData(sample, { requestedCategories: ['landuse', 'natural'] });

  assert.equal(result.diagnostics.rawElementCounts.relation, 1);
  assert.ok(result.diagnostics.totalNormalizedFeatures > 0);
  assert.ok(result.diagnostics.taintedFeatures > 0 || result.diagnostics.filteredNonPolygonFeatures > 0);
});

import { Router } from 'express';
import { overpassJson } from 'overpass-ts';
import { checkDatabaseHealth } from '../db/client.js';
import { generateReply, generateReplyWithSystemPrompt } from '../services/llm.js';
import { buildNormalizedMicroGrid } from '../services/overpassGrid.js';
import { fetchFeaturesFromDb, syncNormalizedFeaturesToDb } from '../services/osmRepository.js';
import { buildNormalizedPolarView } from '../services/overpassPolar.js';
import { buildDefaultDebugSystemPrompt, buildNormalizationPrompt } from '../services/overpassPrompt.js';
import {
  buildNormalizedOverpassQuery,
  convertOverpassToNormalizedFeatures,
  type NormalizedOverpassRequest,
  type NormalizedFeatureCollection,
} from '../services/overpassNormalization.js';
import type { NormalizedOverpassRequestBody } from '../types/overpass.js';

interface ChatRequestBody {
  message?: string;
}

interface DebugLlmRequestBody {
  systemPrompt?: string;
  message?: string;
}

interface OverpassRequestBody {
  query?: string;
}

export const apiRouter = Router();

function buildFeatureSummary(geojson: NormalizedFeatureCollection) {
  return geojson.features.map((feature) => ({
    id: feature.id,
    type: feature.geometry.type,
    properties: feature.properties,
  }));
}

function buildDbDiagnostics(geojson: NormalizedFeatureCollection) {
  return {
    totalNormalizedFeatures: geojson.features.length,
    featureCountsByGeometryType: geojson.features.reduce<Record<string, number>>((counts, feature) => {
      counts[feature.geometry.type] = (counts[feature.geometry.type] || 0) + 1;
      return counts;
    }, {}),
    taintedFeatures: geojson.features.filter((feature) => feature.properties.tainted).length,
  };
}

function buildNormalizationDebugPayload(
  geojson: NormalizedFeatureCollection,
  normalizedRequest: NormalizedOverpassRequest,
) {
  const diagnostics = buildDbDiagnostics(geojson);
  const microGrid = buildNormalizedMicroGrid(geojson.features, normalizedRequest);
  const polarView = buildNormalizedPolarView(geojson.features, normalizedRequest);
  const promptPreview = {
    userPrompt: buildNormalizationPrompt({
      request: normalizedRequest,
      geojson,
      microGrid,
      polarView,
    }),
  };

  return {
    featureSummary: buildFeatureSummary(geojson),
    geojson,
    diagnostics,
    microGrid,
    polarView,
    promptPreview,
  };
}

function parseNormalizedRequest(body: NormalizedOverpassRequestBody) {
  const { lat, lon, radius } = body;

  if (
    typeof lat !== 'number' ||
    !Number.isFinite(lat) ||
    typeof lon !== 'number' ||
    !Number.isFinite(lon) ||
    typeof radius !== 'number' ||
    !Number.isFinite(radius)
  ) {
    return { error: 'lat, lon, and radius must be finite numbers.' } as const;
  }

  if (radius <= 0) {
    return { error: 'radius must be greater than 0.' } as const;
  }

  return {
    value: {
      lat,
      lon,
      radius,
    },
  } as const;
}

apiRouter.get('/health', async (_request, response) => {
  const database = await checkDatabaseHealth();
  response.json({
    ok: database.enabled ? database.ok : true,
    service: 'backend',
    database,
  });
});

apiRouter.post('/chat', async (request, response) => {
  const { message } = request.body as ChatRequestBody;

  if (!message || !message.trim()) {
    response.status(400).json({ error: 'Message is required.' });
    return;
  }

  try {
    const result = await generateReply(message.trim());
    response.json({ reply: result.reply });
  } catch (error) {
    response.status(502).json({
      error: error instanceof Error ? error.message : 'Unexpected upstream error.',
    });
  }
});

apiRouter.post('/debug/llm', async (request, response) => {
  const { systemPrompt, message } = request.body as DebugLlmRequestBody;

  if (!message || !message.trim()) {
    response.status(400).json({ error: 'Message is required.' });
    return;
  }

  try {
    const result = await generateReplyWithSystemPrompt(
      typeof systemPrompt === 'string' ? systemPrompt : buildDefaultDebugSystemPrompt(),
      message.trim(),
    );
    response.json(result);
  } catch (error) {
    response.status(502).json({
      error: error instanceof Error ? error.message : 'Unexpected upstream error.',
    });
  }
});

apiRouter.post('/overpass', async (request, response) => {
  const { query } = request.body as OverpassRequestBody;

  if (!query || !query.trim()) {
    response.status(400).json({ error: 'Query is required.' });
    return;
  }

  try {
    const data = await overpassJson(query.trim(), {
      endpoint: 'https://overpass-api.de/api/interpreter',
    });

    response.json({ data });
  } catch (error) {
    response.status(502).json({
      error: error instanceof Error ? error.message : 'Unexpected Overpass error.',
    });
  }
});

apiRouter.post('/db/sync-overpass', async (request, response) => {
  const parsed = parseNormalizedRequest(request.body as NormalizedOverpassRequestBody);

  if ('error' in parsed) {
    response.status(400).json({ error: parsed.error });
    return;
  }

  const normalizedRequest = parsed.value;
  const query = buildNormalizedOverpassQuery(normalizedRequest);

  try {
    const raw = (await overpassJson(query, {
      endpoint: 'https://overpass-api.de/api/interpreter',
    })) as Parameters<typeof convertOverpassToNormalizedFeatures>[0];
    const features = convertOverpassToNormalizedFeatures(raw);
    const counts = await syncNormalizedFeaturesToDb(features, normalizedRequest);

    response.json({
      query,
      featureCount: features.length,
      counts,
      coverageRecorded: true,
    });
  } catch (error) {
    response.status(502).json({
      error: error instanceof Error ? error.message : 'Unexpected database sync error.',
    });
  }
});

apiRouter.post('/db/normalized-load', async (request, response) => {
  const parsed = parseNormalizedRequest(request.body as NormalizedOverpassRequestBody);

  if ('error' in parsed) {
    response.status(400).json({ error: parsed.error });
    return;
  }

  const normalizedRequest = parsed.value;

  try {
    const features = await fetchFeaturesFromDb(normalizedRequest);
    const geojson: NormalizedFeatureCollection = {
      type: 'FeatureCollection',
      features,
    };
    const debugPayload = buildNormalizationDebugPayload(geojson, normalizedRequest);

    response.json({
      query: '[db source]',
      ...debugPayload,
      raw: undefined,
    });
  } catch (error) {
    response.status(502).json({
      error: error instanceof Error ? error.message : 'Unexpected database normalized load error.',
    });
  }
});

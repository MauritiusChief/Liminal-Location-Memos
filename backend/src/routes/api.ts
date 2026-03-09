import { Router } from 'express';
import { overpassJson } from 'overpass-ts';
import { generateReply } from '../services/llm.js';
import { buildNormalizedMicroGrid } from '../services/overpassGrid.js';
import { buildNormalizedOverpassQuery, normalizeOverpassData } from '../services/overpassNormalization.js';
import type { NormalizedOverpassRequestBody } from '../types/overpass.js';

interface ChatRequestBody {
  message?: string;
}

interface OverpassRequestBody {
  query?: string;
}

export const apiRouter = Router();

function parseNormalizedRequest(body: NormalizedOverpassRequestBody) {
  const { lat, lon, radius, includeRaw } = body;

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
      includeRaw: Boolean(includeRaw),
    },
  } as const;
}

apiRouter.get('/health', (_request, response) => {
  response.json({ ok: true, service: 'backend' });
});

apiRouter.post('/chat', async (request, response) => {
  const { message } = request.body as ChatRequestBody;

  if (!message || !message.trim()) {
    response.status(400).json({ error: 'Message is required.' });
    return;
  }

  try {
    const reply = await generateReply(message.trim());
    response.json({ reply });
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

apiRouter.post('/overpass/normalize', async (request, response) => {
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
    })) as Parameters<typeof normalizeOverpassData>[0];

    const { geojson, diagnostics } = normalizeOverpassData(raw);
    const microGrid = buildNormalizedMicroGrid(geojson.features, normalizedRequest);

    response.json({
      query,
      geojson,
      diagnostics,
      microGrid,
      raw: normalizedRequest.includeRaw ? raw : undefined,
    });
  } catch (error) {
    response.status(502).json({
      error: error instanceof Error ? error.message : 'Unexpected Overpass normalization error.',
    });
  }
});

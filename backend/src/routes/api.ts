import { Router } from 'express';
import { overpassJson } from 'overpass-ts';
import { checkDatabaseHealth } from '../db/client.js';
import type { RangedPosition } from './apiTypes.js';
import type { SceneFeatureDetail } from '../services/sceneTypes.js';
import { generateReplyWithSystemPrompt } from '../services/llm.js';
import { syncOverpassCoverage } from '@/services/osmNormalization/osmGate.js';
import { runGameChatTurn } from '../services/gameChat.js';
import { getSessionSnapshot } from '../services/gameSessionStore.js';
import {
  buildProjectedSceneSummary,
} from '../services/sceneSummaryService.js';
import type { GameChatRequest } from '../types/game.js';
import type { NormalizedOverpassRequestBody, SummaryPreviewRequestBody } from '../types/overpass.js';
import { buildMicroGrid, fetchMicroGridFromDb } from '@/services/scene/microGridObject.js';
import { buildLabeledMicroGrid } from '@/services/scene/microGridPrompt.js';
import { fetchSceneFeatureDetailsFromDb } from '@/services/scene/sceneUtilFeatureDetail.js';
import { buildPolarViewFeature, fetchScenePolarFeaturesFromDb } from '@/services/scene/polarViewObject.js';
import {
  applyClusterMarkder,
  applyLevelMarker,
  attachLabelBasedOnLevel,
  buildPolarView,
  type PolarView,
} from '@/services/scene/polarViewLabeled.js';
import { applyVisualFilter } from '@/services/scene/polarViewFilter.js';

interface DebugLlmRequestBody {
  systemPrompt?: string;
  message?: string;
}

interface OverpassRequestBody {
  query?: string;
}

const DEBUG_LLM_SYSTEM_PROMPT_PLACEHOLDER = '[debug system prompt placeholder]';

export const apiRouter = Router();

function countPolarFeatures(polarView: PolarView) {
  return polarView.levels.reduce(
    (count, level) => count + level.clusters.reduce((clusterCount, cluster) => clusterCount + cluster.features.length, 0),
    0,
  );
}

function buildDbDiagnostics(input: {
  featureDetails: SceneFeatureDetail[];
  microGrid: ReturnType<typeof buildLabeledMicroGrid>;
  polarView: PolarView;
}) {
  const featureCountsByCategory = input.featureDetails.reduce<Record<'building' | 'poi' | 'line' | 'area', number>>(
    (counts, feature) => {
      counts[feature.category] += 1;
      return counts;
    },
    { building: 0, poi: 0, line: 0, area: 0 },
  );

  return {
    featureCountsByCategory,
    totalFeatures: input.featureDetails.length,
    populatedMicroGridCellCount: input.microGrid.cells.flat().filter((cell) => cell.sourceFeatureIds.length > 0).length,
    polarFeatureCount: countPolarFeatures(input.polarView),
  };
}

function buildDebugSceneFeatureDetailIndex(featureDetails: SceneFeatureDetail[]): Map<string, SceneFeatureDetail> {
  return new Map(featureDetails.map((feature) => [feature.featureId, feature]));
}

function buildDebugPolarView(
  request: RangedPosition,
  polarRecords: Awaited<ReturnType<typeof fetchScenePolarFeaturesFromDb>>,
  featureDetailIndex: ReadonlyMap<string, SceneFeatureDetail>,
): PolarView {
  const polarFeatures = buildPolarViewFeature(request, polarRecords, featureDetailIndex);
  const levelMarked = applyLevelMarker(polarFeatures);
  const labeled = attachLabelBasedOnLevel(levelMarked);
  const clusterMarked = applyClusterMarkder(labeled);
  return applyVisualFilter('naked_eye', buildPolarView(request, clusterMarked));
}

function buildNormalizationDebugPayload(input: {
  normalizedRequest: RangedPosition;
  featureDetails: SceneFeatureDetail[];
  microGridRecords: Awaited<ReturnType<typeof fetchMicroGridFromDb>>;
  polarRecords: Awaited<ReturnType<typeof fetchScenePolarFeaturesFromDb>>;
}) {
  const featureDetailIndex = buildDebugSceneFeatureDetailIndex(input.featureDetails);
  const microGrid = buildLabeledMicroGrid(buildMicroGrid(
    input.normalizedRequest,
    input.microGridRecords,
    featureDetailIndex,
  ));
  const polarView = buildDebugPolarView(
    input.normalizedRequest,
    input.polarRecords,
    featureDetailIndex,
  );
  const diagnostics = buildDbDiagnostics({
    featureDetails: input.featureDetails,
    microGrid,
    polarView,
  });

  return {
    featureSummary: input.featureDetails,
    diagnostics,
    microGrid,
    polarView,
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

function parsePosition(body: Pick<SummaryPreviewRequestBody, 'lat' | 'lon'>) {
  const { lat, lon } = body;

  if (
    typeof lat !== 'number'
    || !Number.isFinite(lat)
    || typeof lon !== 'number'
    || !Number.isFinite(lon)
  ) {
    return { error: 'lat and lon must be finite numbers.' } as const;
  }

  return {
    value: {
      lat,
      lon,
    },
  } as const;
}

apiRouter.get('/health', async (_request, response) => {
  const database = await checkDatabaseHealth();
  // console.log("BE: health");
  response.json({
    ok: database.enabled ? database.ok : true,
    service: 'backend',
    database,
  });
});

apiRouter.post('/debug/llm', async (request, response) => {
  const { systemPrompt, message } = request.body as DebugLlmRequestBody;

  if (!message || !message.trim()) {
    response.status(400).json({ error: 'Message is required.' });
    return;
  }

  try {
    const result = await generateReplyWithSystemPrompt(
      typeof systemPrompt === 'string' ? systemPrompt : DEBUG_LLM_SYSTEM_PROMPT_PLACEHOLDER,
      message.trim(),
    );
    response.json(result);
  } catch (error) {
    response.status(502).json({
      error: error instanceof Error ? error.message : 'Unexpected upstream error.',
    });
  }
});

apiRouter.post('/game/chat', async (request, response) => {
  const { sessionId, message, isOpeningPrompt } = request.body as GameChatRequest;

  if (!message || !message.trim()) {
    response.status(400).json({ error: 'Message is required.' });
    return;
  }

  try {
    const result = await runGameChatTurn({
      sessionId: typeof sessionId === 'string' ? sessionId : undefined,
      message: message.trim(),
      isOpeningPrompt: isOpeningPrompt === true,
    });
    response.json(result);
  } catch (error) {
    response.status(502).json({
      error: error instanceof Error ? error.message : 'Unexpected game chat error.',
    });
  }
});

apiRouter.get('/game/session/:sessionId', async (request, response) => {
  const sessionId = typeof request.params.sessionId === 'string' ? request.params.sessionId.trim() : '';

  if (!sessionId) {
    response.status(400).json({ error: 'sessionId is required.' });
    return;
  }

  try {
    const snapshot = await getSessionSnapshot(sessionId);
    if (!snapshot) {
      response.status(404).json({ error: 'Session not found.' });
      return;
    }

    response.json(snapshot);
  } catch (error) {
    response.status(502).json({
      error: error instanceof Error ? error.message : 'Unexpected session restore error.',
    });
  }
});

apiRouter.post('/debug/overpass', async (request, response) => {
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

apiRouter.post('/debug/db/sync-overpass', async (request, response) => {
  const parsed = parseNormalizedRequest(request.body as NormalizedOverpassRequestBody);

  if ('error' in parsed) {
    response.status(400).json({ error: parsed.error });
    return;
  }

  const normalizedRequest = parsed.value;

  try {
    const result = await syncOverpassCoverage(normalizedRequest);

    response.json({
      query: result.query,
      featureCount: result.features.length,
      counts: result.counts,
      coverageRecorded: true,
    });
  } catch (error) {
    response.status(502).json({
      error: error instanceof Error ? error.message : 'Unexpected database sync error.',
    });
  }
});

apiRouter.post('/debug/db/normalized-load', async (request, response) => {
  const parsed = parseNormalizedRequest(request.body as NormalizedOverpassRequestBody);
  // console.log("BE: normalized-load", parsed);

  if ('error' in parsed) {
    response.status(400).json({ error: parsed.error });
    return;
  }

  const normalizedRequest = parsed.value;

  try {
    const [featureDetails, microGridRecords, polarRecords] = await Promise.all([
      fetchSceneFeatureDetailsFromDb(normalizedRequest, 'debug'),
      fetchMicroGridFromDb(normalizedRequest),
      fetchScenePolarFeaturesFromDb(normalizedRequest, 'debug'),
    ]);

    const debugPayload = buildNormalizationDebugPayload({
      normalizedRequest,
      featureDetails,
      microGridRecords,
      polarRecords,
    });

    response.json({
      query: '[db source]',
      ...debugPayload,
    });
  } catch (error) {
    console.log(error);

    response.status(502).json({
      error: error instanceof Error ? error.message : 'Unexpected database normalized load error.',
    });
  }
});

apiRouter.post('/debug/db/summary-preview', async (request, response) => {
  const body = request.body as SummaryPreviewRequestBody;
  const parsedPosition = parsePosition(body);
  const radius = body.radius;

  if ('error' in parsedPosition) {
    response.status(400).json({ error: parsedPosition.error });
    return;
  }

  if (typeof radius !== 'number' || !Number.isFinite(radius) || radius <= 0) {
    response.status(400).json({ error: 'radius must be a finite number greater than 0.' });
    return;
  }

  try {
    const summaryText = await buildProjectedSceneSummary(
      parsedPosition.value,
      { radius },
      'debug',
    );
    response.json({
      radius,
      summaryText,
    });
  } catch (error) {
    response.status(502).json({
      error: error instanceof Error ? error.message : 'Unexpected summary preview error.',
    });
  }
});

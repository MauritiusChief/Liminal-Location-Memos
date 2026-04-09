import { Router } from 'express';
import { overpassJson } from 'overpass-ts';
import { checkDatabaseHealth } from '../db/client.js';
import type { RangedPosition } from './apiTypes.js';
import { OsmCoverageSyncRetryExhaustedError, syncOverpassCoverage } from '@/services/osmNormalization/osmGate.js';
import { buildMicroGrid, fetchMicroGridFromDb } from '@/services/scene/microGridObject.js';
import { buildLabeledMicroGrid } from '@/services/scene/microGridPrompt.js';
import { fetchFeatureDetailsFromDb, FeatureDetail } from '@/services/featureDetail.js';
import { buildPolarViewFeature, fetchScenePolarFeaturesFromDb } from '@/services/scene/polarViewObject.js';
import {
  applyClusterMarkder,
  buildPolarView,
  type PolarView,
} from '@/services/scene/polarViewLabeled.js';
import { applyVisualFilter } from '@/services/scene/polarViewFilter.js';
import { buildLeveledPolarView, applyOcclusion } from '@/services/scene/polarViewOcclusion.js';
import { buildSceneFromRequest } from '@/services/scene/sceneObject.js';
import { generateReplySingleMessage } from '@/services/gameSystem/llm.js';
import { buildScenePrompt } from '@/services/scene/scenePrompt.js';
import { getSession } from '@/services/gameSystem/gameSessionStore.js';
import { runGameTurn, startGame } from '@/services/gameSystem/gameChat.js';

interface DebugLlmRequestBody {
  systemPrompt?: string;
  message?: string;
}

interface OverpassRequestBody {
  query?: string;
}

interface GameTurnRequestBody {
  sessionId?: string;
  message?: string;
}

interface OrientedDebugRequestBody extends Partial<RangedPosition> {
  playerOrientation?: number;
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
  featureDetails: FeatureDetail[];
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

function buildDebugFeatureDetailIndex(featureDetails: FeatureDetail[]): Map<string, FeatureDetail> {
  return new Map(featureDetails.map((feature) => [feature.featureId, feature]));
}

function buildDebugPolarView(
  request: RangedPosition,
  polarRecords: Awaited<ReturnType<typeof fetchScenePolarFeaturesFromDb>>,
  featureDetailIndex: ReadonlyMap<string, FeatureDetail>,
): PolarView {
  const polarFeatures = buildPolarViewFeature(request, polarRecords, featureDetailIndex);
  const levelMarked = buildLeveledPolarView(request, polarFeatures)
  const occluded = applyOcclusion(levelMarked)
  const clusterMarked = applyClusterMarkder(occluded);
  const clustered = buildPolarView(clusterMarked);
  return applyVisualFilter('naked_eye', clustered);
  // return clustered
}

function buildNormalizationDebugPayload(input: {
  normalizedRequest: RangedPosition;
  featureDetails: FeatureDetail[];
  microGridRecords: Awaited<ReturnType<typeof fetchMicroGridFromDb>>;
  polarRecords: Awaited<ReturnType<typeof fetchScenePolarFeaturesFromDb>>;
}) {
  const featureDetailIndex = buildDebugFeatureDetailIndex(input.featureDetails);
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

function parseNormalizedRequest(body: RangedPosition) {
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

function parseOptionalOrientation(body: { playerOrientation?: unknown }): { value: number } | { error: string } {
  const { playerOrientation } = body;
  if (typeof playerOrientation === 'undefined') {
    return { value: 0 };
  }

  if (typeof playerOrientation !== 'number' || !Number.isFinite(playerOrientation)) {
    return { error: 'playerOrientation must be a finite number.' };
  }

  return { value: playerOrientation };
}

function parsePosition(body: Partial<RangedPosition>) {
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

//#region 常规 API

apiRouter.get('/health', async (_request, response) => {
  const database = await checkDatabaseHealth();
  // console.log("BE: health");
  response.json({
    ok: database.enabled ? database.ok : true,
    service: 'backend',
    database,
  });
});

apiRouter.post('/game/start', async (_request, response) => {
  try {
    const result = await startGame();
    response.json(result);
  } catch (error) {
    if (error instanceof OsmCoverageSyncRetryExhaustedError) {
      response.status(502).json({ error: error.message });
      return;
    }

    response.status(502).json({
      error: error instanceof Error ? error.message : 'Unexpected game start error.',
    });
  }
});

apiRouter.post('/game/turn', async (request, response) => {
  const { sessionId, message } = request.body as GameTurnRequestBody;

  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    response.status(400).json({ error: 'sessionId is required.' });
    return;
  }

  if (!message || !message.trim()) {
    response.status(400).json({ error: 'Message is required.' });
    return;
  }

  try {
    const result = await runGameTurn(sessionId.trim(), message.trim());
    if (!result) {
      response.status(404).json({ error: 'Session not found.' });
      return;
    }

    response.json(result);
  } catch (error) {
    if (error instanceof OsmCoverageSyncRetryExhaustedError) {
      response.status(502).json({ error: error.message });
      return;
    }

    response.status(502).json({
      error: error instanceof Error ? error.message : 'Unexpected game turn error.',
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
    const session = await getSession(sessionId);
    if (!session) {
      response.status(404).json({ error: 'Session not found.' });
      return;
    }

    response.json(session);
  } catch (error) {
    response.status(502).json({
      error: error instanceof Error ? error.message : 'Unexpected session restore error.',
    });
  }
});

//#region DEBUG API

apiRouter.post('/debug/llm', async (request, response) => {
  const { systemPrompt, message } = request.body as DebugLlmRequestBody;

  if (!message || !message.trim()) {
    response.status(400).json({ error: 'Message is required.' });
    return;
  }

  try {
    const result = await generateReplySingleMessage(
      typeof systemPrompt === 'string' ? systemPrompt : DEBUG_LLM_SYSTEM_PROMPT_PLACEHOLDER,
      message.trim(),
    );
    response.json(result);
  } catch (error) {
    response.status(502).json({
      error: error instanceof Error ? error.message : '[未知错误] 发生在 generateReplySingleMessage',
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
  const parsed = parseNormalizedRequest(request.body as RangedPosition);

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
  const body = request.body as OrientedDebugRequestBody;
  const parsed = parseNormalizedRequest(body as RangedPosition);
  const orientationParsed = parseOptionalOrientation(body);
  // console.log("BE: normalized-load", parsed);

  if ('error' in parsed) {
    response.status(400).json({ error: parsed.error });
    return;
  }
  if ('error' in orientationParsed) {
    response.status(400).json({ error: orientationParsed.error });
    return;
  }

  const normalizedRequest = parsed.value;
  const playerOrientation = orientationParsed.value;

  try {
    const [featureDetails, microGridRecords, polarRecords] = await Promise.all([
      fetchFeatureDetailsFromDb(normalizedRequest, 'debug'),
      fetchMicroGridFromDb(normalizedRequest, playerOrientation),
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

/**
 * 预览生成的 Scene Prompt
 */
apiRouter.post('/debug/db/scene-prompt-preview', async (request, response) => {
  const body = request.body as OrientedDebugRequestBody;
  // console.log(body);

  const {value, error} = parsePosition(body);
  const orientationParsed = parseOptionalOrientation(body);
  const radius = body.radius;

  if (error) {
    response.status(400).json({ error });
    return;
  }
  if ('error' in orientationParsed) {
    response.status(400).json({ error: orientationParsed.error });
    return;
  }

  if (typeof radius !== 'number' || !Number.isFinite(radius) || radius <= 0) {
    response.status(400).json({ error: 'radius must be a finite number greater than 0.' });
    return;
  }

  try {
    const {lat, lon} = value
    const rangedPosition: RangedPosition = {lat, lon, radius}
    const playerOrientation = orientationParsed.value;
    // console.log(rangedPosition);
    const sceneObject = await buildSceneFromRequest(rangedPosition, playerOrientation)
    const scenePrompt = buildScenePrompt(sceneObject, playerOrientation)
    response.json({
      radius,
      scenePrompt,
    });
  } catch (error) {
    response.status(502).json({
      error: error instanceof Error ? error.message : '[未知错误] 发生在 buildSceneFromRequest',
    });
  }
});

import { Router } from 'express';
import { overpassJson } from 'overpass-ts';
import { checkDatabaseHealth } from '../db/client.js';
import type { RangedPosition } from './apiTypes.js';
import { syncOverpassCoverage } from '@/services/osmNormalization/osmGate.js';
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
import { streamReplySingleMessage } from '@/services/gameSystem/llm.js';
import { buildScenePrompt } from '@/services/scene/scenePrompt.js';
import { getRuntimeSession, toClientGameSessionSnapshot } from '@/services/gameSystem/gameSessionStore.js';
import { streamGameStart, streamGameTurn, type GameStreamEvent } from '@/services/gameSystem/gameChat.js';
import type { Response } from 'express';
import { generateBuildingSchema } from '@/services/gameSystem/buildingClassifier.js';

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

type NdjsonStreamEvent =
  | { type: 'reply_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

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

/**
 * debug/llm 先使用 NDJSON 而不是一次性 JSON：
 * 1. fetch + ReadableStream 直接可消费，前端不需要额外引入 SSE 客户端；
 * 2. 每行一个最小事件，后续 game turn 也可以复用同一套写流工具。
 */
function startNdjsonStream(response: Response): void {
  response.status(200);
  response.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  response.setHeader('Cache-Control', 'no-cache, no-transform');
  response.setHeader('Connection', 'keep-alive');
  response.flushHeaders();
}

function writeNdjsonEvent(response: Response, event: NdjsonStreamEvent): void {
  response.write(`${JSON.stringify(event)}\n`);
}

function writeGameStreamEvent(response: Response, event: GameStreamEvent): void {
  response.write(`${JSON.stringify(event)}\n`);
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
  startNdjsonStream(response);

  try {
    await streamGameStart(async (event) => {
      writeGameStreamEvent(response, event);
    });
    response.end();
  } catch (error) {
    writeGameStreamEvent(response, {
      type: 'error',
      message: error instanceof Error ? error.message : 'Unexpected game start error.',
    });
    response.end();
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

  startNdjsonStream(response);

  try {
    const result = await streamGameTurn(sessionId.trim(), message.trim(), async (event) => {
      writeGameStreamEvent(response, event);
    });
    if (!result) {
      writeGameStreamEvent(response, { type: 'error', message: 'Session not found.' });
      response.end();
      return;
    }

    response.end();
  } catch (error) {
    writeGameStreamEvent(response, {
      type: 'error',
      message: error instanceof Error ? error.message : 'Unexpected game turn error.',
    });
    response.end();
  }
});

apiRouter.get('/game/session/:sessionId', async (request, response) => {
  const sessionId = typeof request.params.sessionId === 'string' ? request.params.sessionId.trim() : '';

  if (!sessionId) {
    response.status(400).json({ error: 'sessionId is required.' });
    return;
  }

  try {
    const session = await getRuntimeSession(sessionId);
    if (!session) {
      response.status(404).json({ error: 'Session not found.' });
      return;
    }

    response.json(toClientGameSessionSnapshot(session));
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

  startNdjsonStream(response);

  try {
    for await (const event of streamReplySingleMessage(
      typeof systemPrompt === 'string' ? systemPrompt : DEBUG_LLM_SYSTEM_PROMPT_PLACEHOLDER,
      message.trim(),
    )) {
      // 这里仍然只向前端发最小事件集合。
      // debug 页面现在只关心 reply/reasoning 双流，未来 game turn 也可以沿用这种 route 只做“转发领域事件”的职责边界。
      if (event.replyDelta) {
        writeNdjsonEvent(response, { type: 'reply_delta', text: event.replyDelta });
      }
      if (event.reasoningDelta) {
        writeNdjsonEvent(response, { type: 'reasoning_delta', text: event.reasoningDelta });
      }
      if (event.done) {
        writeNdjsonEvent(response, { type: 'done' });
      }
    }

    response.end();
  } catch (error) {
    writeNdjsonEvent(response, {
      type: 'error',
      message: error instanceof Error ? error.message : '[未知错误] 发生在 streamReplySingleMessage',
    });
    response.end();
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
      fetchFeatureDetailsFromDb(normalizedRequest),
      fetchMicroGridFromDb(normalizedRequest, playerOrientation),
      fetchScenePolarFeaturesFromDb(normalizedRequest),
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
    // TODO 测试分类函数
    const {microGrid, polarView} = sceneObject
    const featureIds = [
      ...microGrid.cells.flatMap(cell => cell).flatMap(cell => cell.sourceFeatureIds),
      ...(polarView?.levels.flatMap( l => l.clusters.flatMap( c => c.features.flatMap( f => f.featureId))) ?? [])
    ]
    featureIds.forEach(async id => {
      const b = await generateBuildingSchema(id, [])
      // if (b) console.log(b)
    }) // TODO 当前仅打印
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

import { Router } from 'express';
import { overpassJson } from 'overpass-ts';
import { checkDatabaseHealth } from '../db/client.js';
import type { SceneFeatureDetail } from '../services/scene/sceneTypes.js';
import { generateReplyWithSystemPrompt } from '../services/llm.js';
import { buildNormalizedMicroGrid } from '../services/overpassGrid.js';
import {
  fetchMicroGridFromDb,
  fetchSceneFeatureDetailsFromDb,
  fetchScenePolarFeaturesFromDb,
} from '../services/osmRepository.js';
import { syncOverpassCoverage } from '../services/overpass/overpassSync.js';
import { buildNormalizedPolarView } from '../services/overpassPolar.js';
import { buildDefaultDebugSystemPrompt } from '../services/overpassPrompt.js';
import { type NormalizedOverpassRequest } from '../services/overpassNormalization.js';
import { runGameChatTurn } from '../services/gameChat.js';
import { getSessionSnapshot } from '../services/gameSessionStore.js';
import {
  buildDebugSummaryPreview,
  isSummaryPreviewMode,
  SUMMARY_PREVIEW_MODE_VALUE_LIST,
} from '../services/scene/sceneSummaryService.js';
import type { GameChatRequest } from '../types/game.js';
import type { NormalizedOverpassRequestBody, SummaryPreviewRequestBody } from '../types/overpass.js';

interface DebugLlmRequestBody {
  systemPrompt?: string;
  message?: string;
}

interface OverpassRequestBody {
  query?: string;
}

export const apiRouter = Router();

function buildDbDiagnostics(input: {
  featureDetails: SceneFeatureDetail[];
  microGrid: ReturnType<typeof buildNormalizedMicroGrid>;
  polarView: ReturnType<typeof buildNormalizedPolarView>;
}) {
  // 新 diagnostics 改为围绕“DB-native 投影结果”统计，
  // 这样前端看到的数字就直接对应 grid / polar / prompt 的真实输入。
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
    populatedMicroGridCellCount: input.microGrid.enabled
      ? input.microGrid.cells.flat().filter((cell) => cell.sourceFeatureIds.length > 0).length
      : 0,
    polarFeatureCount: input.polarView.levels.reduce((count, level) => count + level.features.length, 0),
  };
}

function buildDebugSceneFeatureDetailIndex(featureDetails: SceneFeatureDetail[]): Map<string, SceneFeatureDetail> {
  // 统一做成 featureId -> detail 索引，避免 grid/polar/prompt 各自重复扫描数组。
  return new Map(featureDetails.map((feature) => [feature.featureId, feature]));
}

function buildNormalizationDebugPayload(input: {
  normalizedRequest: NormalizedOverpassRequest;
  featureDetails: SceneFeatureDetail[];
  microGridRecords: Awaited<ReturnType<typeof fetchMicroGridFromDb>>;
  polarRecords: Awaited<ReturnType<typeof fetchScenePolarFeaturesFromDb>>;
}) {
  const featureDetailIndex = buildDebugSceneFeatureDetailIndex(input.featureDetails);
  // 这里是 DB-native 调试链路的汇合点：
  // repository 提供三份投影原料，service 层再分别拼出 grid / polar / prompt。
  const microGrid = buildNormalizedMicroGrid({
    request: input.normalizedRequest,
    cells: input.microGridRecords,
    featureDetails: featureDetailIndex,
  });
  const polarView = buildNormalizedPolarView({
    records: input.polarRecords,
    featureDetails: featureDetailIndex,
    request: input.normalizedRequest,
  });
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

function parsePosition(body: Pick<NormalizedOverpassRequestBody, 'lat' | 'lon'>) {
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

function parseSummaryPreviewMode(value: unknown) {
  if (isSummaryPreviewMode(value)) {
    return { value } as const;
  }

  return { error: `summaryMode must be one of ${SUMMARY_PREVIEW_MODE_VALUE_LIST}.` } as const;
}

apiRouter.get('/health', async (_request, response) => {
  const database = await checkDatabaseHealth();
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

apiRouter.post('/game/chat', async (request, response) => {
  const { sessionId, message, isOpeningPrompt } = request.body as GameChatRequest;

  if (!message || !message.trim()) {
    response.status(400).json({ error: 'Message is required.' });
    return;
  }

  try {
    // /game/chat 是首页正式入口。
    // 路由层只做参数校验和错误包装，真正的回合编排在 gameChat service 里。
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
    response.status(502).json({
      error: error instanceof Error ? error.message : 'Unexpected database normalized load error.',
    });
  }
});

apiRouter.post('/debug/db/summary-preview', async (request, response) => {
  const parsedRequest = parsePosition(request.body as SummaryPreviewRequestBody);
  const parsedSummaryMode = parseSummaryPreviewMode((request.body as SummaryPreviewRequestBody).summaryMode);

  if ('error' in parsedRequest) {
    response.status(400).json({ error: parsedRequest.error });
    return;
  }

  if ('error' in parsedSummaryMode) {
    response.status(400).json({ error: parsedSummaryMode.error });
    return;
  }

  try {
    const summaryText = await buildDebugSummaryPreview(parsedRequest.value, parsedSummaryMode.value);
    response.json({
      summaryMode: parsedSummaryMode.value,
      summaryText,
    });
  } catch (error) {
    response.status(502).json({
      error: error instanceof Error ? error.message : 'Unexpected summary preview error.',
    });
  }
});

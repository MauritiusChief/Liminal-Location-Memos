import { Router } from 'express';
import { overpassJson } from 'overpass-ts';
import { checkDatabaseHealth } from '../db/client.js';
import type { DbFeatureDetail } from '../services/dbSceneTypes.js';
import { generateReplyWithSystemPrompt } from '../services/llm.js';
import { buildNormalizedMicroGrid } from '../services/overpassGrid.js';
import {
  fetchFeatureDetailsFromDb,
  fetchMicroGridFromDb,
  fetchPolarFeaturesFromDb,
  syncNormalizedFeaturesToDb,
} from '../services/osmRepository.js';
import { buildNormalizedPolarView } from '../services/overpassPolar.js';
import { buildDefaultDebugSystemPrompt, buildNormalizationPrompt } from '../services/overpassPrompt.js';
import {
  buildNormalizedOverpassQuery,
  convertOverpassToNormalizedFeatures,
  type NormalizedOverpassRequest,
} from '../services/overpassNormalization.js';
import { runGameChatTurn } from '../services/gameChat.js';
import type { GameChatRequest } from '../types/game.js';
import type { NormalizedOverpassRequestBody } from '../types/overpass.js';

interface DebugLlmRequestBody {
  systemPrompt?: string;
  message?: string;
}

interface OverpassRequestBody {
  query?: string;
}

export const apiRouter = Router();

function buildDbDiagnostics(input: {
  featureDetails: DbFeatureDetail[];
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

function buildDbFeatureDetailIndex(featureDetails: DbFeatureDetail[]): Map<string, DbFeatureDetail> {
  // 统一做成 featureId -> detail 索引，避免 grid/polar/prompt 各自重复扫描数组。
  return new Map(featureDetails.map((feature) => [feature.featureId, feature]));
}

function buildNormalizationDebugPayload(input: {
  normalizedRequest: NormalizedOverpassRequest;
  featureDetails: DbFeatureDetail[];
  microGridRecords: Awaited<ReturnType<typeof fetchMicroGridFromDb>>;
  polarRecords: Awaited<ReturnType<typeof fetchPolarFeaturesFromDb>>;
}) {
  const featureDetailIndex = buildDbFeatureDetailIndex(input.featureDetails);
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
  const promptPreview = {
    userPrompt: buildNormalizationPrompt({
      request: input.normalizedRequest,
      microGrid,
      polarView,
      featureDetails: featureDetailIndex,
    }),
  };
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
  const { sessionId, message } = request.body as GameChatRequest;

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
    });
    response.json(result);
  } catch (error) {
    response.status(502).json({
      error: error instanceof Error ? error.message : 'Unexpected game chat error.',
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
    const [featureDetails, microGridRecords, polarRecords] = await Promise.all([
      fetchFeatureDetailsFromDb(normalizedRequest),
      fetchMicroGridFromDb(normalizedRequest),
      fetchPolarFeaturesFromDb(normalizedRequest),
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

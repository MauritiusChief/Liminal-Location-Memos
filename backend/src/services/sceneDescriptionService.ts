import { generateReplyWithSystemPrompt } from './llm.js';
import {
  buildProjectedSceneSummary,
  DEFAULT_LARGE_DESCRIPTION_SUMMARY_MODE,
  DEFAULT_SMALL_DESCRIPTION_SUMMARY_MODE,
} from './sceneSummaryService.js';
import {
  findActiveLargeDescription,
  findNearbySmallDescriptions,
  findReusableSmallDescription,
  insertLargeDescription,
  insertSmallDescription,
} from './sceneDescriptionRepository.js';
import type { GamePosition, LargeDescriptionRecord, LoadedGameSession, SceneContext, SmallDescriptionRecord } from '../types/game.js';
import { styleRule } from './sharedDefaultSysPromptPart.js';

export async function ensureLargeDescription(
  sceneContext: SceneContext,
  session: LoadedGameSession,
): Promise<LargeDescriptionRecord> {
  // 大描述优先复用；只有当前位置不在任何已有描述的有效半径内时才调用 LLM 生成。
  const existing = await findActiveLargeDescription(session, sceneContext.position);
  console.log('[DEBUG] ensureLargeDescription() - reuse result', {
    reused: existing !== null,
    descriptionId: existing?.id ?? null,
    effectiveRadiusM: existing?.effectiveRadiusM ?? null,
  });

  if (existing) {
    return existing;
  }

  console.log('[DEBUG] ensureLargeDescription() - generateReplyWithSystemPrompt() call');
  const conciseFarSummary = await buildProjectedSceneSummary(
    sceneContext.position,
    DEFAULT_LARGE_DESCRIPTION_SUMMARY_MODE,
    'game',
  );
  const generated = await generateReplyWithSystemPrompt(
    [
      '你是一个环境叙述生成器。你的任务是将结构化的地理环境数据转换为用于文字探索游戏的环境描述。',
      '输入是程序根据 OpenStreetMap 场景数据生成的确定性摘要，分为四个距离层级：',
      '0. 0~30 米\n使用一个边长 5米的 12 × 12 的网格表示，玩家位于第6、7行与第6、7列这四个格子的边界的交叉处。\n每个格子代表玩家周围约数米范围内的具体地物或结构，反映非常近距离的空间关系。',
      '1. 30~100 米\n使用极坐标描述周围较近的建筑以及其他要素。',
      '2. 100~300 米\n使用极坐标描述更远的建筑以及其他要素。',
      '3. 300 米~1 公里\n使用极坐标描述视野尽头的建筑以及其他要素。',
      styleRule,
      '叙述视角：\n纯客观视角，禁止提及人称\n',
      '描述顺序：',
      '按距离由近到远组织描述',
      '* 首先描述 0–30 米范围内最明显的物体或空间结构',
      '* 然后描述 30–100 米范围',
      '* 再描述 100–300 米范围',
      '* 最后简要提到远处（300 米–1 公里）的地标或环境轮廓',
    ].join('\n'),
    conciseFarSummary,
    { snapshotType: 'scene-large' },
  );
  console.log('[DEBUG] ensureLargeDescription() - generateReplyWithSystemPrompt() return');

  return insertLargeDescription(session, {
    position: sceneContext.position,
    descriptionText: generated.reply.trim(),
  });
}

export async function ensureSmallDescription(
  sceneContext: SceneContext,
  session: LoadedGameSession,
): Promise<SmallDescriptionRecord> {
  // 小描述也是“先查再生”，只是生成时会额外参考周边小描述的远距可见细节。
  const existing = await findReusableSmallDescription(session, sceneContext.position);
  console.log('[DEBUG] ensureSmallDescription() - reuse result', {
    reused: existing !== null,
    descriptionId: existing?.id ?? null,
    effectiveRadiusM: existing?.effectiveRadiusM ?? null,
  });

  if (existing) {
    return existing;
  }

  console.log('[DEBUG] ensureSmallDescription() - generateSmallDescription() call');
  const nearby = await findNearbySmallDescriptions(session, sceneContext.position, 200);
  const generated = await generateSmallDescription(sceneContext, nearby);
  console.log('[DEBUG] ensureSmallDescription() - generateSmallDescription() return');
  return insertSmallDescription(session, {
    position: sceneContext.position,
    descriptionText: generated.descriptionText,
    farVisibleNotes: generated.farVisibleNotes,
  });
}

export function filterFarVisibleSmallDescriptions(
  records: SmallDescriptionRecord[],
  position: GamePosition,
): SmallDescriptionRecord[] {
  // 这里专门做一层过滤，确保真正喂给后续 prompt 的只有 farVisibleNotes，
  // 不会把别处的小描述全文直接混入当前上下文。
  return records
    .filter((record) => record.farVisibleNotes && record.farVisibleNotes.trim().length > 0)
    .map((record) => ({
      ...record,
      distanceMeters: record.distanceMeters ?? approximateDistanceMeters(position, record.center),
    }))
    .sort((left, right) => (left.distanceMeters || 0) - (right.distanceMeters || 0));
}

async function generateSmallDescription(
  sceneContext: SceneContext,
  nearbySmallDescriptions: SmallDescriptionRecord[],
): Promise<{ descriptionText: string; farVisibleNotes: string | null }> {
  // 小描述生成时要求模型同时返回两部分：
  // 1. descriptionText：给玩家/首页看的自然语言
  // 2. farVisibleNotes：仅给其他小描述复用的远距细节
  const visibleNotes = nearbySmallDescriptions
    .flatMap((record) => (record.farVisibleNotes ? [`- ${record.farVisibleNotes}`] : []))
    .join('\n');
  const conciseNearSummary = await buildProjectedSceneSummary(
    sceneContext.position,
    DEFAULT_SMALL_DESCRIPTION_SUMMARY_MODE,
    'game',
  );
  const generated = await generateReplyWithSystemPrompt(
    [
      '你是一个文字探索游戏中的局部环境描述生成器。',
      '你会根据程序生成的确定性场景摘要，输出一段局部环境描述。',
      '同时你还需要输出一段“本地细节中200米外仍可见的细节的笔记”，供其他邻近描述复用。',
      '输出必须是 JSON 对象，格式为 {"descriptionText":"...","farVisibleNotes":"..."}。',
      'descriptionText 指代的是站在原地，环视周围可以看到的近处与远处的细节。',
      'farVisibleNotes 指代的是假如视角移动到了200米外，在目前场景摘要内所包含的内容中，有哪些是依然能被看到的。比方说可见的轮廓、显著建筑体量、地标等。',
      '如果提供了“供参考的邻近描述细节”，那么 descriptionText 将不仅仅只有近场微观细节如招牌、门牌、30米内观察才能知道的信息等，还需要包含这些邻近描述的细节。',
      '这些其实就是其他邻近描述中的 farVisibleNotes，是用来填充之前提到的“看到的近处与远处的细节”中的“远处的细节”的。',
      styleRule,
      '叙述视角：\n纯客观视角，禁止提及人称\n',
      visibleNotes ? `供参考的邻近描述细节：\n${visibleNotes}` : '当前没有可参考的供参考的邻近描述细节。',
    ].join('\n'),
    conciseNearSummary,
    { snapshotType: 'scene-small' },
  );

  return parseDescriptionJson(generated.reply);
}

function parseDescriptionJson(input: string): { descriptionText: string; farVisibleNotes: string | null } {
  // 模型可能会夹带说明文字，因此这里做宽松解析：
  // 能提取 JSON 就提取，提取失败就把整段回复当 descriptionText。
  const start = input.indexOf('{');
  const end = input.lastIndexOf('}');
  const fallback = {
    descriptionText: input.trim(),
    farVisibleNotes: null,
  };

  if (start < 0 || end <= start) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(input.slice(start, end + 1)) as {
      descriptionText?: unknown;
      farVisibleNotes?: unknown;
    };

    return {
      descriptionText: typeof parsed.descriptionText === 'string' && parsed.descriptionText.trim()
        ? parsed.descriptionText.trim()
        : fallback.descriptionText,
      farVisibleNotes: typeof parsed.farVisibleNotes === 'string' && parsed.farVisibleNotes.trim()
        ? parsed.farVisibleNotes.trim()
        : null,
    };
  } catch {
    return fallback;
  }
}

function approximateDistanceMeters(left: GamePosition, right: GamePosition): number {
  // 这里只用于 UI 排序和补充展示，不要求 GIS 级精度。
  const latFactor = 111320;
  const lonFactor = Math.cos((left.lat * Math.PI) / 180) * 111320;
  const dLat = (right.lat - left.lat) * latFactor;
  const dLon = (right.lon - left.lon) * lonFactor;
  return Math.sqrt((dLat * dLat) + (dLon * dLon));
}

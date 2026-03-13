import { generateReplyWithSystemPrompt } from './llm.js';
import {
  findActiveLargeDescription,
  findNearbySmallDescriptions,
  findReusableSmallDescription,
  insertLargeDescription,
  insertSmallDescription,
} from './sceneDescriptionRepository.js';
import type { GamePosition, LargeDescriptionRecord, LoadedGameSession, SceneContext, SmallDescriptionRecord } from '../types/game.js';

const styleRule = `
游戏设定：
世界与现实世界高度相似，但所有人类突然消失。环境保持现实逻辑，但呈现出无人活动后的静默、空旷和轻微的荒凉感。叙述应客观、细致、具有空间感，不要出现超自然解释或剧情推进，仅描述玩家当前位置周围的环境。

生成规则：

1. 不要复述原始数据结构（不要提到网格、坐标、极坐标以及各个距离层级的具体范围）。
2. 以玩家为中心进行描述，使用类似“你所在的位置”“在你附近”“更远处”等空间表达。
3. 按距离由近到远组织描述：
  * 首先描述 0–30 米范围内最明显的物体或空间结构
  * 然后描述 30–100 米范围
  * 再描述 100–300 米范围
  * 最后简要提到远处（300 米–1 公里）的地标或环境轮廓（若提供有数据）
4. 优先描述：
  * 建筑类型
  * 道路结构
  * 开放空间
  * 自然元素（树、草地、水体）
  * 城市设施（路灯、围栏、停车场等）
5. 语言应简洁但具有画面感，每段 120–220 字左右。
6. 避免主观情绪或文学化过度修辞，保持观察式叙述。
7. 如果数据稀疏，可以描述空旷、未维护的环境状态。

重要提醒：

* 道路或建筑的名称信息在叙述中显式来自于路牌、招牌、标记等环境，禁止凭空产生；必要时可省略名称信息。
* 路牌、招牌、标记等名称信息不要翻译，保持原文语言。
* 避免直接翻译原始数据中的用途标签，而是通过外形特征间接推断出要素的用途。

输出格式：
只输出一段或两段环境描述文本，不要包含解释或标题。

叙述视角：
第二人称（“你”）。
时间默认为白天，天气中性，除非输入信息注明为其他情况。
`

export async function ensureLargeDescription(
  sceneContext: SceneContext,
  session: LoadedGameSession,
): Promise<LargeDescriptionRecord> {
  // 大描述优先复用；只有同 scene 的描述不存在时才调用 LLM 生成。
  const existing = await findActiveLargeDescription(session, sceneContext.position, sceneContext.largeSceneSignature);
  if (existing) {
    return existing;
  }

  const generated = await generateReplyWithSystemPrompt(
    [
      '你是一个环境叙述生成器。你的任务是将结构化的地理环境数据转换为用于文字探索游戏的环境描述。',
      '输入是程序根据 OpenStreetMap 场景数据生成的确定性摘要，分为四个距离层级：',
      '0. 0~30 米\n使用一个边长 5米的 12 × 12 的网格表示，玩家位于第6、7行与第6、7列这四个格子的边界的交叉处。\n每个格子代表玩家周围约数米范围内的具体地物或结构，反映非常近距离的空间关系。',
      '1. 30~100 米\n使用极坐标描述周围较近的建筑以及其他要素。',
      '2. 100~300 米\n使用极坐标描述更远的建筑以及其他要素。',
      '3. 300 米~1 公里\n使用极坐标描述视野尽头的建筑以及其他要素。',
      styleRule
    ].join('\n'),
    sceneContext.largeSummary,
  );

  return insertLargeDescription(session, {
    position: sceneContext.position,
    sourceSceneSignature: sceneContext.largeSceneSignature,
    descriptionText: generated.reply.trim(),
  });
}

export async function ensureSmallDescription(
  sceneContext: SceneContext,
  session: LoadedGameSession,
): Promise<SmallDescriptionRecord> {
  // 小描述也是“先查再生”，只是生成时会额外参考周边小描述的远距可见细节。
  const existing = await findReusableSmallDescription(session, sceneContext.position, sceneContext.smallSceneSignature);
  if (existing) {
    return existing;
  }

  const nearby = await findNearbySmallDescriptions(session, sceneContext.position, 200);
  const generated = await generateSmallDescription(sceneContext, nearby);
  return insertSmallDescription(session, {
    position: sceneContext.position,
    sourceSceneSignature: sceneContext.smallSceneSignature,
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
  const generated = await generateReplyWithSystemPrompt(
    [
      '你是一个文字探索游戏中的局部环境描述生成器。',
      '你会根据程序生成的确定性场景摘要，输出一段局部环境描述。',
      '同时你还需要输出一段“本地细节中200米外仍可见的细节的笔记”，供其他邻近描述复用。',
      '输出必须是 JSON 对象，格式为 {"descriptionText":"...","farVisibleNotes":"..."}。',
      'descriptionText 只能包含仅可在本地可见的细节描述。',
      'farVisibleNotes 只能包含 200 米外仍可见的轮廓、道路走向、显著建筑体量、地标等。',
      '不要把近场微观细节、招牌、门牌、30米内观察才能知道的信息写进 farVisibleNotes。',
      styleRule,
      visibleNotes ? '此处提供临近的描述的远距细节作参考，这部分细节放入"descriptionText"，因为其代表“在本地观察到的别处的情况”，而非“能在别处观察到的本地情况”。' : '',
      visibleNotes ? `可参考的邻近描述远距细节：\n${visibleNotes}` : '当前没有可参考的邻近描述远距细节。',
    ].join('\n'),
    sceneContext.smallSummary,
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

import { randomUUID } from "crypto";
import { FeatureId } from "../featureDetail.js";
import { distanceToPosition } from "../geometry.js";
import { buildSceneFromRequest, SceneObject } from "../scene/sceneObject.js";
import { buildScenePrompt } from "../scene/scenePrompt.js";
import { formatFieldVisualDescriptionPrompt, formatIndoorLocationPrompt, formatVisibleLocationPrompt, pickPlayerState, PlayerState, toPlayerStatePrompt } from "./agentBookComposer.js";
import { writeGameDebugRequest, writeGameDebugResult } from "./gameDebug.js";
import { FieldVisualDescriptionRecord, GameState, PlayerIndoorLocation, Position } from "./gameSessionStore.js";
import { generateJsonReplySingleMessage, generateReplySingleMessage } from "./llm.js";
import { EXTERIOR_VISUAL_DESCRIPTION_SYSTEM, FIELD_VISUAL_DESCRIPTION_SYSTEM, ROOM_VISUAL_DESCRIPTION_SYSTEM } from "./systemPrompts.js";

interface ExtractedExteriorVisualDescription {
  buildingId: FeatureId;
  content: string;
}

const NO_VISUAL_DESCRIPTION_UPDATE = '__NO_UPDATE__'

/**
 * TODO 按照注释补完函数逻辑
 *
 * BOOK MESSAGE 已发送出去之后，根据此 BOOK MESSAGE 为最新的玩家位置激活的 activeXxx 索引
 * 撰写或更新 Field / Exterior / Room Visual Description。
 *
 * Field VD 的规则是：
 * - 索引为经纬度
 * - 玩家经纬度变化则重新计算激活的索引
 * - 若 playerVisionRange 范围内已有索引，则更新索引所指向的记录；
 * - 否则以当前经纬度为索引创建一条新的记录。
 *
 * Exterior VD 的规则是：
 * - 索引为建筑ID
 * - 玩家经纬度变化则重新计算激活的索引
 * - 若 playerVisionRange 范围内有索引指向的建筑则更新之；
 * - 若无索引指向某建筑但可辨认 BOOK MESSAGE 描述某建筑，则新建索引指向此建筑并撰写 VD。
 *
 * Room VD 的规则是：
 * - 索引为建筑ID-楼层No.-房间名
 * - 玩家在楼层里移动则重新计算激活的索引
 * - 只撰写或者更新激活的索引指向的记录
 */
export async function upsertVisualDescriptions(state: GameState, bookMessage: string): Promise<void> {
  const playerState = pickPlayerState(state)
  const { lat, lon } = playerState.playerPosition;
  const {playerVisionRange, playerOrientation} = playerState
  const sceneObject = await buildSceneFromRequest({ lat, lon, radius: playerVisionRange}, playerOrientation);

  // TODO 目前暂时做成根据是否有室内位置返回布尔值，以后情况复杂了再改
  const visualDescribeRouter = Boolean(state.playerIndoorLocation);
  const extracted: Record<string, any> = {}
  // 只在室内分支需要 room VD
  if (visualDescribeRouter) {
    const [
      fieldVD,
      exteriorVD,
      roomVD,
    ] = await Promise.all([
      extractFieldVisualDescriptions(
        playerState,
        bookMessage,
        sceneObject,
      ),
      extractExteriorVisualDescriptions(
        playerState,
        bookMessage,
        sceneObject,
      ),
      extractRoomVisualDescriptions(
        playerState,
        bookMessage,
      ),
    ])
    extracted.field = fieldVD
    extracted.exterior = exteriorVD
    extracted.room = roomVD
  } else { // 否则默认不需要 room VD
    const [
      fieldVD,
      exteriorVD,
    ] = await Promise.all([
      extractFieldVisualDescriptions(
        playerState,
        bookMessage,
        sceneObject,
      ),
      extractExteriorVisualDescriptions(
        playerState,
        bookMessage,
        sceneObject,
      ),
    ])
    extracted.field = fieldVD
    extracted.exterior = exteriorVD
    extracted.room = NO_VISUAL_DESCRIPTION_UPDATE
  }

  const now = new Date().toISOString();

  // 更新 Field Visual Description 的文案
  const matchedFieldRecord = findNearestFieldVisualDescription(state, state.playerPosition);
  if (shouldWriteVisualDescriptionContent(extracted.field) && matchedFieldRecord) {
    matchedFieldRecord.content = extracted.field;
    matchedFieldRecord.updatedAt = now;
  } else if (shouldWriteVisualDescriptionContent(extracted.field)) {
    const newRecord: FieldVisualDescriptionRecord = {
      id: randomUUID(),
      center: { ...state.playerPosition },
      content: extracted.field,
      createdAt: now,
      updatedAt: now,
    };
    state.fieldVisualDescriptions[newRecord.id] = newRecord;
  }

  // 更新 Exterior Visual Description 的文案
  for (const exterior of extracted.exterior) {
    const existing = state.exteriorVisualDescriptions[exterior.buildingId];
    // 如果 exterior.buildingId 所指者不存在会自动创建
    state.exteriorVisualDescriptions[exterior.buildingId] = {
      buildingId: exterior.buildingId,
      content: exterior.content,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
  }

  // Room VD
  if (
    shouldWriteVisualDescriptionContent(extracted.room)
    && state.playerIndoorLocation
  ) {
    const location = state.playerIndoorLocation
    const existing = findRoomVisualDescription(state, location);

    const uniqueRoomId = existing?.id ?? `${location.buildingId}-${location.roomId}`;
    state.roomVisualDescriptions[uniqueRoomId] = {
      buildingId: location.buildingId,
      level: location.level,
      roomId: location.roomId,
      content: extracted.room,
      createdAt: existing?.record.createdAt ?? now,
      updatedAt: now,
    };
  }
}

/**
 * 更新 Book Composer 与前端 debug 快照共用的 activeXxx 记录索引，
 * 确保 activeXxx 列表总是指向最新状态下可见的细节记录。
 */
export function updateActiveVisualDescriptionRefs(state: GameState): void {
  updateActiveFieldVisualDescriptionRefs(state);
  updateActiveExteriorVisualDescriptionRefs(state);
  updateActiveRoomVisualDescriptionRefs(state);
}


//###################
//#region 共用 VD 函数
//###################


function shouldWriteVisualDescriptionContent(content: string): boolean {
  // 固定哨兵值表示“本轮不更新”，避免在解析阶段提前丢掉这层语义。
  return content !== NO_VISUAL_DESCRIPTION_UPDATE && Boolean(content.trim());
}


//#####################
//#region Field VD 函数
//#####################


/**
 * 从某个 Book Message 里提取事实性细节供记录，以维持事实一致性。
 *
 * 这里的目标是把 Book 里已经说出的、之后应该继续视为事实的细节抽出来，
 * @param bookMessage
 * @returns
 */
async function extractFieldVisualDescriptions(
  state: PlayerState,
  bookMessage: string,
  scene: SceneObject,
): Promise<string> {
  console.log(`[${new Date().toISOString()}] 开始 extractFieldVisualDescriptions()`);

  const scenePrompt = buildScenePrompt(scene, state.playerOrientation);
  const oldFieldVisualDescriptionPrompt =  Object.values(state.activeFieldVisualDescriptions)
    .map(record => formatFieldVisualDescriptionPrompt(state, record))
    .join('\n\n')
  const message = [
    '玩家周遭室外环境摘要：',
    scenePrompt,
    '---',
    '旧的 Field Visual Description：',
    oldFieldVisualDescriptionPrompt.trim() ?? '（暂无）',
    '---',
    '文本描述：',
    bookMessage,
  ].join('\n');
  await writeGameDebugRequest({
    mode: 'user-message',
    functionName: 'extractFieldVisualDescriptions',
    systemPrompt: FIELD_VISUAL_DESCRIPTION_SYSTEM,
    userMessage: message,
  });

  try {
    const response = await generateReplySingleMessage(
      FIELD_VISUAL_DESCRIPTION_SYSTEM,
      message,
    );
    const extracted = response.reply;
    await writeGameDebugResult({
      functionName: 'extractFieldVisualDescriptions',
      reply: extracted,
      reasoning: response.reasoning,
    });
    console.log(`[${new Date().toISOString()}] extractFieldVisualDescriptions() 执行成功`);
    return extracted;
  } catch (error) {
    await writeGameDebugResult({
      functionName: 'extractFieldVisualDescriptions',
      error,
    });
    throw error;
  }
}

/**
 * 根据当前玩家位置，重新计算哪些 Field Visual Description 处于激活状态。
 *
 * 当前最小规则很直白：只要中心点在玩家 300m 范围内，就算 active。
 */
function updateActiveFieldVisualDescriptionRefs(state: GameState): void {
  const records = Object.values(state.fieldVisualDescriptions)
    .filter((record) => distanceToPosition(record.center, state.playerPosition) <= state.playerVisionRange)

  state.activeFieldVisualDescriptions = records.map((record) => record.id);
}

/**
 * 查找“距离当前位置最近，且仍在 300m 生效范围内”的 Field Visual Description。
 *
 * 这个函数的结果决定 upsertVisualDescriptions() 是复用旧 Field 记录还是新建记录。
 */
function findNearestFieldVisualDescription(
  state: GameState,
  position: Position,
): FieldVisualDescriptionRecord | null {
  const records = Object.values(state.fieldVisualDescriptions)
    .map((record) => ({
      record,
      distanceMeters: distanceToPosition(record.center, position),
    }))
    .filter((entry) => entry.distanceMeters <= state.playerVisionRange)
    .sort((left, right) => left.distanceMeters - right.distanceMeters);

  return records[0]?.record || null;
}


//########################
//#region Exterior VD 函数
//########################


async function extractExteriorVisualDescriptions(
  state: PlayerState,
  bookMessage: string,
  scene: SceneObject,
): Promise<ExtractedExteriorVisualDescription[]> {
  console.log(`[${new Date().toISOString()}] 开始 extractExteriorVisualDescriptions()`);

  const scenePrompt = buildScenePrompt(scene, state.playerOrientation);
  const oldExteriorVisualDescriptionPrompt =  Object.values(state.activeExteriorVisualDescriptions)
    .map(record => [`buildingId=${record.buildingId}:`, record.content].join('\n'))
    .join('\n\n')
  const visibleBuildingIds = Object.keys(state.playerBuildingRecords)
  const message = [
    '玩家周遭室外环境摘要：',
    scenePrompt,
    '---',
    '当前可写入 Exterior Visual Description 的建筑 id：',
    visibleBuildingIds.length ? visibleBuildingIds.join(', ') : '（暂无）',
    '---',
    '旧的 Exterior Visual Description：',
    oldExteriorVisualDescriptionPrompt.trim() ?? '（暂无）',
    '---',
    '文本描述：',
    bookMessage,
  ].join('\n');
  await writeGameDebugRequest({
    mode: 'user-message',
    functionName: 'extractExteriorVisualDescriptions',
    systemPrompt: EXTERIOR_VISUAL_DESCRIPTION_SYSTEM,
    userMessage: message,
  });

  try {
    const response = await generateJsonReplySingleMessage(
      EXTERIOR_VISUAL_DESCRIPTION_SYSTEM,
      message,
    );
    const extracted: ExtractedExteriorVisualDescription[] = JSON.parse(response.reply);
    await writeGameDebugResult({
      functionName: 'extractExteriorVisualDescriptions',
      reply: extracted,
      reasoning: response.reasoning,
    });
    console.log(`[${new Date().toISOString()}] extractExteriorVisualDescriptions() 执行成功`);
    return extracted;
  } catch (error) {
    await writeGameDebugResult({
      functionName: 'extractExteriorVisualDescriptions',
      error,
    });
    throw error;
  }
}

/**
 * TODO 添加建筑的范围过滤逻辑，避免整个 Scene Object 中的建筑全都可以看清外观细节
 * 可利用 Building Record 中的 centerPosition 信息
 */
function updateActiveExteriorVisualDescriptionRefs(state: GameState): void {
  state.activeExteriorVisualDescriptions = Object.keys(state.exteriorVisualDescriptions)
}


//######################
//#region Room VD 函数
//######################


/**
 * 比对的固定式细节是 Building Record (以及未来可能的存储的物品细节等)，而非 Field/Exterior VD 使用的 OSM 数据
 * @param bookMessage
 */
async function extractRoomVisualDescriptions(
  state: PlayerState,
  bookMessage: string,
): Promise<string> {
  console.log(`[${new Date().toISOString()}] 开始 extractRoomVisualDescriptions()`);

  const indoorLocationPrompt = formatIndoorLocationPrompt(state)

  const visibleLocationPrompt = state.playerIndoorLocation
      ? state.playerVisibleLocations.map(location => formatVisibleLocationPrompt(location)).join('\n')
      : null;
  const oldRoomVisualDescriptionPrompt =  Object.values(state.activeRoomVisualDescriptions)
    .map((record) => [`建筑ID：${record.buildingId}`, `房间：level ${record.level} - ${record.roomId}`, record.content].join('\n'))
    .join('\n\n');
  const message = [
    '玩家所处房间：',
    indoorLocationPrompt || '（当前未提供室内位置）',
    '---',
    '玩家可见室内场景摘要：',
    visibleLocationPrompt || '（当前未提供室内摘要）',
    '---',
    '旧的 Room Visual Description：',
    oldRoomVisualDescriptionPrompt.trim() ?? '（暂无）',
    '---',
    '文本描述：',
    bookMessage,
  ].join('\n');
  await writeGameDebugRequest({
    mode: 'user-message',
    functionName: 'extractRoomVisualDescriptions',
    systemPrompt: ROOM_VISUAL_DESCRIPTION_SYSTEM,
    userMessage: message,
  });

  try {
    const response = await generateReplySingleMessage(
      ROOM_VISUAL_DESCRIPTION_SYSTEM,
      message,
    );
    const extracted = response.reply;
    await writeGameDebugResult({
      functionName: 'extractRoomVisualDescriptions',
      reply: extracted,
      reasoning: response.reasoning,
    });
    console.log(`[${new Date().toISOString()}] extractRoomVisualDescriptions() 执行成功`);
    return extracted;
  } catch (error) {
    await writeGameDebugResult({
      functionName: 'extractRoomVisualDescriptions',
      error,
    });
    throw error;
  }
}

/**
 * 只激活玩家当前所处房间对应的 Room VD
 * @param state
 */
function updateActiveRoomVisualDescriptionRefs(state: GameState): void {
  const location = state.playerIndoorLocation;
  if (!location) {
    state.activeRoomVisualDescriptions = [];
    return;
  }

  state.activeRoomVisualDescriptions = Object.entries(state.roomVisualDescriptions)
    .filter(([, record]) => (
      record.buildingId === location.buildingId
      && record.level === location.level
      && record.roomId === location.roomId
    ))
    .map(([id]) => id);
}

function findRoomVisualDescription(
  state: GameState,
  location: PlayerIndoorLocation,
): { id: string; record: GameState['roomVisualDescriptions'][string] } | null {
  const entry = Object.entries(state.roomVisualDescriptions)
    .find(([, record]) => (
      record.buildingId === location.buildingId
      && record.level === location.level
      && record.roomId === location.roomId
    ));

  return entry ? { id: entry[0], record: entry[1] } : null;
}

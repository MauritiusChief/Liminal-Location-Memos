import { randomUUID } from "crypto";
import { FeatureId } from "../featureDetail.js";
import { distanceToPosition } from "../geometry.js";
import { buildSceneFromRequest, SceneObject } from "../scene/sceneObject.js";
import { buildScenePrompt } from "../scene/scenePrompt.js";
import { formatFieldVisualDescriptionPrompt, formatIndoorLocationPrompt, formatVisibleLocationPrompt, pickPlayerState, PlayerState, toPlayerStatePrompt } from "./agentBookComposer.js";
import { writeGameDebugRequest, writeGameDebugResult } from "./gameDebug.js";
import { FieldVisualDescriptionRecord, GameState, PlayerIndoorLocation, Position } from "./gameSessionStore.js";
import { generateJsonReplySingleMessage, generateReplySingleMessage } from "./llm.js";
import { EXTERIOR_VISUAL_DESCRIPTION_SYSTEM, FIELD_VISUAL_DESCRIPTION_SYSTEM, SECTOR_VISUAL_DESCRIPTION_SYSTEM } from "./systemPrompts.js";

interface ExtractedExteriorVisualDescription {
  buildingId: FeatureId;
  content: string;
}

const NO_VISUAL_DESCRIPTION_UPDATE = '__NO_UPDATE__'

/**
 * TODO 按照注释补完函数逻辑
 *
 * BOOK MESSAGE 已发送出去之后，根据此 BOOK MESSAGE 为最新的玩家位置激活的 activeXxx 索引
 * 撰写或更新 Field / Exterior / Sector Visual Description。
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
 * Sector VD 的规则是：
 * - 索引为建筑ID-楼层No.-区域名
 * - 玩家在楼层里移动则重新计算激活的索引
 * - 只撰写或者更新激活的索引指向的记录
 */
export async function upsertVisualDescriptions(state: GameState, bookMessage: string): Promise<void> {
  const playerState = pickPlayerState(state)
  const { lat, lon } = playerState.playerPosition;
  const {playerVisionRange, playerOrientation} = playerState
  const sceneObject = await buildSceneFromRequest({ lat, lon, radius: playerVisionRange}, playerOrientation);

  // TODO 一次性生成所有 VD 可能不稳定
  const [
    fieldVD,
    exteriorVD,
    sectorVD,
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
    extractSectorVisualDescriptions(
      playerState,
      bookMessage,
    ),
  ])
  const extracted = {field: fieldVD, exterior: exteriorVD, sector: sectorVD}

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

  // Sector VD 仍以整个 sector 为记录单位，套房内看到的细节也写回所属 sector。
  if (
    shouldWriteVisualDescriptionContent(extracted.sector)
    && state.playerIndoorLocation
  ) {
    const location = state.playerIndoorLocation
    const existing = findSectorVisualDescription(state, location);

    const sectorId = existing?.id ?? randomUUID();
    state.sectorVisualDescriptions[sectorId] = {
      buildingId: location.buildingId,
      level: location.level,
      sectorName: location.sectorName,
      content: extracted.sector,
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
  updateActiveSectorVisualDescriptionRefs(state);
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
  const visibleBuildingIds = Object.keys(state.activeBuildingRecords)
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
//#region Sector VD 函数
//######################


/**
 * 比对的固定式细节是 Building Record (以及未来可能的存储的物品细节等)，而非 Field/Exterior VD 使用的 OSM 数据
 * @param bookMessage
 */
async function extractSectorVisualDescriptions(
  state: PlayerState,
  bookMessage: string,
): Promise<string> {
  console.log(`[${new Date().toISOString()}] 开始 extractSectorVisualDescriptions()`);

  const indoorLocationPrompt = formatIndoorLocationPrompt(state)

  const visibleLocationPrompt = state.playerIndoorLocation
      ? state.activeVisibleLocations.map(location => formatVisibleLocationPrompt(location)).join('\n')
      : null;
  const oldSectorVisualDescriptionPrompt =  Object.values(state.activeSectorVisualDescriptions)
    .map((record) => [`buildingId=${record.buildingId}`, `区域：level ${record.level} - ${record.sectorName}`, record.content].join('\n'))
    .join('\n\n');
  const message = [
    '玩家所处房间：',
    indoorLocationPrompt || '（当前未提供室内位置）',
    '---',
    '玩家可见室内场景摘要：',
    visibleLocationPrompt || '（当前未提供室内摘要）',
    '---',
    '旧的 Sector Visual Description：',
    oldSectorVisualDescriptionPrompt.trim() ?? '（暂无）',
    '---',
    '文本描述：',
    bookMessage,
  ].join('\n');
  await writeGameDebugRequest({
    mode: 'user-message',
    functionName: 'extractSectorVisualDescriptions',
    systemPrompt: SECTOR_VISUAL_DESCRIPTION_SYSTEM,
    userMessage: message,
  });

  try {
    const response = await generateReplySingleMessage(
      SECTOR_VISUAL_DESCRIPTION_SYSTEM,
      message,
    );
    const extracted = response.reply;
    await writeGameDebugResult({
      functionName: 'extractSectorVisualDescriptions',
      reply: extracted,
      reasoning: response.reasoning,
    });
    return extracted;
  } catch (error) {
    await writeGameDebugResult({
      functionName: 'extractSectorVisualDescriptions',
      error,
    });
    throw error;
  }
}

/**
 * 只激活玩家当前所处 building + level + sector 对应的 Sector VD。
 * 这和 activeVisibleLocations 的 suite 内外可见范围是两套职责：
 * - activeVisibleLocations 控制玩家当前能看到哪些室内位置；
 * - activeSectorVisualDescriptions 控制整条 sector 级事实记录是否注入 prompt。
 * @param state
 */
function updateActiveSectorVisualDescriptionRefs(state: GameState): void {
  const location = state.playerIndoorLocation;
  if (!location) {
    state.activeSectorVisualDescriptions = [];
    return;
  }

  state.activeSectorVisualDescriptions = Object.entries(state.sectorVisualDescriptions)
    .filter(([, sectorRecord]) => (
      sectorRecord.buildingId === location.buildingId
      && sectorRecord.level === location.level
      && sectorRecord.sectorName === location.sectorName
    ))
    .map(([id]) => id);
}

function findSectorVisualDescription(
  state: GameState,
  location: PlayerIndoorLocation,
): { id: string; record: GameState['sectorVisualDescriptions'][string] } | null {
  const entry = Object.entries(state.sectorVisualDescriptions)
    .find(([, record]) => (
      record.buildingId === location.buildingId
      && record.level === location.level
      && record.sectorName === location.sectorName
    ));

  return entry ? { id: entry[0], record: entry[1] } : null;
}

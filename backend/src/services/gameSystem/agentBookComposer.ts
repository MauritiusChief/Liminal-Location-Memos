import { bearingBetweenCoordinates, distanceBetweenCoordinates, distanceToPosition } from "../geometry.js";
import { formatRelativeDirection } from "../scene/polarViewPrompt.js";
import { buildSceneFromRequest, SceneObject } from "../scene/sceneObject.js";
import { buildScenePrompt } from "../scene/scenePrompt.js";
import { BuildingRecord } from "./buildingRecord.js";
import { EmitGameEvent } from "./gameChat.js";
import { writeGameDebugRequest, writeGameDebugResult } from "./gameDebug.js";
import { ExteriorVisualDescriptionRecord, FieldVisualDescriptionRecord, GameMessage, GameState, PlayerIndoorLocation, PlayerVisibleLocation, Position, SectorVisualDescriptionRecord } from "./gameSessionStore.js";
import { streamReplyFullMessages, streamReplySingleMessage } from "./llm.js";
import { INDOOR_INITIAL_BOOK_MESSAGE_SYSTEM, OUTDOOR_INITIAL_BOOK_MESSAGE_SYSTEM, REGULAR_BOOK_MESSAGE_SYSTEM } from "./systemPrompts.js";

/**
 * 每次在 Book Composer 使用之前通过 Game State 生成，随即转为 Player State Prompt
 */
export interface PlayerState {
  playerPosition: Position;
  playerOrientation: number;
  playerIndoorLocation: PlayerIndoorLocation | null;
  playerVisionRange: number;
  recentMessageHistory: GameMessage[];
  // 下列内容经过筛选，只包含玩家可见部分
  activeBuildingRecords: Record<string, BuildingRecord>;
  activeVisibleLocations: PlayerVisibleLocation[];
  // 只包含玩家可见的 Visual Description
  activeFieldVisualDescriptions: Record<string, FieldVisualDescriptionRecord>;
  activeExteriorVisualDescriptions: Record<string, ExteriorVisualDescriptionRecord>
  activeSectorVisualDescriptions: Record<string, SectorVisualDescriptionRecord>;
}

/**
 * 根据 request 生成 Scene Prompt，然后 stream 第一条 Book Message
 * @param state
 * @param emit
 * @returns 整个游戏的第一条描述周遭状况的 Book Message
 */
export async function streamInitialBookMessage(
  state: GameState,
  emit: EmitGameEvent,
): Promise<string> {
  console.log(`[${new Date().toISOString()}] streamInitialBookMessage() 触发`);

  const playerState = pickPlayerState(state)
  const { lat, lon } = playerState.playerPosition;
  const {playerVisionRange, playerOrientation, playerIndoorLocation} = playerState

  // TODO 目前暂时做成根据是否有室内位置返回布尔值，以后情况复杂了再改
  const openingRouteer = Boolean(playerIndoorLocation);
  const sceneObject = openingRouteer
    ? undefined
    : await buildSceneFromRequest({ lat, lon, radius: playerVisionRange }, playerOrientation);
  const playerStatePrompt = toPlayerStatePrompt(playerState, sceneObject);
  const systemPrompt = openingRouteer
    ? INDOOR_INITIAL_BOOK_MESSAGE_SYSTEM
    : OUTDOOR_INITIAL_BOOK_MESSAGE_SYSTEM;
  await writeGameDebugRequest({
    mode: 'user-message',
    functionName: 'streamInitialBookMessage',
    systemPrompt,
    userMessage: playerStatePrompt,
  });

  let reply = '';
  let reasoning = '';

  try {
    for await (const event of streamReplySingleMessage(
      systemPrompt,
      playerStatePrompt,
    )) {
      if (event.replyDelta) {
        reply += event.replyDelta;
        await emit({ type: 'book_reply_delta', text: event.replyDelta });
      }
      if (event.reasoningDelta) {
        reasoning += event.reasoningDelta;
      }
    }

    await writeGameDebugResult({
      functionName: 'streamInitialBookMessage',
      reply,
      reasoning,
    });
    return reply;
  } catch (error) {
    await writeGameDebugResult({
      functionName: 'initialBookMessage',
      error,
    });
    throw error;
  }
}

/**
 * 输入 GameState，挑选所需部分组成 PlayerState，然后流式输送常规回合 Book Message。
 * 过程中会用到传统的 sys, user, assist, tool, assist... 这样的 messages 结构。
 *
 * 这里最近一段 messageHistory 是从 PlayerState 中分离出来的，随后会和包含了 Scene Prompt 的 playerStatePrompt 一起发给模型。
 * @param state
 * @param emit
 * @returns
 */
export async function streamRegularBookMessage(
  state: GameState,
  emit: EmitGameEvent,
): Promise<string> {
  console.log(`[${new Date().toISOString()}] streamRegularBookMessage() 触发`);

  const playerState = pickPlayerState(state)
  const { lat, lon } = playerState.playerPosition;
  const {playerVisionRange, playerOrientation} = playerState
  const sceneObject = await buildSceneFromRequest({ lat, lon, radius: playerVisionRange}, playerOrientation);
  const playerStatePrompt = toPlayerStatePrompt(playerState, sceneObject);
  // 组装消息历史
  const messageHistory = state.messageHistory.slice(Math.max(0, state.messageHistory.length - 12));
  await writeGameDebugRequest({
    mode: 'full-messages',
    functionName: 'streamRegularBookMessage',
    systemPrompt: REGULAR_BOOK_MESSAGE_SYSTEM,
    gameMessages: messageHistory,
    statePrompt: playerStatePrompt,
  });

  let reply = '';
  let reasoning = '';

  try {
    for await (const event of streamReplyFullMessages(
      REGULAR_BOOK_MESSAGE_SYSTEM,
      messageHistory,
      playerStatePrompt,
    )) {
      if (event.replyDelta) {
        reply += event.replyDelta;
        await emit({ type: 'book_reply_delta', text: event.replyDelta });
      }
      if (event.reasoningDelta) {
        reasoning += event.reasoningDelta;
      }
    }

    await writeGameDebugResult({
      functionName: 'streamRegularBookMessage',
      reply,
      reasoning,
    });
    return reply;
  } catch (error) {
    await writeGameDebugResult({
      functionName: 'streamRegularBookMessage',
      error,
    });
    throw error;
  }
}

const PLAYER_STATE_BUILDING_RECORD_RANGE = 300

//#region 内部逻辑

export function pickPlayerState(state: GameState): PlayerState {
  const {playerPosition, playerOrientation, playerIndoorLocation, playerVisionRange, activeVisibleLocations} = state
  // TODO 也许需要动用数据库，判断建筑的最近点而非建筑的中心
  const activeBuildingRecords = Object.fromEntries(Object.entries(state.buildingRecords).filter(
    ([featureId, record]) => {
      const {lon: recordLon, lat: recordLat} = record.centerPosition
      const {lon: playerLon, lat: playerLat} = state.playerPosition
      return distanceBetweenCoordinates([recordLon, recordLat], [playerLon, playerLat]) < state.playerVisionRange
      // return featureId === state.playerIndoorLocation?.buildingId
    }
  ))
  const activeFieldVisualDescriptions = Object.fromEntries(Object.entries(state.fieldVisualDescriptions).filter(
    ([uuid, _]) => state.activeFieldVisualDescriptions.includes(uuid)
  ))
  const activeExteriorVisualDescriptions = Object.fromEntries(Object.entries(state.exteriorVisualDescriptions).filter(
    ([featureId, _]) => state.activeExteriorVisualDescriptions.includes(featureId)
  ))
  const activeSectorVisualDescriptions = Object.fromEntries(Object.entries(state.sectorVisualDescriptions).filter(
    ([uuid, _]) => state.activeSectorVisualDescriptions.includes(uuid)
  ))
  return {
    playerPosition,
    playerOrientation,
    playerIndoorLocation,
    playerVisionRange,
    recentMessageHistory: state.messageHistory.slice(-12),
    activeVisibleLocations,
    activeBuildingRecords,
    activeFieldVisualDescriptions,
    activeExteriorVisualDescriptions,
    activeSectorVisualDescriptions,
  }
}

/**
 * 玩家可见、已知的信息，但不包括历史消息信息（历史消息只在 streamRegularBookMessage 用到，故由其自行提取并处理）
 * @param state
 * @param scene 已根据 playerVisionRange 生成的 SceneObject
 * @returns
 */
export function toPlayerStatePrompt(state: PlayerState, scene?: SceneObject): string {
  const scenePrompt = scene ? buildScenePrompt(scene, state.playerOrientation) : null;
  const fieldVisualDescriptionPrompt =  Object.values(state.activeFieldVisualDescriptions)
    .map(record => formatFieldVisualDescriptionPrompt(state, record))
    .join('\n\n')
  const exteriorVisualDescriptionPrompt =  Object.values(state.activeExteriorVisualDescriptions)
    .map((record) => [`buildingId=${record.buildingId}`, record.content].join('\n'))
    .join('\n');
  const visibleLocationPrompt = state.playerIndoorLocation
    ? state.activeVisibleLocations.map(location => formatVisibleLocationPrompt(location)).join('\n')
    : null;

  const indoorLocationPrompt = formatIndoorLocationPrompt(state)

  const sectorVisualDescriptionPrompt = Object.values(state.activeSectorVisualDescriptions)
    .map((record) => [`buildingId=${record.buildingId}`, `区域：level ${record.level} - ${record.sectorName}`, record.content].join('\n'))
    .join('\n\n');
  // 组装提示词
  const sections = [
    '玩家周遭室外环境摘要：',
    scenePrompt || '（当前未提供室外摘要）',
    '---',
    '玩家周遭地点细节记录：',
    fieldVisualDescriptionPrompt || '（暂无）',
    '---',
    '玩家周遭建筑外观细节记录：',
    exteriorVisualDescriptionPrompt || '（暂无）',
    '---',
    '玩家所处房间：',
    indoorLocationPrompt || '（当前未提供室内位置）',
    '---',
    '玩家可见室内场景摘要：',
    visibleLocationPrompt || '（当前未提供室内摘要）',
    '---',
    '玩家所处室内区域细节记录：',
    sectorVisualDescriptionPrompt || '（暂无）',
  ];
  return sections.join('\n');
}

//#region 辅助函数

export function formatFieldVisualDescriptionPrompt(state: PlayerState, record: FieldVisualDescriptionRecord): string {
  const distanceMeters = distanceToPosition(state.playerPosition, record.center);
  const bearingDegrees = bearingBetweenCoordinates(
    [state.playerPosition.lon, state.playerPosition.lat],
    [record.center.lon, record.center.lat],
  );

  return [
    `* 距离${Math.round(distanceMeters)}m / ${formatRelativeDirection(bearingDegrees, state.playerOrientation)}`,
    record.content,
  ].join('\n');
}

export function formatVisibleLocationPrompt(visibleLocation: PlayerVisibleLocation): string {
  // 套房
  if (visibleLocation.locationType === 'suite') {
    return [
      `* 楼层：level ${visibleLocation.level}`,
      `区域：${visibleLocation.sectorName}`,
      `套房：${visibleLocation.suiteId} - ${visibleLocation.suiteDescription} （仅表层可见）`,
    ].join(' - ');
  }
  // 兼容普通房间和套房子房间
  return [
    `* 楼层：level ${visibleLocation.level}`,
    `区域：${visibleLocation.sectorName}`,
    visibleLocation.suiteId
      ? `套房：${visibleLocation.suiteId} - 房间ID：${visibleLocation.roomId} - ${visibleLocation.roomDescription}`
      : `房间ID：${visibleLocation.roomId} - ${visibleLocation.roomDescription}`,
  ].join(' - ');
}

export function formatIndoorLocationPrompt(state: PlayerState): string | null {
  const location = state.playerIndoorLocation;
  if (!location) {
    return null;
  }
  const record = state.activeBuildingRecords[location.buildingId];

  return [
    `建筑ID：${record.featureId}`,
    `建筑类别：${record.category}`,
    `建筑几何中心：(${record.centerPosition.lat}, ${record.centerPosition.lon})`,
    `建筑附带标签：${JSON.stringify(record.tags)}`,
    `当前楼层：level ${location.level}`,
    `当前区域：${location.sectorName}`,
    location.suiteId
      ? `当前房间：套房 ${location.suiteId} - 房间 ${location.roomId} - ${location.roomDescription}`
      : `当前房间：房间 ${location.roomId} - ${location.roomDescription}`,
  ].join('\n')
}
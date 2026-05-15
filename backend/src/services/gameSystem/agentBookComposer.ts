import { bearingBetweenCoordinates, distanceBetweenCoordinates, distanceToPosition } from "../geometry.js";
import { formatRelativeDirection } from "../scene/polarViewPrompt.js";
import { buildSceneFromRequest, SceneObject } from "../scene/sceneObject.js";
import { buildScenePrompt } from "../scene/scenePrompt.js";
import { WorldState } from "./agentStateManager.js";
import type { BuildingRecord } from "../buildingGeneration/buildingRecord.js";
import { findRoomInBuilding } from "../buildingGeneration/buildingRecord.js";
import type { CardboardFurnitureRecord, FurnitureRecord } from "../objectGeneration/furnitureTemplates.js";
import type { CardboardItemRecord, ItemRecord, PartRecord } from "../objectGeneration/itemTemplates.js";
import { EmitGameEvent } from "./gameChat.js";
import { writeGameDebugRequest, writeGameDebugResult } from "./gameDebug.js";
import { ExteriorVisualDescriptionRecord, FieldVisualDescriptionRecord, GameMessage, GameState, PlayerIndoorLocation, PlayerVisibleLocation, Position, RoomVisualDescriptionRecord } from "./gameSessionStore.js";
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
  playerBuildingRecords: Record<string, BuildingRecord>;
  playerVisibleLocations: PlayerVisibleLocation[];
  // 只包含玩家可见的 Visual Description
  activeFieldVisualDescriptions: Record<string, FieldVisualDescriptionRecord>;
  activeExteriorVisualDescriptions: Record<string, ExteriorVisualDescriptionRecord>
  activeRoomVisualDescriptions: Record<string, RoomVisualDescriptionRecord>;
}

//#region 主函数

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
  const openingRouter = Boolean(playerIndoorLocation);
  const sceneObject = openingRouter
    ? undefined
    : await buildSceneFromRequest({ lat, lon, radius: playerVisionRange }, playerOrientation);
  const playerStatePrompt = toPlayerStatePrompt(playerState, sceneObject);
  const systemPrompt = openingRouter
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
  const {playerPosition, playerOrientation, playerIndoorLocation, playerVisionRange, playerVisibleLocations} = state
  // TODO 也许需要动用数据库，判断建筑的最近点而非建筑的中心
  const playerBuildingRecords = Object.fromEntries(Object.entries(state.buildingRecords).filter(
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
  const activeRoomVisualDescriptions = Object.fromEntries(Object.entries(state.roomVisualDescriptions).filter(
    ([uuid, _]) => state.activeRoomVisualDescriptions.includes(uuid)
  ))
  return {
    playerPosition,
    playerOrientation,
    playerIndoorLocation,
    playerVisionRange,
    recentMessageHistory: state.messageHistory.slice(-12),
    playerVisibleLocations,
    playerBuildingRecords,
    activeFieldVisualDescriptions,
    activeExteriorVisualDescriptions,
    activeRoomVisualDescriptions,
  }
}

/**
 * 玩家可见、已知的信息，但不包括历史消息信息（历史消息只在 streamRegularBookMessage 用到，故由其自行提取并处理）和活跃的建筑信息（用在了玩家所处房间提示词生成函数内部）
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
    .map((record) => [`建筑ID：${record.buildingId}`, record.content].join('\n'))
    .join('\n');
  const visibleLocationPrompt = state.playerIndoorLocation
    ? state.playerVisibleLocations.map(location => formatVisibleLocationPrompt(location)).join('\n')
    : null;

  const indoorLocationPrompt = formatIndoorLocationPrompt(state)

  const roomVisualDescriptionPrompt = Object.values(state.activeRoomVisualDescriptions)
    .map((record) => [`建筑ID：${record.buildingId}`, `房间：level ${record.level} - ${record.roomId}`, record.content].join('\n'))
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
    '玩家所处房间细节记录：',
    roomVisualDescriptionPrompt || '（暂无）',
  ];
  return sections.join('\n');
}

//#region 辅助函数

/**
 * 描述带有方位信息的 Field Visual Description
 * @param state
 * @param record
 * @returns
 */
export function formatFieldVisualDescriptionPrompt(state: PlayerState | WorldState, record: FieldVisualDescriptionRecord): string {
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

type GeneralRoomContent = CardboardItemRecord | CardboardFurnitureRecord | ItemRecord | FurnitureRecord;

/**
 * 专门描述玩家所在的房间，以及顺带的此房间所在的楼层、区域、建筑信息
 * @param state
 * @returns
 */
export function formatIndoorLocationPrompt(state: PlayerState | WorldState): string | null {
  const location = state.playerIndoorLocation;
  if (!location) {
    return null;
  }
  const record = state.playerBuildingRecords[location.buildingId];

  const room = findRoomInBuilding(record, location);
  const contentEntries = room?.content ? Object.values(room.content) : [];
  const roomContentPrompt = contentEntries.length > 0
    ? `房间内可互动物体：\n${contentEntries.map(formatRoomContentLine).join("\n")}\n（其他物体只是不可互动，并非不存在）`
    : "房间内可互动物体：（所有物体均属于场景一部分，不可互动）";

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
    roomContentPrompt,
  ].join('\n')
}

/**
 * 返回
 * @param content 
 * @returns 
 */
function formatRoomContentPrompt(content: GeneralRoomContent[], ): string {
  return ''
}

function formatRoomContentLine(item: GeneralRoomContent): string {
  let partNamesStr = "";

  if ("parts" in item) {
    const parts = item.parts as Record<string, string | PartRecord>;
    const partValues = Object.values(parts);
    if (partValues.length > 0) {
      const names = partValues.map((pv) => {
        if (typeof pv === "string") {
          return pv.split(" - ")[0] ?? pv;
        }
        const content = pv.content;
        if (typeof content === "string") {
          return content;
        }
        return content?.name ?? "?";
      });
      partNamesStr = ` 零件(${names.length})：${names.join("、")}`;
    }
  }

  const kind = partNamesStr ? "家具" : "物品";
  return `* ${kind}：${item.name} — ${item.description}${partNamesStr}`;
}
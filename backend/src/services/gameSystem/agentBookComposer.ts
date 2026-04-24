import { distanceBetweenCoordinates } from "../geometry.js";
import { SceneObject } from "../scene/sceneObject.js";
import { BuildingRecord } from "./buildingRecord.js";
import { EmitGameEvent } from "./gameChat.js";
import { ExteriorVisualDescriptionRecord, FieldVisualDescriptionRecord, GameMessage, GameState, PlayerIndoorLocation, PlayerVisibleLocation, Position, SectorVisualDescriptionRecord } from "./gameSessionStore.js";

/**
 * 每次在 Book Composer 使用之前通过 Game State 生成，随即转为 Player State Prompt
 */
interface PlayerState {
  playerPosition: Position;
  playerOrientation: number;
  playerIndoorLocation: PlayerIndoorLocation | null;
  recentMessageHistory: GameMessage[];
  // 下列内容经过筛选，只包含玩家可见部分
  activeFieldVisualDescriptions: Record<string, FieldVisualDescriptionRecord>;
  activeExteriorVisualDescriptions: Record<string, ExteriorVisualDescriptionRecord>;
  activeBuildingRecords: Record<string, BuildingRecord>;
  activeVisibleLocations: PlayerVisibleLocation[];
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
  console.log(`[${new Date().toISOString()}] initialBookMessage() 触发`);

  const isIndoorOpening = Boolean(state.playerIndoorLocation);
  const sceneObject = isIndoorOpening
    ? undefined
    : await buildSceneFromRequest(
        { lat: state.playerPosition.lat, lon: state.playerPosition.lon, radius: INITIAL_SCENE_RADIUS_METERS },
        state.playerOrientation,
      );
  const worldStatePrompt = await toWorldStatePrompt(state, sceneObject, false);
  const systemPrompt = isIndoorOpening
    ? INDOOR_INITIAL_BOOK_MESSAGE_SYSTEM
    : OUTDOOR_INITIAL_BOOK_MESSAGE_SYSTEM;
  await writeGameDebugRequest({
    mode: 'user-message',
    functionName: 'streamInitialBookMessage',
    systemPrompt,
    userMessage: worldStatePrompt,
  });

  let reply = '';
  let reasoning = '';

  try {
    for await (const event of streamReplySingleMessage(
      systemPrompt,
      worldStatePrompt,
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
 * 流式输送常规回合 Book Message。
 * 过程中会用到传统的 sys, user, assist, tool, assist... 这样的 messages 结构。
 *
 * 和开场消息不同，这里会把最近一段 messageHistory 与 worldStatePrompt 一起发给模型，
 * 因此它代表的是“承接上下文的正式回合输出”。
 * @param state
 * @param emit
 * @returns
 */
export async function streamRegularBookMessage(
  state: GameState,
  emit: EmitGameEvent,
): Promise<string> {
  console.log(`[${new Date().toISOString()}] generateBookMessage() 触发`);

  const { lat, lon } = state.playerPosition;
  const sceneObject = await buildSceneFromRequest({ lat, lon, radius: WORLD_STATE_RADIUS_METERS}, state.playerOrientation);
  const worldStatePrompt = await toWorldStatePrompt(state, sceneObject);
  // 组装消息历史
  const messageHistory = state.messageHistory.slice(Math.max(0, state.messageHistory.length - 12));
  await writeGameDebugRequest({
    mode: 'full-messages',
    functionName: 'streamRegularBookMessage',
    systemPrompt: REGULAR_BOOK_MESSAGE_SYSTEM,
    gameMessages: messageHistory,
    worldStatePrompt,
  });

  let reply = '';
  let reasoning = '';

  try {
    for await (const event of streamReplyFullMessages(
      REGULAR_BOOK_MESSAGE_SYSTEM,
      messageHistory,
      worldStatePrompt,
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

function pickPlayerState(state: GameState): PlayerState {
  const {playerPosition, playerOrientation, playerIndoorLocation, activeVisibleLocations} = state
  const activeFieldVisualDescriptions = Object.fromEntries(Object.entries(state.fieldVisualDescriptions).filter(
    ([uuid, _]) => state.activeFieldVisualDescriptions.includes(uuid)
  ))
  const activeExteriorVisualDescriptions = Object.fromEntries(Object.entries(state.exteriorVisualDescriptions).filter(
    ([featureId, _]) => state.activeExteriorVisualDescriptions.includes(featureId)
  ))
  // TODO 也许需要动用数据库，判断建筑的最近点而非建筑的中心
  const activeBuildingRecords = Object.fromEntries(Object.entries(state.buildingRecords).filter(
    ([featureId, record]) => {
      const {lon: recordLon, lat: recordLat} = record.centerPosition
      const {lon: playerLon, lat: playerLat} = state.playerPosition
      return distanceBetweenCoordinates([recordLon, recordLat], [playerLon, playerLat]) < PLAYER_STATE_BUILDING_RECORD_RANGE
      // return featureId === state.playerIndoorLocation?.buildingId
    }
  ))
  const activeSectorVisualDescriptions = Object.fromEntries(Object.entries(state.sectorVisualDescriptions).filter(
    ([uuid, _]) => state.activeSectorVisualDescriptions.includes(uuid)
  ))
  return {
    playerPosition,
    playerOrientation,
    playerIndoorLocation,
    recentMessageHistory: state.messageHistory.slice(-12),
    activeFieldVisualDescriptions,
    activeExteriorVisualDescriptions,
    activeBuildingRecords,
    activeVisibleLocations,
    activeSectorVisualDescriptions,
  }
}

function toPlayerStatePrompt(state: PlayerState, scene?: SceneObject): string {
  return ''
}
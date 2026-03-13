import { randomUUID } from 'node:crypto';
import {
  buildDescriptionIndex,
  findNearbyLargeDescriptionCandidates,
  findNearbySmallDescriptionCandidates,
} from './gameDescriptionIndex.js';
import type {
  GamePosition,
  LargeDescriptionRecord,
  LoadedGameSession,
  SmallDescriptionRecord,
} from '../types/game.js';

// repository 这一层只负责“描述如何存取”，
// 不负责决定何时生成，也不负责 LLM 提示词拼装。
export async function findActiveLargeDescription(
  session: LoadedGameSession,
  position: GamePosition,
  sceneSignature: string,
): Promise<LargeDescriptionRecord | null> {
  // 大描述的复用条件：
  // 1. scene signature 相同
  // 2. 当前点仍落在描述的有效半径内
  const candidates = findNearbyLargeDescriptionCandidates(session.descriptionIndex, position, 1500);
  const match = candidates.find(({ record, distanceMeters }) =>
    record.sourceSceneSignature === sceneSignature && distanceMeters <= record.effectiveRadiusM);

  return match ? match.record : null;
}

export async function findReusableSmallDescription(
  session: LoadedGameSession,
  position: GamePosition,
  sceneSignature: string,
): Promise<SmallDescriptionRecord | null> {
  // 小描述也走同样的“同 scene + 在有效范围内”复用规则。
  const candidates = findNearbySmallDescriptionCandidates(session.descriptionIndex, position, 500);
  const match = candidates.find(({ record, distanceMeters }) =>
    record.sourceSceneSignature === sceneSignature && distanceMeters <= record.effectiveRadiusM);

  return match ? match.record : null;
}

export async function findNearbySmallDescriptions(
  session: LoadedGameSession,
  position: GamePosition,
  radius = 200,
): Promise<SmallDescriptionRecord[]> {
  // 这里取的是“当前位置 200m 内已有的小描述”，
  // 一方面给首页 debug 面板展示，另一方面给新小描述生成时提供远距参考。
  return findNearbySmallDescriptionCandidates(session.descriptionIndex, position, radius)
    .map(({ record, distanceMeters }) => ({
      ...record,
      distanceMeters,
    }));
}

export async function insertLargeDescription(
  session: LoadedGameSession,
  input: {
    position: GamePosition;
    sourceSceneSignature: string;
    descriptionText: string;
    sourceRadiusM?: number;
    effectiveRadiusM?: number;
  },
): Promise<LargeDescriptionRecord> {
  const now = new Date().toISOString();
  const record: LargeDescriptionRecord = {
    id: randomUUID(),
    center: {
      lat: input.position.lat,
      lon: input.position.lon,
    },
    sourceRadiusM: input.sourceRadiusM || 1000,
    effectiveRadiusM: input.effectiveRadiusM || 300,
    sourceSceneSignature: input.sourceSceneSignature,
    descriptionText: input.descriptionText,
    createdAt: now,
    updatedAt: now,
  };

  session.save.largeDescriptions.push(record);
  session.descriptionIndex = buildDescriptionIndex(session.save);

  return record;
}

export async function insertSmallDescription(
  session: LoadedGameSession,
  input: {
    position: GamePosition;
    sourceSceneSignature: string;
    descriptionText: string;
    farVisibleNotes: string | null;
    sourceRadiusM?: number;
    effectiveRadiusM?: number;
  },
): Promise<SmallDescriptionRecord> {
  const now = new Date().toISOString();
  const record: SmallDescriptionRecord = {
    id: randomUUID(),
    center: {
      lat: input.position.lat,
      lon: input.position.lon,
    },
    sourceRadiusM: input.sourceRadiusM || 200,
    effectiveRadiusM: input.effectiveRadiusM || 100,
    sourceSceneSignature: input.sourceSceneSignature,
    descriptionText: input.descriptionText,
    farVisibleNotes: input.farVisibleNotes,
    createdAt: now,
    updatedAt: now,
  };

  session.save.smallDescriptions.push(record);
  session.descriptionIndex = buildDescriptionIndex(session.save);

  return record;
}

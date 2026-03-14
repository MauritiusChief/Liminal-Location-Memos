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
): Promise<LargeDescriptionRecord | null> {
  // 大描述复用只看空间命中：
  // 当前点落在已有描述的有效半径内，就复用最近的一条。
  const candidates = findNearbyLargeDescriptionCandidates(session.descriptionIndex, position, 1500);
  const nearest = candidates[0] || null;
  const match = candidates.find(({ record, distanceMeters }) => distanceMeters <= record.effectiveRadiusM);

  console.log('[DEBUG] findActiveLargeDescription()', {
    candidateCount: candidates.length,
    nearestDistanceMeters: nearest ? Math.round(nearest.distanceMeters) : null,
    nearestEffectiveRadiusM: nearest ? nearest.record.effectiveRadiusM : null,
    reused: match !== undefined,
  });

  return match ? match.record : null;
}

export async function findReusableSmallDescription(
  session: LoadedGameSession,
  position: GamePosition,
): Promise<SmallDescriptionRecord | null> {
  // 小描述也只看空间命中，优先复用最近且仍在有效半径内的记录。
  const candidates = findNearbySmallDescriptionCandidates(session.descriptionIndex, position, 500);
  const nearest = candidates[0] || null;
  const match = candidates.find(({ record, distanceMeters }) => distanceMeters <= record.effectiveRadiusM);

  console.log('[DEBUG] findReusableSmallDescription()', {
    candidateCount: candidates.length,
    nearestDistanceMeters: nearest ? Math.round(nearest.distanceMeters) : null,
    nearestEffectiveRadiusM: nearest ? nearest.record.effectiveRadiusM : null,
    reused: match !== undefined,
  });

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
    descriptionText: input.descriptionText,
    farVisibleNotes: input.farVisibleNotes,
    createdAt: now,
    updatedAt: now,
  };

  session.save.smallDescriptions.push(record);
  session.descriptionIndex = buildDescriptionIndex(session.save);

  return record;
}

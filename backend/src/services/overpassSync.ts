import { overpassJson } from 'overpass-ts';
import {
  buildJsonSkelOverpassQuery,
  convertOverpassToNormalizedFeatures,
  type NormalizedFeature,
  type NormalizedOverpassRequest,
} from './overpassNormalization.js';
import { syncNormalizedFeaturesToDb } from './osmRepository.js';

export interface OverpassSyncResult {
  query: string;
  features: NormalizedFeature[];
  counts: Awaited<ReturnType<typeof syncNormalizedFeaturesToDb>>;
}

/**
 * 从 overpass api 获取数据并落入数据库，不作任何过滤
 * @param request 经纬度和范围这三个参数
 * @returns debug 用的三个参数
 */
export async function syncOverpassCoverage(
  request: NormalizedOverpassRequest,
): Promise<OverpassSyncResult> {
  const query = buildJsonSkelOverpassQuery(request);
  const raw = (await overpassJson(query, {
    endpoint: 'https://overpass-api.de/api/interpreter',
  })) as Parameters<typeof convertOverpassToNormalizedFeatures>[0];
  const features = convertOverpassToNormalizedFeatures(raw);
  // features: 归整化的地物，去向有两处
  // 1. 落入数据库
  // 2. 作为 debug 帮助信息返回
  const counts = await syncNormalizedFeaturesToDb(features, request);

  return {
    query,
    features,
    counts,
  };
}

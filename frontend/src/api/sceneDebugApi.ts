import { postJson } from './http';
import type {
  RawOverpassResponse,
  SceneLoadResponse,
  SceneQuery,
  SceneSyncResponse,
  SummaryPreviewRequest,
  SummaryPreviewResponse,
} from './sceneTypes';

export function runRawOverpassQuery(input: { query: string }): Promise<RawOverpassResponse> {
  return postJson<RawOverpassResponse, { query: string }>('/api/debug/overpass', input);
}

export function syncSceneFromOverpass(request: SceneQuery): Promise<SceneSyncResponse> {
  return postJson<SceneSyncResponse, SceneQuery>('/api/debug/db/sync-overpass', request);
}

export function loadSceneFromDb(request: SceneQuery): Promise<SceneLoadResponse> {
  return postJson<SceneLoadResponse, SceneQuery>('/api/debug/db/normalized-load', request);
}

export function loadSummaryPreview(request: SummaryPreviewRequest): Promise<SummaryPreviewResponse> {
  return postJson<SummaryPreviewResponse, SummaryPreviewRequest>('/api/debug/db/summary-preview', request);
}

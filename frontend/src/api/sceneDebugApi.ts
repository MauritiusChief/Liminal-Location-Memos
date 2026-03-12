import { postJson } from './http';
import type { RawOverpassResponse, SceneLoadResponse, SceneQuery, SceneSyncResponse } from './sceneTypes';

export function runRawOverpassQuery(input: { query: string }): Promise<RawOverpassResponse> {
  return postJson<RawOverpassResponse, { query: string }>('/api/overpass', input);
}

export function syncSceneFromOverpass(request: SceneQuery): Promise<SceneSyncResponse> {
  return postJson<SceneSyncResponse, SceneQuery>('/api/db/sync-overpass', request);
}

export function loadSceneFromDb(request: SceneQuery): Promise<SceneLoadResponse> {
  return postJson<SceneLoadResponse, SceneQuery>('/api/db/normalized-load', request);
}

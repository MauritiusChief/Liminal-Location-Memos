import { postJson } from './http';
import type {
  RawOverpassResponse,
  SceneLoadResponse,
  SceneQuery,
  SceneSyncResponse,
} from './sceneTypes';

export interface debugScenePromptRequest {
  lat: number;
  lon: number;
  radius: number;
  playerOrientation?: number;
}

export interface debugScenePromptResponse {
  radius: number;
  scenePrompt: string;
}

export function runRawOverpassQuery(input: { query: string }): Promise<RawOverpassResponse> {
  return postJson<RawOverpassResponse, { query: string }>('/api/debug/overpass', input);
}

export function syncSceneFromOverpass(request: SceneQuery): Promise<SceneSyncResponse> {
  return postJson<SceneSyncResponse, SceneQuery>('/api/debug/db/sync-overpass', request);
}

export function loadSceneFromDb(request: SceneQuery): Promise<SceneLoadResponse> {
  // console.log("FE: loadSceneFromDb", request);

  return postJson<SceneLoadResponse, SceneQuery>('/api/debug/db/normalized-load', request);
}

export function loadScenePromptPreview(request: debugScenePromptRequest): Promise<debugScenePromptResponse> {
  return postJson<debugScenePromptResponse, debugScenePromptRequest>('/api/debug/db/scene-prompt-preview', request);
}

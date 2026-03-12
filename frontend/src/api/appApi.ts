import { getJson } from './http';

export interface HealthResponse {
  ok: boolean;
  service: string;
  database:
    | { enabled: false; ok: false; reason: string }
    | { enabled: true; ok: true; tableNames: string | null }
    | { enabled: true; ok: false; reason: string };
}

export function fetchHealth(): Promise<HealthResponse> {
  return getJson<HealthResponse>('/api/health');
}

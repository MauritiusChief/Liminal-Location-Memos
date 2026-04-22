import { postJson } from './http';

export interface DebugBuildingSchemaRequest {
  featureId: string;
  existingSchemaCategories: string[];
  skipComplex: boolean;
}

export interface BuildingSchemaPosition {
  lat: number;
  lon: number;
}

export interface BuildingSchemaRoom {
  descrption: string;
  count: number;
  access?: 'entrance' | 'vertical' | 'internal';
}

export interface BuildingSchemaSubRoom {
  descrption: string;
  count: number;
}

export interface BuildingSchemaSuite {
  theme: string;
  subRooms: BuildingSchemaSubRoom[];
}

export interface BuildingSchemaSector {
  area: number;
  centerPosition: BuildingSchemaPosition;
  rooms: Record<string, BuildingSchemaRoom | BuildingSchemaSuite>;
}

export interface BuildingSchemaLevel {
  theme: string;
  span: number[];
  sectors: Record<string, BuildingSchemaSector>;
}

export interface BuildingSchema {
  featureId: string;
  category: string;
  centerPosition: BuildingSchemaPosition;
  theme: string;
  levels: Record<string, BuildingSchemaLevel>;
}

export interface DebugBuildingSchemaResponse {
  featureId: string;
  skipComplex: boolean;
  existingSchemaCategories: string[];
  schemas: Record<string, BuildingSchema>;
}

export function generateDebugBuildingSchema(
  input: DebugBuildingSchemaRequest,
): Promise<DebugBuildingSchemaResponse> {
  return postJson<DebugBuildingSchemaResponse, DebugBuildingSchemaRequest>('/api/debug/building-schema', input);
}

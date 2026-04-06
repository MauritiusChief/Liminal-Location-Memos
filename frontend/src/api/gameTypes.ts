export interface Position {
  lat: number;
  lon: number;
}

export type GameMessage =
  | {
      role: 'player';
      content: string;
    }
  | {
      role: 'book';
      content: string;
    };

export interface OutdoorVisualDescriptionRecord {
  id: string;
  center: Position;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface BuildingSchemaSubRoom {
  count: number;
  desc: string;
}

export interface BuildingSchemaRoom {
  count: number;
  desc: string;
  access?: 'entrance' | 'vertical' | 'internal';
}

export interface BuildingSchemaSuiteRoom {
  count: number;
  desc: string;
  subRooms: Record<string, BuildingSchemaSubRoom>;
}

export interface BuildingLevelSchemaDefinition {
  span: number | [number, number];
  rooms: Record<string, BuildingSchemaRoom | BuildingSchemaSuiteRoom>;
}

export type BuildingSchema = Record<string, BuildingLevelSchemaDefinition>;

export interface LevelVisualDescriptionRecord {
  buildingId: string;
  level: number;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface PlayerIndoorLocation {
  buildingId: string;
  level: number;
  roomKey: string;
}

export interface GameSession {
  sessionId: string;
  playerPosition: Position;
  playerIndoorLocation: PlayerIndoorLocation | null;
  messageHistory: GameMessage[];
  activeOutdoorVisualDescriptions: string[];
  outdoorVisualDescriptions: Record<string, OutdoorVisualDescriptionRecord>;
  buildingSchemas: Record<string, BuildingSchema>;
  levelVisualDescriptions: Record<string, LevelVisualDescriptionRecord>;
  llmProvider?: string;
}

export interface GameTurnRequest {
  sessionId: string;
  message: string;
}

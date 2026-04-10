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

export interface GameSessionSnapshot {
  sessionId: string;
  playerPosition: Position;
  playerOrientation: number;
  playerIndoorLocation: PlayerIndoorLocation | null;
  messageHistory: GameMessage[];
  activeOutdoorVisualDescriptions: string[];
  outdoorVisualDescriptions: Record<string, OutdoorVisualDescriptionRecord>;
  buildingSchemas: Record<string, BuildingSchema>;
  levelVisualDescriptions: Record<string, LevelVisualDescriptionRecord>;
  llmProvider?: string;
  pendingVisualDescription: boolean;
  hasQueuedPlayerMessage: boolean;
}

export interface GameTurnRequest {
  sessionId: string;
  message: string;
}

export type GameStreamEvent =
  | {
      type: 'player_message_accepted';
      text: string;
    }
  | {
      type: 'book_reply_delta';
      text: string;
    }
  | {
      type: 'book_done';
    }
  | {
      type: 'session_committed';
      session: GameSessionSnapshot;
    }
  | {
      type: 'visual_description_started';
    }
  | {
      type: 'visual_description_done';
      session: GameSessionSnapshot;
    }
  | {
      type: 'queued_next_turn';
      queuedMessage: string;
      session: GameSessionSnapshot;
    }
  | {
      type: 'queue_rejected';
      message: string;
      session: GameSessionSnapshot;
    }
  | {
      type: 'error';
      message: string;
    };

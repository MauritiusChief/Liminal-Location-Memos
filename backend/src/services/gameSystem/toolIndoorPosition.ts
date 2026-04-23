import { FeatureId } from "../featureDetail.js";
import { BuildingSchema } from "./buildingClassifier.js";
import { GameState, PlayerIndoorLocation, Position } from "./gameSessionStore.js";

export interface BuildingRecord {
  featureId: string;
  category: string;
  centerPosition: Position;
  levels: Record<number, BuildingLevel>; // key 为楼层数号
}

interface BuildingLevel {
  level: number;
  sectors: Record<string, BuildingSector>; // key 为该 Sector 的名字
}

interface BuildingSector {
  name: string;
  area: number;
  centerPosition: Position;
  rooms: Record<string, BuildingRoom | BuildingSuite>; // key 为该房间/套房的id
}

interface BuildingRoom {
  roomId: string;
  description: string;
  access?: "entrance" | "vertical" | "internal";
}

/**
 * 特意无 access
 */
interface BuildingSuite {
  roomId: string;
  subRooms: Record<string, BuildingSubRoom>;
}

/**
 * 特意无 access
 */
interface BuildingSubRoom {
  roomId: string;
  description: string;
}

/**
 * 针对某建筑，获取存储在 GameState 中的 Building Schema 或者生成所需的 Building Schema。
 * @param featureId
 * @param state
 */
export function ensureBuildingSchema(featureId: FeatureId, state: GameState): BuildingSchema {

}

import { RangedPosition } from "@/routes/apiTypes.js";
import { PolarViewFeature } from "./polarViewObject.js";

/**
 * 分为 level 1、2、3a、3b；
 * 分别为 30m-100m, 100-300m, 300m-500m, 500-1km；
 * 其中 level 1为全员可见，其他层级都要接受前一层级制作的可视范围过滤。
 * level 2 - 3a 只要有一点可见便视为可见，level 3b 只有全部可见才视为可见
 */
interface PolarViewLevel {
  level: 1 | 2 | 3;
  layer?: 'a'|'b';
  distanceRangeMeters: [number, number];
  features: PolarViewFeature[]
}

interface LeveledPolarView {
  center: {
    lat: number;
    lon: number;
  };
  maxRadiusMeters: number;
  levels: PolarViewLevel[];
}


const POLAR_LEVELS: { level: 1 | 2 | 3; minExclusive: number; maxInclusive: number }[] = [
  { level: 1, minExclusive: 30, maxInclusive: 100 },
  { level: 2, minExclusive: 100, maxInclusive: 300 },
  { level: 3, minExclusive: 300, maxInclusive: 1000 },
];
/**
 * 专门用于剔除视野遮挡的层定义，区别在于把 level 3 额外分了两层
 */
const OCCLUSION_LEVEL_LAYERS: { layer: 'a'|'b'; minExclusive: number; maxInclusive: number }[] = [
  { layer: 'a', minExclusive: 300, maxInclusive: 500 },
  { layer: 'b', minExclusive: 500, maxInclusive: 1000 },
]

//#region 主函数

/**
 * 把扁平的 Polar View Feature 列分为 level 1 - 3 三级，以及 leve 3 内部的 a、b 两层
 * @param request
 * @param polarViewFeatures
 * @returns 分级与分层好的结果
 */
function buildLeveledPolarView(request: RangedPosition, polarViewFeatures: PolarViewFeature[]): LeveledPolarView {
  const {lat, lon, radius} = request
  // 构建空的 LeveledPolarView 以盛放结果
  const leveled: LeveledPolarView = {
    center: {lat, lon}, maxRadiusMeters: radius,
    levels: []
  }
  for (const polarLevel of POLAR_LEVELS) {
    const {level, minExclusive, maxInclusive} = polarLevel
    if (level === 3) continue // 跳过 level 3
    leveled.levels.push({
      level,
      distanceRangeMeters:[minExclusive, maxInclusive],
      features: []
    })
  }
  for (const occlusionLayer of OCCLUSION_LEVEL_LAYERS) {
    const {layer, minExclusive, maxInclusive} = occlusionLayer
    leveled.levels.push({ // level 3 在这里被拆成两层 layer
      level: 3,
      layer,
      distanceRangeMeters:[minExclusive, maxInclusive],
      features: []
    })
  }

  // 将 PolarViewFeature 放入 LeveledPolarView
  for (const polarViewFeature of polarViewFeatures) {
    const distanceMeters = polarViewFeature.nearestPoint.distanceMeters
    const levelMarker = typeof distanceMeters === "number" ? classifyPolarLevel(distanceMeters) : null;
    const layerMarker = typeof distanceMeters === "number" ? classifyPolarLevelLayer(distanceMeters) : null;

    if (!levelMarker) continue

    // 找到对应的 level
    const levelToAssert = leveled.levels.find(l => levelMarker !== 3 && l.level === levelMarker)
    if (levelToAssert) {
      // 装填 level 1 与 level 2
      levelToAssert.features.push(polarViewFeature)
      continue
    }

    // 对 level 3，找到对应的 layer
    const levelLayerToAssert = leveled.levels.find(l => l.level === 3 && l.layer === layerMarker);
    if (!levelLayerToAssert) continue
    // 装填 level 3 两个 layer
    levelLayerToAssert.features.push(polarViewFeature)
  }

  return leveled
}



//#region 帮助函数

function classifyPolarLevel(distanceMeters: number): 1 | 2 | 3 | null {
  const matchedLevel = POLAR_LEVELS.find(
    (definition) => distanceMeters > definition.minExclusive && distanceMeters <= definition.maxInclusive,
  );
  return matchedLevel ? matchedLevel.level : null;
}

function classifyPolarLevelLayer(distanceMeters: number): 'a' | 'b' | null {
  const matchedLayer = OCCLUSION_LEVEL_LAYERS.find(
    (definition) => distanceMeters > definition.minExclusive && distanceMeters <= definition.maxInclusive,
  );
  return matchedLayer ? matchedLayer.layer : null;
}

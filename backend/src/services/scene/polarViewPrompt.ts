import { PolarView, PolarViewLevel } from "./polarViewLabeled.js";
import { getLargestLevel } from "./scenePrompt.js";



/**
 * representativeLimit: 每个 feature cluster 最多展示 feature 数量的上限；
 * representativeMinAngleDegrees: feature cluster 中的一个被展示的 feature 应当满足的视野角的底线；
 */
const POLAR_LEVEL_CLUSTER_PROMPT_CONFIG: Record<
  1 | 2 | 3,
  {
    representativeLimit: number;
    representativeMinAngleDegrees: number;
  }
> = {
  1: {
    representativeLimit: 4,
    representativeMinAngleDegrees: 0,
  },
  2: {
    representativeLimit: 3,
    representativeMinAngleDegrees: 3,
  },
  3: {
    representativeLimit: 2,
    representativeMinAngleDegrees: 5,
  },
};


export function buildPolarViewPrompt(polarView: PolarView): string {

  const buildingAndPoiBlocks = polarView.levels.map((level) =>
    buildPolarLevelBlock(level, ['building', 'poi']),
  );
  const lineBlocks = polarView.levels.map((level) =>
    buildPolarLevelBlock(level, ['line']),
  );
  const areaBlocks = polarView.levels.map((level) =>
    buildPolarLevelBlock(level, ['area']),
  );

  let hintOfLevel = '## 极坐标摘要：无'
  switch (getLargestLevel(polarView)) {
    case 1:
      hintOfLevel = '## 极坐标摘要'
      break
    case 2:
      hintOfLevel = '## 等级1到等级2（30米到300米极坐标摘要）'
      break
    case 3:
      hintOfLevel = '## 等级1到等级3（30米到1公里极坐标摘要）'
      break
  }

  const prompt = [hintOfLevel, '']

  return [
    '## 等级1到等级3（30米到1公里极坐标摘要）',
    '',
    '### 显著部分：建筑与POI',
    ...buildingAndPoiBlocks,
    '',
    '### 补充部分：线类',
    ...lineBlocks,
    '',
    '### 补充部分：区域',
    ...areaBlocks,
  ].join('\n');
}

function buildPolarLevelBlock(
  level: PolarViewLevel,
  includedCategories: ("building" | "area" | "poi" | "line")[],
): string {
  return ''
}
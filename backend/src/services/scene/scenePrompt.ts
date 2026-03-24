import { RangedPosition } from "@/routes/apiTypes.js";
import { buildLabeledMicroGrid, buildMicroGridPrompt, LabeledMicroGrid } from "./microGridPrompt.js";
import { PolarView } from "./polarViewLabeled.js";
import { buildPolarViewPrompt } from "./polarViewPrompt.js";

/**
 *
 * @param request
 * @param microGrid
 * @param polarView 已经被过滤过的 PolarView
 * @returns
 */
export function buildScenePrompt(
  request: RangedPosition,
  microGrid: LabeledMicroGrid,
  polarView?: PolarView,
): string {

  const sections = [
    buildPromptIntro(request, polarView ? getLargestLevel(polarView) : undefined),
    buildMicroGridPrompt(microGrid),
    polarView ? buildPolarViewPrompt(polarView) : '',
  ];

  return sections.join('\n\n');
}

export function getLargestLevel(polarView: PolarView):  1 | 2 | 3 | undefined {
  const levels = polarView.levels.map( l => l.level)
  if (levels.includes(3)) return 3
  if (levels.includes(2)) return 2
  if (levels.includes(1)) return 1
}

function buildPromptIntro(request: RangedPosition, largestLevel: 1|2|3 = 3): string {
  let intruduceOfLevel = '等级0表示30米内微网格'
  switch (largestLevel) {
    case 1:
      intruduceOfLevel = '表示法分为等级0和等级1：等级0描述30米内微网格；等级1描述30米到100米范围内的极坐标摘要。'
      break
    case 2:
      intruduceOfLevel = '表示法分为等级0到等级2：等级0描述30米内微网格；等级1到等级2描述30米到300米范围内的极坐标摘要。'
      break
    case 3:
      intruduceOfLevel = '表示法分为等级0到等级3：等级0描述30米内微网格；等级1到等级3描述30米到1公里范围内的极坐标摘要。'
      break
  }
  return [
    '请根据以下空间结构信息理解查询点周边环境。',
    `查询点：纬度 ${request.lat}，经度 ${request.lon}，原始查询半径 ${request.radius} 米。`,
    intruduceOfLevel,
  ].join('\n');
}
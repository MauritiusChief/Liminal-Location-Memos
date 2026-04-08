import { RangedPosition } from "@/routes/apiTypes.js";
import { buildMicroGridPrompt } from "./microGridPrompt.js";
import { buildPolarViewPrompt } from "./polarViewPrompt.js";
import { SceneObject } from "./sceneObject.js";

/**
 * 从 Scene Object 生成 Scene Prompt
 * @returns
 */
export function buildScenePrompt(scene: SceneObject, playerOrientation: number = 0): string {

  const {largestLevel, microGrid, polarView} = scene
  // console.log(largestLevel);

  const rangedPosision: RangedPosition = {
    lat: microGrid.center.lat, // 其实 polarView.center 也可以，下同
    lon: microGrid.center.lon,
    radius: polarView?.maxRadiusMeters || 30, // 默认最低是 30 米
  }

  const sections = [
    buildPromptIntro(rangedPosision, largestLevel),
    buildMicroGridPrompt(microGrid),
    polarView ? buildPolarViewPrompt(polarView, playerOrientation) : '',
  ];

  return sections.join('\n\n');
}

/**
 * 默认 0 级的提示词简介，覆盖 0 - 3 级情况
 * @param rangedPosision
 * @param largestLevel
 * @returns
 */
function buildPromptIntro(rangedPosision: RangedPosition, largestLevel: 0|1|2|3 = 0): string {
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
    `查询点：纬度 ${rangedPosision.lat}，经度 ${rangedPosision.lon}，原始查询半径 ${rangedPosision.radius} 米。`,
    intruduceOfLevel,
    '微网格 1 至 6 行代表玩家前方，7 至 12 行代表玩家后方；1 至 6 列代表玩家左侧，7 至 12 列代表玩家右侧。',
    '极坐标中的方向文案（若有）以玩家当前朝向为正前，使用前后左右及其组合来描述；括号中的角度为实际极坐标角度（正前方为0度，顺时针增加）',
  ].join('\n');
}

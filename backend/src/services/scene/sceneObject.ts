import { RangedPosition } from "@/routes/apiTypes.js";
import { buildLabeledMicroGrid, LabeledMicroGrid } from "./microGridPrompt.js";
import { applyClusterMarkder, buildPolarView, PolarView } from "./polarViewLabeled.js";
import { fetchSceneFeatureDetailsFromDb } from "./sceneUtilFeatureDetail.js";
import { buildMicroGrid, fetchMicroGridFromDb } from "./microGridObject.js";
import { buildPolarViewFeature, fetchScenePolarFeaturesFromDb } from "./polarViewObject.js";
import { applyOcclusion, buildLeveledPolarView } from "./polarViewOcclusion.js";
import { applyVisualFilter } from "./polarViewFilter.js";

/**
 * 专门用来生成 Scene Prompt 的类
 */
export interface SceneObject {
  largestLevel: 0 | 1 | 2 | 3;
  microGrid: LabeledMicroGrid;
  polarView?: PolarView;
}

//#region 主函数

/**
 * 从 request 直接生成完整 Scene Object
 * @param request
 * @returns
 */
export async function buildSceneFromRequest(request: RangedPosition): Promise<SceneObject> {
  const [featureDetails, microGridRecords, polarRecords] = await Promise.all([
    fetchSceneFeatureDetailsFromDb(request),
    fetchMicroGridFromDb(request),
    fetchScenePolarFeaturesFromDb(request),
  ]);

  const featureDetailIndex = new Map(featureDetails.map((feature) => [feature.featureId, feature]))
  const microGrid = buildLabeledMicroGrid(buildMicroGrid(
    request,
    microGridRecords,
    featureDetailIndex,
  ));

  const polarFeatures = buildPolarViewFeature(request, polarRecords, featureDetailIndex);
  const levelMarked = buildLeveledPolarView(request, polarFeatures)
  const occluded = applyOcclusion(levelMarked)
  const clusterMarked = applyClusterMarkder(occluded);
  const clustered = buildPolarView(clusterMarked);
  const polarView = applyVisualFilter('naked_eye', clustered);

  return {
    largestLevel: polarView ? getLargestLevel(polarView) : 0,
    microGrid,
    polarView
  }
}

export function getLargestLevel(polarView: PolarView):  1 | 2 | 3 {
  const levels = polarView.levels.map( l => l.level)
  if (levels.includes(2)) return 2
  if (levels.includes(1)) return 1
  return 3 // 只要有 polar view，那么默认就是 3
}

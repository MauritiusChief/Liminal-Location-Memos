import { RangedPosition } from "@/routes/apiTypes.js";
import { buildLabeledMicroGrid, LabeledMicroGrid } from "./microGridPrompt.js";
import { applyClusterMarkder, buildPolarView, PolarView } from "./polarViewLabeled.js";
import { fetchFeatureDetailsFromDb } from "../featureDetail.js";
import { buildMicroGrid, fetchMicroGridFromDb } from "./microGridObject.js";
import { buildPolarViewFeature, fetchScenePolarFeaturesFromDb } from "./polarViewObject.js";
import { applyOcclusion, buildLeveledPolarView } from "./polarViewOcclusion.js";
import { applyVisualFilter, DEFAULT_POLAR_VIEW_FILTER_ID, PolarViewFilterId } from "./polarViewFilter.js";
import { ensureOsmCoverageForRequest } from "../osmNormalization/osmGate.js";

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
export async function buildSceneFromRequest(
  request: RangedPosition,
  playerOrientation: number = 0,
  filterId: PolarViewFilterId = DEFAULT_POLAR_VIEW_FILTER_ID,
): Promise<SceneObject> {
  await ensureOsmCoverageForRequest(request);

  const [featureDetails, microGridRecords, polarRecords] = await Promise.all([
    fetchFeatureDetailsFromDb(request),
    fetchMicroGridFromDb(request, playerOrientation),
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
  const polarView = applyVisualFilter(filterId, clustered);

  return {
    largestLevel: polarView ? getLargestLevel(polarView) : 0,
    microGrid,
    polarView
  }
}

export function getLargestLevel(polarView: PolarView):  1 | 2 | 3 {
  const levels = polarView.levels.filter(l => l.clusters.length > 0).map( l => l.level)
  // console.log(polarView.levels);
  if (levels.includes(3)) return 3
  if (levels.includes(2)) return 2
  if (levels.includes(1)) return 1
  return 3 // 只要有 polar view，那么默认就是 3
}

import { PolarAngularSpan } from "./polarViewObject.js"



/**
 * 按名称命名的过滤参数
 * TODO：未来可能还会添加只能看某一段局限视界里的内容
 */
interface PolarViewFilter {
  id: string,
  visibleSpan?: PolarAngularSpan, // TODO 可视的范围
  seeThroughSpans?: PolarAngularSpan[], // TODO 可以无视遮挡看到所有物体的范围
  levelFilters: Record<1 | 2 | 3, PolarViewLevelFilter>
}

/**
 * 每个 level 的具体过滤参数
 */
interface PolarViewLevelFilter {
  includeDegreeThreshold: number, // 单个地物必定显著的视角
  includeCountThreshold: number, // cluster 必定显著的数量
  randomHideRate: number, // 不显著又不隐蔽的物体，则只有概率出现
  excludeDegreeThreshold: number, // 单个地物必定隐蔽的视角
  excludeCountThreshold: number, // cluster 必定隐蔽的数量
}
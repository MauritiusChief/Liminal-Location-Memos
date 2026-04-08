import type { MarkedPolarViewFeature, PolarView } from '../api/sceneTypes';

interface PolarFanChartProps {
  polarView: PolarView;
  displayRadiusMeters: 1000 | 300 | 100;
  selectedLevel: 'all' | 1 | 2 | 3;
  selectedFeatureId: string | null;
  onFeatureHover: (feature: MarkedPolarViewFeature | null) => void;
  onFeatureSelect: (feature: MarkedPolarViewFeature | null) => void;
}

const CHART_SIZE = 520;
const CHART_PADDING = 36;
const CHART_RADIUS = CHART_SIZE / 2 - CHART_PADDING;
const CENTER = CHART_SIZE / 2;
const REFERENCE_RINGS = [30, 100, 300, 1000];
const POINT_FEATURE_HIT_RADIUS_PX = 2;
const LEVEL_COLORS: Record<1 | 2 | 3, string> = {
  1: '#d1495b',
  2: '#edae49',
  3: '#3d5a80',
};

// 这里用原生 SVG 而不是图表库，是因为 polar 视图本质上就是“若干自定义扇形 + 参考圈 + 方位线”；
// 直接手写几何会更透明，也更方便和后端的 bearing / angleWidth 规则一一对照。
export function PolarFanChart({
  polarView,
  displayRadiusMeters,
  selectedLevel,
  selectedFeatureId,
  onFeatureHover,
  onFeatureSelect,
}: PolarFanChartProps) {

  // console.log('PolarFanChart:', polarView.levels[0].clusters);

  const visibleFeatures = polarView.levels.flatMap((level) =>
    selectedLevel === 'all' || level.level === selectedLevel
      ? level.clusters.flatMap((cluster) => cluster.features)
      : [],
  );

  return (
    <svg
      viewBox={`0 0 ${CHART_SIZE} ${CHART_SIZE}`}
      width={CHART_SIZE}
      height={CHART_SIZE}
      role="img"
      aria-label="Polar fan chart"
      onMouseLeave={() => onFeatureHover(null)}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onFeatureSelect(null);
        }
      }}
      style={{ border: '1px solid #999', background: '#fcfcfd', maxWidth: '100%', height: 'auto' }}
    >
      <g>
        {/* 参考圈对应不同距离层级，帮助直观看出要素离查询点有多远。 */}
        {REFERENCE_RINGS.filter((distance) => distance <= displayRadiusMeters).map((distance) => (
          <g key={distance}>
            <circle
              cx={CENTER}
              cy={CENTER}
              r={metersToRadiusPx(distance, displayRadiusMeters)}
              fill="none"
              stroke="#d2d8df"
              strokeDasharray={distance === displayRadiusMeters ? undefined : '4 4'}
            />
            <text
              x={CENTER + 6}
              y={CENTER - metersToRadiusPx(distance, displayRadiusMeters) - 4}
              fontSize="11"
              fill="#5b6570"
            >
              {distance}m
            </text>
          </g>
        ))}
        {/* 方位线把后端的 bearing（北=0，顺时针增加）映射成直观的 NSEW 方向参考。 */}
        {[
          { label: 'N', bearing: 0 },
          { label: 'E', bearing: 90 },
          { label: 'S', bearing: 180 },
          { label: 'W', bearing: 270 },
        ].map((axis) => {
          const [x, y] = polarToCartesian(displayRadiusMeters, axis.bearing, displayRadiusMeters);

          return (
            <g key={axis.label}>
              <line x1={CENTER} y1={CENTER} x2={x} y2={y} stroke="#c7ced6" strokeDasharray="3 5" />
              <text x={x} y={y} dy={axis.label === 'N' ? -6 : 14} textAnchor="middle" fontSize="12" fill="#3f4852">
                {axis.label}
              </text>
            </g>
          );
        })}
      </g>

      {visibleFeatures.map((feature) => {
        const isSelected = feature.featureId === selectedFeatureId;
        const fill = LEVEL_COLORS[feature.levelMarker];
        const linePoints =
          feature.linePath?.map((point) =>
            polarToCartesian(point.distanceMeters, point.bearingDegrees, displayRadiusMeters),
          ) || [];

        if (feature.category === 'line' && linePoints.length >= 2) {
          const polylinePoints = linePoints.map(([x, y]) => `${x},${y}`).join(' ');

          return (
            <g key={feature.featureId}>
              <polyline
                points={polylinePoints}
                fill="none"
                stroke="transparent"
                strokeWidth={isSelected ? 12 : 10}
                strokeLinecap="round"
                strokeLinejoin="round"
                onMouseEnter={() => onFeatureHover(feature)}
                onClick={(event) => {
                  event.stopPropagation();
                  onFeatureSelect(feature);
                }}
                style={{ cursor: 'pointer' }}
              />
              <polyline
                points={polylinePoints}
                fill="none"
                stroke={fill}
                strokeOpacity={isSelected ? 0.98 : 0.72}
                strokeWidth={isSelected ? 4 : 2.4}
                strokeLinecap="round"
                strokeLinejoin="round"
                pointerEvents="none"
              >
                <title>
                  {feature.baseLabel} ({Math.round(feature.centerPoint.distanceMeters)}m /{' '}
                  {Math.round(feature.centerPoint.bearingDegrees)}deg)
                </title>
              </polyline>
            </g>
          );
        }

        const path = describeAnnularSectorPath(
          feature.nearestPoint.distanceMeters,
          feature.farthestPoint.distanceMeters,
          feature.widestSpan.clockwiseEarlyPoint.bearingDegrees,
          feature.widestSpan.angleWidthDegrees,
          displayRadiusMeters,
        );
        const [centerX, centerY] = polarToCartesian(
          feature.centerPoint.distanceMeters,
          feature.centerPoint.bearingDegrees,
          displayRadiusMeters,
        );
        const isDegenerateSector =
          feature.widestSpan.angleWidthDegrees === 0 ||
          path === '' ||
          (feature.farthestPoint.distanceMeters === feature.nearestPoint.distanceMeters &&
            feature.widestSpan.angleWidthDegrees < 0.5);

        return (
          <g key={feature.featureId}>
            {isDegenerateSector ? (
              <circle
                cx={centerX}
                cy={centerY}
                r={POINT_FEATURE_HIT_RADIUS_PX}
                fill="transparent"
                onMouseEnter={() => onFeatureHover(feature)}
                onClick={(event) => {
                  event.stopPropagation();
                  onFeatureSelect(feature);
                }}
                style={{ cursor: 'pointer' }}
              >
                <title>
                  {feature.baseLabel} ({Math.round(feature.centerPoint.distanceMeters)}m /{' '}
                  {Math.round(feature.centerPoint.bearingDegrees)}deg)
                </title>
              </circle>
            ) : (
              <path
                d={path}
                fill={fill}
                fillOpacity={isSelected ? 0.48 : 0.24}
                stroke={fill}
                strokeOpacity={isSelected ? 0.95 : 0.58}
                strokeWidth={isSelected ? 2.5 : 1.2}
                onMouseEnter={() => onFeatureHover(feature)}
                onClick={(event) => {
                  event.stopPropagation();
                  onFeatureSelect(feature);
                }}
                style={{ cursor: 'pointer' }}
              >
                <title>
                  {feature.baseLabel} ({Math.round(feature.centerPoint.distanceMeters)}m /{' '}
                  {Math.round(feature.centerPoint.bearingDegrees)}deg)
                </title>
              </path>
            )}
            {/* line 的 centerPoint 仍用于摘要和分层，但不参与 SVG；
                这里的中心点标记仅保留给扇区类要素。 */}
            <circle
              cx={centerX}
              cy={centerY}
              r={isSelected ? 4 : 2.8}
              fill={isSelected ? '#111' : fill}
              pointerEvents="none"
            />
          </g>
        );
      })}

      <circle cx={CENTER} cy={CENTER} r={5} fill="#111" />
    </svg>
  );
}

// 半径缩放保持线性即可，因为这里的目标是 debug 关系而不是做感知学优化。
function metersToRadiusPx(distanceMeters: number, displayRadiusMeters: number): number {
  return (Math.max(0, Math.min(displayRadiusMeters, distanceMeters)) / displayRadiusMeters) * CHART_RADIUS;
}

// 后端 bearing 以“正北=0，顺时针递增”为约定；
// SVG/三角函数则默认“正东=0”，所以这里要先减 90 度，把北方旋到画布顶部。
function bearingDegreesToSvgAngleRadians(bearingDegrees: number): number {
  return ((bearingDegrees - 90) * Math.PI) / 180;
}

// polarToCartesian 把“距离 + bearing”投影到画布坐标系。
// 因为上面已经做过角度旋转，这里直接用普通 cos/sin 即可。
function polarToCartesian(
  distanceMeters: number,
  bearingDegrees: number,
  displayRadiusMeters: number,
): [number, number] {
  const radius = metersToRadiusPx(distanceMeters, displayRadiusMeters);
  const angle = bearingDegreesToSvgAngleRadians(bearingDegrees);
  return [CENTER + radius * Math.cos(angle), CENTER + radius * Math.sin(angle)];
}

// 这里显式使用“起点 bearing + 已知角宽”来画扇形，而不是再从两个边界点反推角宽。
// 原因是后端已经明确给出了 angleWidthDegrees，它表示最小包络视野角；
// 如果前端再用 end-start 去猜，很容易画成互补的大弧，出现“整圈只缺一口”的反相效果。
// 后端 widestSpan 的语义里，更适合作为顺时针起点的是 clockwiseEarlyPoint，
// 然后沿顺时针方向走 angleWidthDegrees 才会落到另一侧边界。
function describeAnnularSectorPath(
  innerDistanceMeters: number,
  outerDistanceMeters: number,
  startBearingDegrees: number,
  angleWidthDegrees: number,
  displayRadiusMeters: number,
): string {
  const clampedInnerDistance = Math.max(0, Math.min(innerDistanceMeters, outerDistanceMeters));
  const outerRadius = metersToRadiusPx(outerDistanceMeters, displayRadiusMeters);
  const innerRadius = metersToRadiusPx(clampedInnerDistance, displayRadiusMeters);
  const normalizedAngleWidth = ((angleWidthDegrees % 360) + 360) % 360;
  const endBearingDegrees = startBearingDegrees + normalizedAngleWidth;
  const startOuter = polarToCartesian(outerDistanceMeters, startBearingDegrees, displayRadiusMeters);
  const endOuter = polarToCartesian(outerDistanceMeters, endBearingDegrees, displayRadiusMeters);
  const startInner = polarToCartesian(clampedInnerDistance, startBearingDegrees, displayRadiusMeters);
  const endInner = polarToCartesian(clampedInnerDistance, endBearingDegrees, displayRadiusMeters);
  const largeArcFlag = normalizedAngleWidth > 180 ? 1 : 0;

  if (outerRadius <= 0) {
    return '';
  }

  if (innerRadius <= 0) {
    return [
      `M ${CENTER} ${CENTER}`,
      `L ${startOuter[0]} ${startOuter[1]}`,
      `A ${outerRadius} ${outerRadius} 0 ${largeArcFlag} 1 ${endOuter[0]} ${endOuter[1]}`,
      'Z',
    ].join(' ');
  }

  // outer arc 用 sweep=1，表示顺着可见扇区方向画出去；
  // inner arc 则反向（sweep=0）闭合回来，这样环形扇区不会自交，也不会画成互补大弧。
  return [
    `M ${startOuter[0]} ${startOuter[1]}`,
    `A ${outerRadius} ${outerRadius} 0 ${largeArcFlag} 1 ${endOuter[0]} ${endOuter[1]}`,
    `L ${endInner[0]} ${endInner[1]}`,
    `A ${innerRadius} ${innerRadius} 0 ${largeArcFlag} 0 ${startInner[0]} ${startInner[1]}`,
    'Z',
  ].join(' ');
}

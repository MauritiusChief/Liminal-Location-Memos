import { FormEvent, useEffect, useMemo, useState } from 'react';
import { PolarFanChart } from '../components/PolarFanChart';
import { useAppDispatch, useAppSelector } from '../app/hooks';
import type {
  LabeledMicroGridCell,
  MarkedPolarViewFeature,
  PolarFeatureCategory,
  PolarView,
  PolarViewCluster,
} from '../api/sceneTypes';
import {
  loadScene,
  selectNormalizationDebugState,
  setCoordinates,
  setRadius,
  syncScene,
} from '../features/normalizationDebug/normalizationDebugSlice';

const DEFAULT_POLAR_RENDER_LIMIT = '100';
const DEFAULT_POLAR_DISPLAY_RANGE = 1000;
const DEFAULT_VISIBLE_POLAR_CATEGORIES: Record<PolarFeatureCategory, boolean> = {
  building: true,
  poi: true,
  line: true,
  area: true,
};
type PolarDisplayRange = 1000 | 300 | 100;

export function NormalizationDebugPage() {
  const dispatch = useAppDispatch();
  const { form, syncRequest, dbLoadRequest } = useAppSelector(selectNormalizationDebugState);
  const [selectedGridCell, setSelectedGridCell] = useState<LabeledMicroGridCell | null>(null);
  const [selectedPolarFeature, setSelectedPolarFeature] = useState<MarkedPolarViewFeature | null>(null);
  const [hoveredPolarFeature, setHoveredPolarFeature] = useState<MarkedPolarViewFeature | null>(null);
  const [selectedPolarLevel, setSelectedPolarLevel] = useState<'all' | 1 | 2 | 3>('all');
  const [selectedPolarDisplayRange, setSelectedPolarDisplayRange] = useState<PolarDisplayRange>(DEFAULT_POLAR_DISPLAY_RANGE);
  const [visiblePolarCategories, setVisiblePolarCategories] = useState(DEFAULT_VISIBLE_POLAR_CATEGORIES);
  const [renderPolarSvgRequested, setRenderPolarSvgRequested] = useState(false);
  const [polarSvgRenderLimit, setPolarSvgRenderLimit] = useState(DEFAULT_POLAR_RENDER_LIMIT);
  const normalizedResult = dbLoadRequest.result;
  const syncResult = syncRequest.result;

  useEffect(() => {
    setSelectedGridCell(normalizedResult?.microGrid?.cells[0]?.[0] || null);
  }, [normalizedResult]);

  useEffect(() => {
    setSelectedPolarFeature(null);
    setHoveredPolarFeature(null);
    setSelectedPolarLevel('all');
    setSelectedPolarDisplayRange(DEFAULT_POLAR_DISPLAY_RANGE);
    setVisiblePolarCategories(DEFAULT_VISIBLE_POLAR_CATEGORIES);
    setRenderPolarSvgRequested(false);
  }, [normalizedResult]);

  const polarRenderLimit = useMemo(() => {
    const parsed = Number(polarSvgRenderLimit);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }, [polarSvgRenderLimit]);

  const chartPolarView = useMemo(() => {
    if (!normalizedResult?.polarView || !polarRenderLimit) {
      return null;
    }

    return filterPolarViewForChart(
      normalizedResult.polarView,
      selectedPolarLevel,
      polarRenderLimit,
      visiblePolarCategories,
      selectedPolarDisplayRange,
    );
  }, [normalizedResult, polarRenderLimit, selectedPolarLevel, selectedPolarDisplayRange, visiblePolarCategories]);

  const totalVisiblePolarFeatures = useMemo(() => {
    if (!normalizedResult?.polarView) {
      return 0;
    }

    return getVisiblePolarFeatureCount(normalizedResult.polarView, selectedPolarLevel, visiblePolarCategories, selectedPolarDisplayRange);
  }, [normalizedResult, selectedPolarLevel, selectedPolarDisplayRange, visiblePolarCategories]);

  const renderedPolarFeatures = useMemo(() => {
    if (!chartPolarView) {
      return 0;
    }

    return getVisiblePolarFeatureCount(chartPolarView, 'all', DEFAULT_VISIBLE_POLAR_CATEGORIES, selectedPolarDisplayRange);
  }, [chartPolarView]);

  useEffect(() => {
    console.log('chartPolarView:', chartPolarView);
    if (!chartPolarView) {
      setSelectedPolarFeature(null);
      setHoveredPolarFeature(null);
      return;
    }

    console.log('chartPolarView:', chartPolarView.levels[0].clusters);

    const visibleFeatureIds = new Set(
      chartPolarView.levels.flatMap((level) => level.clusters.flatMap((cluster) => cluster.features.map((feature) => feature.featureId))),
    );

    setSelectedPolarFeature((current) => (current && visibleFeatureIds.has(current.featureId) ? current : null));
    setHoveredPolarFeature((current) => (current && visibleFeatureIds.has(current.featureId) ? current : null));
  }, [chartPolarView]);

  const featureSummaryText = normalizedResult ? JSON.stringify(normalizedResult.featureSummary, null, 2) : '';
  const handleSyncSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await dispatch(syncScene(form));
  };

  const handleLoadFromDb = async () => {
    await dispatch(loadScene(form));
  };

  const handleCopyText = async (text: string) => {
    if (!text) {
      return;
    }

    await navigator.clipboard.writeText(text);
  };

  const handleTogglePolarCategory = (category: PolarFeatureCategory, checked: boolean) => {
    setVisiblePolarCategories((current) => ({
      ...current,
      [category]: checked,
    }));
  };

  return (
    <section>
      <h2>Normalization Debug</h2>
      <form onSubmit={handleSyncSubmit}>
        <label htmlFor="coordinates">Coordinates</label>
        <br />
        <input
          id="coordinates"
          value={form.coordinates}
          onChange={(event) => dispatch(setCoordinates(event.target.value))}
          placeholder="xx.xxxx, yy.yyyy"
        />
        <br />
        <label htmlFor="radius">Radius (meters)</label>
        <br />
        <input
          id="radius"
          value={form.radius}
          onChange={(event) => dispatch(setRadius(event.target.value))}
        />
        <br />
        <br />
        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
          <button type="submit" disabled={syncRequest.status === 'loading'}>
            {syncRequest.status === 'loading' ? 'Syncing...' : 'Sync Overpass -> DB'}
          </button>
          <button type="button" onClick={() => void handleLoadFromDb()} disabled={dbLoadRequest.status === 'loading'}>
            {dbLoadRequest.status === 'loading' ? 'Loading...' : 'Load From DB'}
          </button>
        </div>
      </form>

      <h3>Sync Result</h3>
      <p>
        Feature count: {syncResult?.featureCount ?? 'n/a'} | buildings: {syncResult?.counts.buildings ?? 'n/a'} | pois:{' '}
        {syncResult?.counts.pois ?? 'n/a'} | lines: {syncResult?.counts.lines ?? 'n/a'} | areas:{' '}
        {syncResult?.counts.areas ?? 'n/a'} | coverage recorded: {syncResult ? String(syncResult.coverageRecorded) : 'n/a'}
      </p>
      <pre style={{ border: '1px solid', maxHeight: '300px', overflowY: 'auto' }}>
        {syncResult?.query || 'No sync result yet.'}
      </pre>

      <h3>Diagnostics</h3>
      <pre>{normalizedResult ? JSON.stringify(normalizedResult.diagnostics, null, 2) : 'No normalized result yet.'}</pre>

      <h3>Generated Overpass QL</h3>
      <pre>{syncResult?.query || 'No query generated yet.'}</pre>

      <h3>Feature Summary</h3>
      <button type="button" onClick={() => void handleCopyText(featureSummaryText)} disabled={!featureSummaryText}>
        Copy Feature Summary
      </button>
      {/* <pre style={{ border: '1px solid', maxHeight: '600px', overflowY: 'auto' }}>
        {featureSummaryText || 'No feature summary yet.'}
      </pre> */}

      <h3>Micro Grid Debug</h3>
      {normalizedResult?.microGrid ? (
        <>
          <p>
            {normalizedResult.microGrid.rows}x{normalizedResult.microGrid.cols} cells, {normalizedResult.microGrid.cellSizeMeters}m each,
            centered at ({normalizedResult.microGrid.center.lat}, {normalizedResult.microGrid.center.lon})
          </p>
          <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-start' }}>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', tableLayout: 'fixed' }}>
                <tbody>
                  {normalizedResult.microGrid.cells.map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      {row.map((cell) => (
                        <td
                          key={`${cell.row}-${cell.col}`}
                          title={`${cell.baseKind}: ${cell.sourceFeatureIds.join(', ') || 'none'}`}
                          onClick={() => setSelectedGridCell(cell)}
                          style={{
                            border: '1px solid #999',
                            width: '72px',
                            minWidth: '72px',
                            height: '48px',
                            padding: '4px',
                            verticalAlign: 'top',
                            cursor: 'pointer',
                            backgroundColor:
                              selectedGridCell?.row === cell.row && selectedGridCell?.col === cell.col ? '#eef6ff' : '#fff',
                          }}
                        >
                          <div style={{ fontSize: '12px', lineHeight: 1.2, wordBreak: 'break-word' }}>{cell.label}</div>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <pre style={{ border: '1px solid', padding: '8px', minWidth: '280px', maxWidth: '420px', whiteSpace: 'pre-wrap' }}>
              {selectedGridCell ? JSON.stringify(selectedGridCell, null, 2) : 'Click a cell to inspect it.'}
            </pre>
          </div>
        </>
      ) : (
        <p>No micro grid yet.</p>
      )}

      <h3>Polar View Debug</h3>
      {normalizedResult?.polarView ? (
        <>
          <p>
            Max radius {normalizedResult.polarView.maxRadiusMeters}m, centered at ({normalizedResult.polarView.center.lat},{' '}
            {normalizedResult.polarView.center.lon})
          </p>
          <div style={{ display: 'flex', gap: '8px', marginBottom: '12px', flexWrap: 'wrap' }}>
            {(['all', 1, 2, 3] as const).map((level) => (
              <button
                key={String(level)}
                type="button"
                onClick={() => setSelectedPolarLevel(level)}
                style={{
                  padding: '6px 10px',
                  border: '1px solid #999',
                  background: selectedPolarLevel === level ? '#eef6ff' : '#fff',
                  cursor: 'pointer',
                }}
              >
                {level === 'all' ? 'All' : `L${level}`}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: '8px', marginBottom: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
            <label htmlFor="polarDisplayRange">Display range</label>
            <select
              id="polarDisplayRange"
              value={String(selectedPolarDisplayRange)}
              onChange={(event) => setSelectedPolarDisplayRange(Number(event.target.value) as PolarDisplayRange)}
            >
              <option value="1000">1000m</option>
              <option value="300">300m</option>
              <option value="100">100m</option>
            </select>
            <label htmlFor="polarRenderLimit">SVG render limit</label>
            <input
              id="polarRenderLimit"
              type="number"
              min="1"
              step="1"
              value={polarSvgRenderLimit}
              onChange={(event) => setPolarSvgRenderLimit(event.target.value)}
              style={{ width: '100px' }}
            />
            <label htmlFor="polarBuildingsPoi" style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              <input
                id="polarBuildingsPoi"
                type="checkbox"
                checked={visiblePolarCategories.building || visiblePolarCategories.poi}
                onChange={(event) => {
                  handleTogglePolarCategory('building', event.target.checked);
                  handleTogglePolarCategory('poi', event.target.checked);
                }}
              />
              Buildings & POI
            </label>
            <label htmlFor="polarLineFeatures" style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              <input
                id="polarLineFeatures"
                type="checkbox"
                checked={visiblePolarCategories.line}
                onChange={(event) => handleTogglePolarCategory('line', event.target.checked)}
              />
              Line features
            </label>
            <label htmlFor="polarAreaFeatures" style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              <input
                id="polarAreaFeatures"
                type="checkbox"
                checked={visiblePolarCategories.area}
                onChange={(event) => handleTogglePolarCategory('area', event.target.checked)}
              />
              Area features
            </label>
            <button
              type="button"
              onClick={() => setRenderPolarSvgRequested(true)}
              disabled={!polarRenderLimit || totalVisiblePolarFeatures === 0}
            >
              Render Polar Fan Chart
            </button>
            <span>
              Visible features: {totalVisiblePolarFeatures}; rendering: {renderedPolarFeatures}; limit:{' '}
              {polarRenderLimit ?? 'invalid'}
            </span>
          </div>
          {renderPolarSvgRequested && chartPolarView ? (
            <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-start', marginBottom: '16px', flexWrap: 'wrap' }}>
              <PolarFanChart
                polarView={chartPolarView}
                displayRadiusMeters={selectedPolarDisplayRange}
                selectedLevel={selectedPolarLevel}
                selectedFeatureId={selectedPolarFeature?.featureId || null}
                onFeatureHover={setHoveredPolarFeature}
                onFeatureSelect={setSelectedPolarFeature}
              />
              <pre style={{ border: '1px solid', padding: '8px', minWidth: '300px', maxWidth: '420px', whiteSpace: 'pre-wrap', maxHeight: '500px', overflowY: 'auto' }}>
                {selectedPolarFeature || hoveredPolarFeature
                  ? JSON.stringify(selectedPolarFeature || hoveredPolarFeature, null, 2)
                  : 'Hover or click a sector to inspect it.'}
              </pre>
            </div>
          ) : (
            <p>Polar fan chart is idle. Click the render button to draw the SVG.</p>
          )}
          {/* {normalizedResult.polarView.levels.map((level) => (
            <section key={level.level}>
              <h4>
                Level {level.level} ({level.distanceRangeMeters[0]}m, {level.distanceRangeMeters[1]}m]
              </h4>
              <pre style={{ border: '1px solid', maxHeight: '320px', overflowY: 'auto' }}>
                {JSON.stringify(level.clusters, null, 2)}
              </pre>
            </section>
          ))} */}
        </>
      ) : (
        <p>No polar view yet.</p>
      )}
      {syncRequest.error ? (
        <section>
          <h3>Sync Error</h3>
          <pre>{syncRequest.error}</pre>
        </section>
      ) : null}

      {dbLoadRequest.error ? (
        <section>
          <h3>Error</h3>
          <pre>{dbLoadRequest.error}</pre>
        </section>
      ) : null}
    </section>
  );
}

function filterPolarViewForChart(
  polarView: PolarView,
  selectedLevel: 'all' | 1 | 2 | 3,
  limit: number,
  visibleCategories: Record<PolarFeatureCategory, boolean>,
  displayRangeMeters: PolarDisplayRange,
): PolarView {
  let remaining = limit;

  return {
    ...polarView,
    levels: polarView.levels.map((level) => {
      if (selectedLevel !== 'all' && level.level !== selectedLevel) {
        return {
          ...level,
          clusters: [],
        };
      }

      const nextClusters: PolarViewCluster[] = [];
      for (const cluster of level.clusters) {
        if (remaining <= 0) {
          break;
        }

        const filteredFeatures = cluster.features
          .filter((feature) => visibleCategories[feature.category])
          .map((feature) => clipPolarFeatureToDisplayRange(feature, displayRangeMeters))
          .filter((feature): feature is MarkedPolarViewFeature => feature !== null)
          .slice(0, remaining);

        remaining -= filteredFeatures.length;

        if (filteredFeatures.length > 0) {
          nextClusters.push({
            ...cluster,
            memberCount: filteredFeatures.length,
            features: filteredFeatures,
          });
        }
      }

      return {
        ...level,
        clusters: nextClusters,
      };
    }),
  };
}

function getVisiblePolarFeatureCount(
  polarView: PolarView,
  selectedLevel: 'all' | 1 | 2 | 3,
  visibleCategories: Record<PolarFeatureCategory, boolean>,
  displayRangeMeters: PolarDisplayRange,
): number {
  return polarView.levels.reduce((count, level) => {
    if (selectedLevel !== 'all' && level.level !== selectedLevel) {
      return count;
    }

    return count + level.clusters.reduce((clusterCount, cluster) => {
      const filteredFeatures = cluster.features
        .filter((feature) => visibleCategories[feature.category])
        .map((feature) => clipPolarFeatureToDisplayRange(feature, displayRangeMeters))
        .filter((feature): feature is MarkedPolarViewFeature => feature !== null);

      return clusterCount + filteredFeatures.length;
    }, 0);
  }, 0);
}

function clipPolarFeatureToDisplayRange(
  feature: MarkedPolarViewFeature,
  displayRangeMeters: PolarDisplayRange,
): MarkedPolarViewFeature | null {
  if (feature.nearestPoint.distanceMeters > displayRangeMeters) {
    return null;
  }

  if (feature.category === 'line') {
    const clippedLinePath = feature.linePath
      ?.map((point) => ({
        ...point,
        distanceMeters: Math.min(point.distanceMeters, displayRangeMeters),
      }))
      .filter((point, index, points) => {
        const previous = points[index - 1];
        return !previous || previous.distanceMeters !== point.distanceMeters || previous.bearingDegrees !== point.bearingDegrees;
      });

    if (!clippedLinePath || clippedLinePath.length < 2) {
      return null;
    }

    return {
      ...feature,
      farthestPoint: {
        ...feature.farthestPoint,
        distanceMeters: Math.min(feature.farthestPoint.distanceMeters, displayRangeMeters),
      },
      centerPoint: {
        ...feature.centerPoint,
        distanceMeters: Math.min(feature.centerPoint.distanceMeters, displayRangeMeters),
      },
      linePath: clippedLinePath,
    };
  }

  return {
    ...feature,
    farthestPoint: {
      ...feature.farthestPoint,
      distanceMeters: Math.min(feature.farthestPoint.distanceMeters, displayRangeMeters),
    },
    centerPoint: {
      ...feature.centerPoint,
      distanceMeters: Math.min(feature.centerPoint.distanceMeters, displayRangeMeters),
    },
  };
}

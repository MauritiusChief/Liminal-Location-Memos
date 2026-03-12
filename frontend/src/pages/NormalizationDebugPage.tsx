import { FormEvent, useEffect, useMemo, useState } from 'react';
import { PolarFanChart } from '../components/PolarFanChart';
import { useAppDispatch, useAppSelector } from '../app/hooks';
import type {
  NormalizedMicroGridCell,
  NormalizedPolarFeatureSummary,
  NormalizedPolarLevel,
  NormalizedPolarView,
} from '../api/chatApi';
import { submitNormalizedQuery, submitSyncOverpassToDb, updateNormalizeField } from '../features/debug/debugSlice';

const DEFAULT_POLAR_RENDER_LIMIT = '100';

export function NormalizationDebugPage() {
  const dispatch = useAppDispatch();
  const { normalizeForm, normalizeLoading, normalizedResult, normalizeError, syncLoading, syncResult, syncError } =
    useAppSelector((state) => state.debug);
  const [selectedGridCell, setSelectedGridCell] = useState<NormalizedMicroGridCell | null>(null);
  const [selectedPolarFeature, setSelectedPolarFeature] = useState<NormalizedPolarFeatureSummary | null>(null);
  const [hoveredPolarFeature, setHoveredPolarFeature] = useState<NormalizedPolarFeatureSummary | null>(null);
  const [selectedPolarLevel, setSelectedPolarLevel] = useState<'all' | 1 | 2 | 3>('all');
  const [showOnlyBuildingAndPoiInChart, setShowOnlyBuildingAndPoiInChart] = useState(false);
  const [renderPolarSvgRequested, setRenderPolarSvgRequested] = useState(false);
  const [polarSvgRenderLimit, setPolarSvgRenderLimit] = useState(DEFAULT_POLAR_RENDER_LIMIT);

  useEffect(() => {
    setSelectedGridCell(normalizedResult?.microGrid?.enabled ? normalizedResult.microGrid.cells[0]?.[0] || null : null);
  }, [normalizedResult]);

  useEffect(() => {
    setSelectedPolarFeature(null);
    setHoveredPolarFeature(null);
    setSelectedPolarLevel('all');
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
      showOnlyBuildingAndPoiInChart,
    );
  }, [normalizedResult, polarRenderLimit, selectedPolarLevel, showOnlyBuildingAndPoiInChart]);

  const totalVisiblePolarFeatures = useMemo(() => {
    if (!normalizedResult?.polarView) {
      return 0;
    }

    return getVisiblePolarFeatureCount(
      normalizedResult.polarView.levels,
      selectedPolarLevel,
      showOnlyBuildingAndPoiInChart,
    );
  }, [normalizedResult, selectedPolarLevel, showOnlyBuildingAndPoiInChart]);

  const renderedPolarFeatures = useMemo(() => {
    if (!chartPolarView) {
      return 0;
    }

    return getVisiblePolarFeatureCount(chartPolarView.levels, 'all', false);
  }, [chartPolarView]);

  const featureSummaryText = normalizedResult ? JSON.stringify(normalizedResult.featureSummary, null, 2) : '';
  const normalizedGeoJsonText = normalizedResult ? JSON.stringify(normalizedResult.geojson, null, 2) : '';
  const promptPreviewText = normalizedResult?.promptPreview?.userPrompt || '';

  const handleSyncSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await dispatch(submitSyncOverpassToDb(normalizeForm));
  };

  const handleLoadFromDb = async () => {
    await dispatch(submitNormalizedQuery(normalizeForm));
  };

  const handleCopyText = async (text: string) => {
    if (!text) {
      return;
    }

    await navigator.clipboard.writeText(text);
  };

  return (
    <section>
      <h2>Normalization Debug</h2>
      <form onSubmit={handleSyncSubmit}>
        <label htmlFor="coordinates">Coordinates</label>
        <br />
        <input
          id="coordinates"
          value={normalizeForm.coordinates}
          onChange={(event) => dispatch(updateNormalizeField({ field: 'coordinates', value: event.target.value }))}
          placeholder="34.030519, -84.063091"
        />
        <br />
        <label htmlFor="radius">Radius (meters)</label>
        <br />
        <input
          id="radius"
          value={normalizeForm.radius}
          onChange={(event) => dispatch(updateNormalizeField({ field: 'radius', value: event.target.value }))}
        />
        <br />
        <br />
        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
          <button type="submit" disabled={syncLoading}>
            {syncLoading ? 'Syncing...' : 'Sync Overpass -> DB'}
          </button>
          <button type="button" onClick={() => void handleLoadFromDb()} disabled={normalizeLoading}>
            {normalizeLoading ? 'Loading...' : 'Load From DB'}
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
      <pre style={{ border: '1px solid', maxHeight: '600px', overflowY: 'auto' }}>
        {featureSummaryText || 'No feature summary yet.'}
      </pre>

      <h3>Normalized GeoJSON</h3>
      <button type="button" onClick={() => void handleCopyText(normalizedGeoJsonText)} disabled={!normalizedGeoJsonText}>
        Copy Normalized GeoJSON
      </button>
      <pre style={{ border: '1px solid', maxHeight: '600px', overflowY: 'auto' }}>
        {normalizedGeoJsonText || 'No normalized GeoJSON yet.'}
      </pre>

      <h3>Micro Grid Debug</h3>
      {normalizedResult?.microGrid?.enabled ? (
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
      ) : normalizedResult?.microGrid?.reason === 'radius_too_small' ? (
        <p>Micro grid is skipped because radius must be greater than 50 meters.</p>
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
            <label htmlFor="polarBuildingPoiOnly" style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              <input
                id="polarBuildingPoiOnly"
                type="checkbox"
                checked={showOnlyBuildingAndPoiInChart}
                onChange={(event) => setShowOnlyBuildingAndPoiInChart(event.target.checked)}
              />
              Only buildings & POI
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
                {JSON.stringify(level.features, null, 2)}
              </pre>
            </section>
          ))} */}
        </>
      ) : (
        <p>No polar view yet.</p>
      )}

      <h3>Prompt Preview</h3>
      <button type="button" onClick={() => void handleCopyText(promptPreviewText)} disabled={!promptPreviewText}>
        Copy Prompt
      </button>
      <br />
      <br />
      {/* <textarea
        readOnly
        rows={20}
        cols={120}
        value={normalizedResult?.promptPreview?.userPrompt || 'No prompt preview yet.'}
      /> */}

      {/* <h3>Raw Response Snapshot</h3>
      <pre style={{ border: '1px solid', maxHeight: '600px', overflowY: 'auto' }}>
        {normalizedResult?.raw ? JSON.stringify(normalizedResult.raw, null, 2) : 'Raw payload not included.'}
      </pre> */}

      {syncError ? (
        <section>
          <h3>Sync Error</h3>
          <pre>{syncError}</pre>
        </section>
      ) : null}

      {normalizeError ? (
        <section>
          <h3>Error</h3>
          <pre>{normalizeError}</pre>
        </section>
      ) : null}
    </section>
  );
}

function filterPolarViewForChart(
  polarView: NormalizedPolarView,
  selectedLevel: 'all' | 1 | 2 | 3,
  limit: number,
  showOnlyBuildingAndPoi: boolean,
): NormalizedPolarView {
  let remaining = limit;

  return {
    ...polarView,
    levels: polarView.levels.map((level) => {
      if (selectedLevel !== 'all' && level.level !== selectedLevel) {
        return {
          ...level,
          features: [],
        };
      }

      const filteredFeatures = showOnlyBuildingAndPoi
        ? level.features.filter((feature) => feature.category === 'building' || feature.category === 'poi')
        : level.features;

      if (remaining <= 0) {
        return {
          ...level,
          features: [],
        };
      }

      const nextFeatures = filteredFeatures.slice(0, remaining);
      remaining -= nextFeatures.length;

      return {
        ...level,
        features: nextFeatures,
      };
    }),
  };
}

function getVisiblePolarFeatureCount(
  levels: NormalizedPolarLevel[],
  selectedLevel: 'all' | 1 | 2 | 3,
  showOnlyBuildingAndPoi: boolean,
): number {
  return levels.reduce((count, level) => {
    if (selectedLevel !== 'all' && level.level !== selectedLevel) {
      return count;
    }

    const filteredFeatures = showOnlyBuildingAndPoi
      ? level.features.filter((feature) => feature.category === 'building' || feature.category === 'poi')
      : level.features;

    return count + filteredFeatures.length;
  }, 0);
}

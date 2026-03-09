import { SubmitEvent, useEffect, useState } from 'react';
import { useAppDispatch, useAppSelector } from './app/hooks';
import { fetchHealth, type NormalizedMicroGridCell } from './api/chatApi';
import { submitNormalizedQuery, submitRawQuery, updateIncludeRaw, updateNormalizeField, updateRawQuery } from './features/chat/chatSlice';

function App() {
  const dispatch = useAppDispatch();

  // useAppSelector 从 Redux 里读取 chat slice 的当前状态。
  // 这里解构出来的每个字段，都会随着 Redux 状态变化自动触发重新渲染。
  const { normalizeForm, rawQuery, normalizeLoading, rawLoading, normalizedResult, rawResult, error } = useAppSelector(
    (state) => state.chat,
  );
  const featuresSummary = normalizedResult?.geojson.features.map((feature) => {
    return { id: feature.id, type: feature.geometry.type, properties: feature.properties };
  });
  const [selectedGridCell, setSelectedGridCell] = useState<NormalizedMicroGridCell | null>(null);

  // 这个 health 只在当前组件内部使用，所以继续放在本地 useState，而不是 Redux。
  const [health, setHealth] = useState<string>('Checking backend...');

  useEffect(() => {
    fetchHealth()
      .then((result) => setHealth(result.ok ? `${result.service} online` : 'Backend unavailable'))
      .catch(() => setHealth('Backend unavailable'));
  }, []);

  useEffect(() => {
    setSelectedGridCell(normalizedResult?.microGrid?.enabled ? normalizedResult.microGrid.cells[0]?.[0] || null : null);
  }, [normalizedResult]);

  const handleNormalizeSubmit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();

    // dispatch 一个 thunk 时，本质上是在触发一整套异步状态流转：
    // pending -> fulfilled / rejected。
    await dispatch(submitNormalizedQuery(normalizeForm));
  };

  const handleRawSubmit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    await dispatch(submitRawQuery(rawQuery));
  };

  return (
    <main>
      <h1>Overpass Area Normalization Playground</h1>
      <p>Backend status: {health}</p>

      <section>
        <h2>Normalized GeoJSON</h2>
        <form onSubmit={handleNormalizeSubmit}>
          <label htmlFor="lat">Latitude</label>
          <br />
          <input
            id="lat"
            value={normalizeForm.lat}
            onChange={(event) => dispatch(updateNormalizeField({ field: 'lat', value: event.target.value }))}
          />
          <br />
          <label htmlFor="lon">Longitude</label>
          <br />
          <input
            id="lon"
            value={normalizeForm.lon}
            onChange={(event) => dispatch(updateNormalizeField({ field: 'lon', value: event.target.value }))}
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
          <label>
            <input
              type="checkbox"
              checked={normalizeForm.includeRaw}
              onChange={(event) => dispatch(updateIncludeRaw(event.target.checked))}
            />
            Include raw Overpass JSON
          </label>
          <br />
          <br />
          <button type="submit" disabled={normalizeLoading}>
            {normalizeLoading ? 'Normalizing...' : 'Normalize'}
          </button>
        </form>

        <h3>Diagnostics</h3>
        <pre>{normalizedResult ? JSON.stringify(normalizedResult.diagnostics, null, 2) : 'No normalized result yet.'}</pre>

        <h3>Generated Overpass QL</h3>
        <pre>{normalizedResult?.query || 'No query generated yet.'}</pre>

        <h3>Feature Summary</h3>
        <pre style={{border: "1px solid", maxHeight: "600px", overflowY: "auto"}}>{normalizedResult ? JSON.stringify(featuresSummary, null, 2) : 'No feature summary yet.'}</pre>

        <h3>Normalized GeoJSON</h3>
        <pre style={{border: "1px solid", maxHeight: "600px", overflowY: "auto"}}>{normalizedResult ? JSON.stringify(normalizedResult.geojson, null, 2) : 'No normalized GeoJSON yet.'}</pre>

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

        <h3>Raw Response Snapshot</h3>
        <pre style={{border: "1px solid", maxHeight: "600px", overflowY: "auto"}}>{normalizedResult?.raw ? JSON.stringify(normalizedResult.raw, null, 2) : 'Raw payload not included.'}</pre>
      </section>

      <section>
        <h2>Raw Overpass Playground</h2>
        <form onSubmit={handleRawSubmit}>
          <label htmlFor="rawQuery">Query</label>
          <br />
          <textarea
            id="rawQuery"
            rows={8}
            cols={80}
            value={rawQuery}
            onChange={(event) => dispatch(updateRawQuery(event.target.value))}
          />
          <br />
          <button type="submit" disabled={rawLoading}>
            {rawLoading ? 'Sending...' : 'Run Raw Query'}
          </button>
        </form>

        <h3>Raw Response</h3>
        <pre>{rawResult ? JSON.stringify(rawResult.data, null, 2) : 'No raw response yet.'}</pre>
      </section>

      {error ? (
        <section>
          <h2>Error</h2>
          <pre>{error}</pre>
        </section>
      ) : null}
    </main>
  );
}

export default App;

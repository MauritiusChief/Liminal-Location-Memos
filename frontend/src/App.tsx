import { SubmitEvent, useEffect, useState } from 'react';
import { useAppDispatch, useAppSelector } from './app/hooks';
import { fetchHealth } from './api/chatApi';
import { submitNormalizedQuery, submitRawQuery, updateIncludeRaw, updateNormalizeField, updateRawQuery } from './features/chat/chatSlice';

function App() {
  const dispatch = useAppDispatch();

  // useAppSelector 从 Redux 里读取 chat slice 的当前状态。
  // 这里解构出来的每个字段，都会随着 Redux 状态变化自动触发重新渲染。
  const { normalizeForm, rawQuery, normalizeLoading, rawLoading, normalizedResult, rawResult, error } = useAppSelector(
    (state) => state.chat,
  );

  // 这个 health 只在当前组件内部使用，所以继续放在本地 useState，而不是 Redux。
  const [health, setHealth] = useState<string>('Checking backend...');

  useEffect(() => {
    fetchHealth()
      .then((result) => setHealth(result.ok ? `${result.service} online` : 'Backend unavailable'))
      .catch(() => setHealth('Backend unavailable'));
  }, []);

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

        <h3>Normalized GeoJSON</h3>
        <pre>{normalizedResult ? JSON.stringify(normalizedResult.geojson, null, 2) : 'No normalized GeoJSON yet.'}</pre>

        <h3>Raw Response Snapshot</h3>
        <pre>{normalizedResult?.raw ? JSON.stringify(normalizedResult.raw, null, 2) : 'Raw payload not included.'}</pre>
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

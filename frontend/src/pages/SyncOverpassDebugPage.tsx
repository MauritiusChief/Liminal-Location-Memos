import { FormEvent } from 'react';
import { useAppDispatch, useAppSelector } from '../app/hooks';
import {
  submitDbDebugLoad,
  submitSyncOverpassToDb,
  updateSyncOverpassDebugField,
} from '../features/syncOverpassDebug/syncOverpassDebugSlice';

export function SyncOverpassDebugPage() {
  const dispatch = useAppDispatch();
  const { form, syncLoading, syncResult, syncError, dbLoadLoading, dbNormalizedResult, dbLoadError } = useAppSelector(
    (state) => state.syncOverpassDebug,
  );

  const featureSummaryText = dbNormalizedResult ? JSON.stringify(dbNormalizedResult.featureSummary, null, 2) : '';
  const normalizedGeoJsonText = dbNormalizedResult ? JSON.stringify(dbNormalizedResult.geojson, null, 2) : '';
  const diagnosticsText = dbNormalizedResult ? JSON.stringify(dbNormalizedResult.diagnostics, null, 2) : '';
  const microGridText = dbNormalizedResult?.microGrid ? JSON.stringify(dbNormalizedResult.microGrid, null, 2) : '';
  const polarViewText = dbNormalizedResult?.polarView ? JSON.stringify(dbNormalizedResult.polarView, null, 2) : '';
  const promptPreviewText = dbNormalizedResult?.promptPreview?.userPrompt || '';

  const handleSyncSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await dispatch(submitSyncOverpassToDb(form));
  };

  const handleLoadFromDb = async () => {
    await dispatch(submitDbDebugLoad(form));
  };

  const handleCopyText = async (text: string) => {
    if (!text) {
      return;
    }

    await navigator.clipboard.writeText(text);
  };

  return (
    <section>
      <h2>Sync Overpass Debug</h2>
      <p>
        This page drives the new database path. It first syncs Overpass data into PostgreSQL/PostGIS, then loads the
        same area back from the database and rebuilds the debug outputs.
      </p>

      <form onSubmit={handleSyncSubmit}>
        <label htmlFor="syncCoordinates">Coordinates</label>
        <br />
        <input
          id="syncCoordinates"
          value={form.coordinates}
          onChange={(event) =>
            dispatch(updateSyncOverpassDebugField({ field: 'coordinates', value: event.target.value }))
          }
          placeholder="34.030519, -84.063091"
        />
        <br />
        <label htmlFor="syncRadius">Radius (meters)</label>
        <br />
        <input
          id="syncRadius"
          value={form.radius}
          onChange={(event) => dispatch(updateSyncOverpassDebugField({ field: 'radius', value: event.target.value }))}
        />
        <br />
        <br />
        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
          <button type="submit" disabled={syncLoading}>
            {syncLoading ? 'Syncing...' : 'Sync Overpass -> DB'}
          </button>
          <button type="button" onClick={() => void handleLoadFromDb()} disabled={dbLoadLoading}>
            {dbLoadLoading ? 'Loading...' : 'Load From DB'}
          </button>
        </div>
      </form>

      <h3>Sync Result</h3>
      <p>
        Feature count: {syncResult?.featureCount ?? 'n/a'} | buildings: {syncResult?.counts.buildings ?? 'n/a'} | pois:{' '}
        {syncResult?.counts.pois ?? 'n/a'} | lines: {syncResult?.counts.lines ?? 'n/a'} | areas:{' '}
        {syncResult?.counts.areas ?? 'n/a'} | coverage recorded:{' '}
        {syncResult ? String(syncResult.coverageRecorded) : 'n/a'}
      </p>
      {/* <button type="button" onClick={() => void handleCopyText(syncResult?.query || '')} disabled={!syncResult?.query}>
        Copy Overpass QL
      </button> */}
      <pre>
        {syncResult?.query || 'No sync result yet.'}
      </pre>

      <h3>DB Diagnostics</h3>
      <pre>{diagnosticsText || 'No DB load result yet.'}</pre>

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

      {/* <h3>Micro Grid</h3>
      <button type="button" onClick={() => void handleCopyText(microGridText)} disabled={!microGridText}>
        Copy Micro Grid
      </button>
      <pre style={{ border: '1px solid', maxHeight: '400px', overflowY: 'auto' }}>{microGridText || 'No micro grid yet.'}</pre>

      <h3>Polar View</h3>
      <button type="button" onClick={() => void handleCopyText(polarViewText)} disabled={!polarViewText}>
        Copy Polar View
      </button>
      <pre style={{ border: '1px solid', maxHeight: '400px', overflowY: 'auto' }}>{polarViewText || 'No polar view yet.'}</pre>

      <h3>Prompt Preview</h3>
      <button type="button" onClick={() => void handleCopyText(promptPreviewText)} disabled={!promptPreviewText}>
        Copy Prompt
      </button>
      <pre style={{ border: '1px solid', maxHeight: '400px', overflowY: 'auto', whiteSpace: 'pre-wrap' }}>
        {promptPreviewText || 'No prompt preview yet.'}
      </pre> */}

      {syncError ? (
        <section>
          <h3>Sync Error</h3>
          <pre>{syncError}</pre>
        </section>
      ) : null}

      {dbLoadError ? (
        <section>
          <h3>DB Load Error</h3>
          <pre>{dbLoadError}</pre>
        </section>
      ) : null}
    </section>
  );
}

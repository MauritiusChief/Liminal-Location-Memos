import { useState } from 'react';
import { useAppDispatch, useAppSelector } from '../app/hooks';
import {
  fetchSummaryPreview,
  selectSummaryPreviewState,
  setCoordinates,
  setFilterId,
  setOrientation,
  setRadius,
} from '../features/summaryPreview/summaryPreviewSlice';

/**
 * Summary 是 Scene Prompt 的旧称
 */

export function SummaryPreviewPage() {
  const dispatch = useAppDispatch();
  const { form, request } = useAppSelector(selectSummaryPreviewState);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied'>('idle');

  const handleRequest = async () => {
    setCopyStatus('idle');
    await dispatch(fetchSummaryPreview(form));
  };

  const handleCopy = async () => {
    if (!request.result?.scenePrompt) {
      return;
    }

    await navigator.clipboard.writeText(request.result.scenePrompt);
    setCopyStatus('copied');
  };

  return (
    <section>
      <h2>Summary Preview</h2>
      <label htmlFor="summaryPreviewCoordinates">Coordinates</label>
      <br />
      <input
        id="summaryPreviewCoordinates"
        value={form.coordinates}
        onChange={(event) => dispatch(setCoordinates(event.target.value))}
        placeholder="xx.xxxx, yy.yyyy"
      />
      <br />
      <label htmlFor="summaryPreviewRadius">Radius (meters)</label>
      <br />
      <input
        id="summaryPreviewRadius"
        value={form.radius}
        onChange={(event) => dispatch(setRadius(event.target.value))}
      />
      <br />
      <label htmlFor="summaryPreviewOrientation">Orientation (degrees, 0 = north)</label>
      <br />
      <input
        id="summaryPreviewOrientation"
        value={form.orientation}
        onChange={(event) => dispatch(setOrientation(event.target.value))}
      />
      <br />
      <label htmlFor="summaryPreviewFilter">Polar filter</label>
      <br />
      <select
        id="summaryPreviewFilter"
        value={form.filterId}
        onChange={(event) => dispatch(setFilterId(event.target.value as 'glance' | 'stare'))}
      >
        <option value="glance">glance</option>
        <option value="stare">stare</option>
      </select>
      <br />
      <br />
      <button type="button" onClick={() => void handleRequest()} disabled={request.status === 'loading'}>
        {request.status === 'loading' ? 'Loading...' : 'Generate Summary'}
      </button>

      <h3>Result</h3>
      <p>
        Current radius: {(request.result?.radius ?? form.radius) || 'n/a'}m
      </p>
      <p>
        Current filter: {form.filterId}
      </p>
      <button type="button" onClick={() => void handleCopy()} disabled={!request.result?.scenePrompt}>
        {copyStatus === 'copied' ? 'Copied' : 'Copy Summary'}
      </button>
      <pre style={{ border: '1px solid', maxHeight: '480px', overflowY: 'auto', whiteSpace: 'pre-wrap' }}>
        {request.result?.scenePrompt || 'No summary preview yet.'}
      </pre>

      {request.error ? (
        <section>
          <h3>Error</h3>
          <pre>{request.error}</pre>
        </section>
      ) : null}
    </section>
  );
}

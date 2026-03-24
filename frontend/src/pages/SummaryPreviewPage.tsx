import { useState } from 'react';
import { useAppDispatch, useAppSelector } from '../app/hooks';
import {
  fetchSummaryPreview,
  selectSummaryPreviewState,
  setCoordinates,
  setRadius,
} from '../features/summaryPreview/summaryPreviewSlice';

export function SummaryPreviewPage() {
  const dispatch = useAppDispatch();
  const { form, request } = useAppSelector(selectSummaryPreviewState);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied'>('idle');

  const handleRequest = async () => {
    setCopyStatus('idle');
    await dispatch(fetchSummaryPreview(form));
  };

  const handleCopy = async () => {
    if (!request.result?.summaryText) {
      return;
    }

    await navigator.clipboard.writeText(request.result.summaryText);
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
      <br />
      <button type="button" onClick={() => void handleRequest()} disabled={request.status === 'loading'}>
        {request.status === 'loading' ? 'Loading...' : 'Generate Summary'}
      </button>

      <h3>Result</h3>
      <p>
        Current radius: {(request.result?.radius ?? form.radius) || 'n/a'}m
      </p>
      <button type="button" onClick={() => void handleCopy()} disabled={!request.result?.summaryText}>
        {copyStatus === 'copied' ? 'Copied' : 'Copy Summary'}
      </button>
      <pre style={{ border: '1px solid', maxHeight: '480px', overflowY: 'auto', whiteSpace: 'pre-wrap' }}>
        {request.result?.summaryText || 'No summary preview yet.'}
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

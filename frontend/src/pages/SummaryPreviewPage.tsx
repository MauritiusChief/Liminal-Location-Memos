import { useState } from 'react';
import { useAppDispatch, useAppSelector } from '../app/hooks';
import type { SummaryPreviewMode } from '../api/sceneTypes';
import {
  fetchSummaryPreview,
  selectSummaryPreviewState,
  setCoordinates,
} from '../features/summaryPreview/summaryPreviewSlice';

const SUMMARY_BUTTONS: Array<{ mode: SummaryPreviewMode; label: string }> = [
  { mode: 'detailed_far_1000', label: 'Detailed 1000m' },
  { mode: 'concise_far_1000', label: 'Concise 1000m' },
  { mode: 'concise_near_200', label: 'Concise 200m' },
];

export function SummaryPreviewPage() {
  const dispatch = useAppDispatch();
  const { form, currentMode, request } = useAppSelector(selectSummaryPreviewState);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied'>('idle');

  const handleRequest = async (summaryMode: SummaryPreviewMode) => {
    setCopyStatus('idle');
    await dispatch(fetchSummaryPreview({ coordinates: form.coordinates, summaryMode }));
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
      <br />
      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
        {SUMMARY_BUTTONS.map((button) => (
          <button
            key={button.mode}
            type="button"
            onClick={() => void handleRequest(button.mode)}
            disabled={request.status === 'loading'}
          >
            {request.status === 'loading' && currentMode === button.mode ? 'Loading...' : button.label}
          </button>
        ))}
      </div>

      <h3>Result</h3>
      <p>Current mode: {request.result?.summaryMode || currentMode || 'n/a'}</p>
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

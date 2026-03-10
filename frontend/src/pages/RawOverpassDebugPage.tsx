import { FormEvent } from 'react';
import { useAppDispatch, useAppSelector } from '../app/hooks';
import { submitRawQuery, updateRawQuery } from '../features/debug/debugSlice';

export function RawOverpassDebugPage() {
  const dispatch = useAppDispatch();
  const { rawQuery, rawLoading, rawResult, rawError } = useAppSelector((state) => state.debug);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await dispatch(submitRawQuery(rawQuery));
  };

  return (
    <section>
      <h2>Raw Overpass Playground</h2>
      <form onSubmit={handleSubmit}>
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

      {rawError ? (
        <section>
          <h3>Error</h3>
          <pre>{rawError}</pre>
        </section>
      ) : null}
    </section>
  );
}

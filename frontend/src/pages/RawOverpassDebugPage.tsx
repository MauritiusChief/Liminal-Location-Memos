import { FormEvent } from 'react';
import { useAppDispatch, useAppSelector } from '../app/hooks';
import {
  selectRawOverpassDebugState,
  setQuery,
  submitRawOverpassQuery,
} from '../features/rawOverpassDebug/rawOverpassDebugSlice';

export function RawOverpassDebugPage() {
  const dispatch = useAppDispatch();
  const { query, request } = useAppSelector(selectRawOverpassDebugState);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await dispatch(submitRawOverpassQuery(query));
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
          value={query}
          onChange={(event) => dispatch(setQuery(event.target.value))}
        />
        <br />
        <button type="submit" disabled={request.status === 'loading'}>
          {request.status === 'loading' ? 'Sending...' : 'Run Raw Query'}
        </button>
      </form>

      <h3>Raw Response</h3>
      <pre>{request.result ? JSON.stringify(request.result.data, null, 2) : 'No raw response yet.'}</pre>

      {request.error ? (
        <section>
          <h3>Error</h3>
          <pre>{request.error}</pre>
        </section>
      ) : null}
    </section>
  );
}

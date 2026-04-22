import { FormEvent } from 'react';
import { useAppDispatch, useAppSelector } from '../app/hooks';
import {
  selectBuildingSchemaDebugState,
  setExistingSchemaCategoriesJson,
  setFeatureId,
  setSkipComplex,
  submitBuildingSchemaDebugRequest,
} from '../features/buildingSchemaDebug/buildingSchemaDebugSlice';

export function BuildingSchemaDebugPage() {
  const dispatch = useAppDispatch();
  const { form, request } = useAppSelector(selectBuildingSchemaDebugState);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await dispatch(submitBuildingSchemaDebugRequest(form));
  };

  return (
    <section>
      <h2>Building Schema Debug</h2>
      <form onSubmit={handleSubmit}>
        <label htmlFor="buildingSchemaDebugFeatureId">Feature ID</label>
        <br />
        <input
          id="buildingSchemaDebugFeatureId"
          value={form.featureId}
          onChange={(event) => dispatch(setFeatureId(event.target.value))}
          placeholder="way/123"
          style={{ minWidth: '320px' }}
        />
        <br />
        <label htmlFor="buildingSchemaDebugExistingCategories">Mock Existing Schema Categories</label>
        <br />
        <textarea
          id="buildingSchemaDebugExistingCategories"
          rows={6}
          cols={60}
          value={form.existingSchemaCategoriesJson}
          onChange={(event) => dispatch(setExistingSchemaCategoriesJson(event.target.value))}
        />
        <br />
        <label>
          <input
            type="checkbox"
            checked={form.skipComplex}
            onChange={(event) => dispatch(setSkipComplex(event.target.checked))}
          />
          skipComplex
        </label>
        <br />
        <button type="submit" disabled={request.status === 'loading'}>
          {request.status === 'loading' ? 'Generating...' : 'Generate Building Schema'}
        </button>
      </form>

      <h3>Generated Schemas</h3>
      <pre style={{ border: '1px solid', maxHeight: '640px', overflowY: 'auto', whiteSpace: 'pre-wrap' }}>
        {request.result ? JSON.stringify(request.result.schemas, null, 2) : 'No generated schemas yet.'}
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

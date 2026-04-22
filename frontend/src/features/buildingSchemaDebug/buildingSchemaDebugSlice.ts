import { createAsyncThunk, createSlice, PayloadAction } from '@reduxjs/toolkit';
import {
  generateDebugBuildingSchema,
  type DebugBuildingSchemaResponse,
} from '../../api/buildingSchemaDebugApi';
import type { RootState } from '../../app/store';

type RequestStatus = 'idle' | 'loading' | 'succeeded' | 'failed';

interface BuildingSchemaDebugFormState {
  featureId: string;
  existingSchemaCategoriesJson: string;
  skipComplex: boolean;
}

interface BuildingSchemaDebugRequestState {
  status: RequestStatus;
  error: string | null;
  result: DebugBuildingSchemaResponse | null;
}

interface BuildingSchemaDebugState {
  form: BuildingSchemaDebugFormState;
  request: BuildingSchemaDebugRequestState;
}

const initialState: BuildingSchemaDebugState = {
  form: {
    featureId: '',
    existingSchemaCategoriesJson: '[]',
    skipComplex: true,
  },
  request: {
    status: 'idle',
    error: null,
    result: null,
  },
};

function parseExistingSchemaCategories(input: string): string[] | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return { error: 'Existing schema categories must be a valid JSON array.' };
  }

  if (!Array.isArray(parsed)) {
    return { error: 'Existing schema categories must be a JSON array.' };
  }

  const categories: string[] = [];
  for (const item of parsed) {
    if (typeof item !== 'string') {
      return { error: 'Existing schema categories must contain only strings.' };
    }

    const trimmed = item.trim();
    if (trimmed) {
      categories.push(trimmed);
    }
  }

  return categories;
}

export const submitBuildingSchemaDebugRequest = createAsyncThunk<
  DebugBuildingSchemaResponse,
  BuildingSchemaDebugFormState,
  { rejectValue: string }
>(
  'buildingSchemaDebug/submitBuildingSchemaDebugRequest',
  async ({ featureId, existingSchemaCategoriesJson, skipComplex }, { rejectWithValue }) => {
    const trimmedFeatureId = featureId.trim();
    if (!trimmedFeatureId) {
      return rejectWithValue('featureId is required.');
    }

    const existingSchemaCategories = parseExistingSchemaCategories(existingSchemaCategoriesJson);
    if ('error' in existingSchemaCategories) {
      return rejectWithValue(existingSchemaCategories.error);
    }

    try {
      return await generateDebugBuildingSchema({
        featureId: trimmedFeatureId,
        existingSchemaCategories,
        skipComplex,
      });
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : 'Unknown error.');
    }
  },
);

const buildingSchemaDebugSlice = createSlice({
  name: 'buildingSchemaDebug',
  initialState,
  reducers: {
    setFeatureId(state, action: PayloadAction<string>) {
      state.form.featureId = action.payload;
    },
    setExistingSchemaCategoriesJson(state, action: PayloadAction<string>) {
      state.form.existingSchemaCategoriesJson = action.payload;
    },
    setSkipComplex(state, action: PayloadAction<boolean>) {
      state.form.skipComplex = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(submitBuildingSchemaDebugRequest.pending, (state) => {
        state.request.status = 'loading';
        state.request.error = null;
      })
      .addCase(submitBuildingSchemaDebugRequest.fulfilled, (state, action) => {
        state.request.status = 'succeeded';
        state.request.result = action.payload;
      })
      .addCase(submitBuildingSchemaDebugRequest.rejected, (state, action) => {
        state.request.status = 'failed';
        state.request.error = action.payload || 'Unknown error.';
      });
  },
});

export const selectBuildingSchemaDebugState = (state: RootState) => state.buildingSchemaDebug;

export const {
  setExistingSchemaCategoriesJson,
  setFeatureId,
  setSkipComplex,
} = buildingSchemaDebugSlice.actions;
export default buildingSchemaDebugSlice.reducer;

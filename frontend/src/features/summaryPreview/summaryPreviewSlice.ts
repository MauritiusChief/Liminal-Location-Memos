import { createAsyncThunk, createSlice, PayloadAction } from '@reduxjs/toolkit';
import { loadSummaryPreview } from '../../api/sceneDebugApi';
import type { SummaryPreviewMode, SummaryPreviewResponse } from '../../api/sceneTypes';
import type { RootState } from '../../app/store';

type RequestStatus = 'idle' | 'loading' | 'succeeded' | 'failed';

interface SummaryPreviewFormState {
  coordinates: string;
}

interface AsyncRequestState<T> {
  status: RequestStatus;
  error: string | null;
  result: T | null;
}

interface SummaryPreviewState {
  form: SummaryPreviewFormState;
  currentMode: SummaryPreviewMode | null;
  request: AsyncRequestState<SummaryPreviewResponse>;
}

const initialState: SummaryPreviewState = {
  form: {
    coordinates: '39.99952202640245, -83.01270469750418',
  },
  currentMode: null,
  request: {
    status: 'idle',
    error: null,
    result: null,
  },
};

function parseCoordinates(coordinates: string): { lat: number; lon: number } | { error: string } {
  const coordinateParts = coordinates
    .trim()
    .split(/[\s,，;；]+/)
    .filter((part) => part.length > 0);

  if (coordinateParts.length !== 2) {
    return { error: 'Coordinates must contain latitude and longitude, separated by a comma, space, or similar delimiter.' };
  }

  const lat = Number(coordinateParts[0]);
  const lon = Number(coordinateParts[1]);

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return { error: 'Coordinates must be valid numbers.' };
  }

  return { lat, lon };
}

export const fetchSummaryPreview = createAsyncThunk<
  SummaryPreviewResponse,
  { coordinates: string; summaryMode: SummaryPreviewMode },
  { rejectValue: string }
>(
  'summaryPreview/fetchSummaryPreview',
  async ({ coordinates, summaryMode }, { rejectWithValue }) => {
    const parsed = parseCoordinates(coordinates);
    if ('error' in parsed) {
      return rejectWithValue(parsed.error);
    }

    try {
      return await loadSummaryPreview({
        ...parsed,
        summaryMode,
      });
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : 'Unknown error.');
    }
  },
);

const summaryPreviewSlice = createSlice({
  name: 'summaryPreview',
  initialState,
  reducers: {
    setCoordinates(state, action: PayloadAction<string>) {
      state.form.coordinates = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchSummaryPreview.pending, (state, action) => {
        state.request.status = 'loading';
        state.request.error = null;
        state.currentMode = action.meta.arg.summaryMode;
      })
      .addCase(fetchSummaryPreview.fulfilled, (state, action) => {
        state.request.status = 'succeeded';
        state.request.result = action.payload;
      })
      .addCase(fetchSummaryPreview.rejected, (state, action) => {
        state.request.status = 'failed';
        state.request.error = action.payload || 'Unknown error.';
      });
  },
});

export const selectSummaryPreviewState = (state: RootState) => state.summaryPreview;

export const { setCoordinates } = summaryPreviewSlice.actions;
export default summaryPreviewSlice.reducer;

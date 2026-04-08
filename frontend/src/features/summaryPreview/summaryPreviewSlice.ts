import { createAsyncThunk, createSlice, PayloadAction } from '@reduxjs/toolkit';
import { debugScenePromptResponse, loadScenePromptPreview } from '../../api/sceneDebugApi';
import type { RootState } from '../../app/store';

/**
 * Summary 是 Scene Prompt 的旧称
 */

type RequestStatus = 'idle' | 'loading' | 'succeeded' | 'failed';

interface SummaryPreviewFormState {
  coordinates: string;
  radius: string;
}

interface AsyncRequestState<T> {
  status: RequestStatus;
  error: string | null;
  result: T | null;
}

interface SummaryPreviewState {
  form: SummaryPreviewFormState;
  request: AsyncRequestState<debugScenePromptResponse>;
}

const initialState: SummaryPreviewState = {
  form: {
    coordinates: '39.99952202640245, -83.01270469750418',
    radius: '',
  },
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

export const fetchSummaryPreview = createAsyncThunk<debugScenePromptResponse, SummaryPreviewFormState, { rejectValue: string }>(
  'summaryPreview/fetchSummaryPreview',
  async ({ coordinates, radius }, { rejectWithValue }) => {
    const parsed = parseCoordinates(coordinates);
    if ('error' in parsed) {
      return rejectWithValue(parsed.error);
    }

    const parsedRadius = Number(radius);
    if (!Number.isFinite(parsedRadius)) {
      return rejectWithValue('Radius must be a valid number.');
    }

    if (parsedRadius <= 0) {
      return rejectWithValue('Radius must be greater than 0.');
    }

    try {
      return await loadScenePromptPreview({
        ...parsed,
        radius: parsedRadius,
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
    setRadius(state, action: PayloadAction<string>) {
      state.form.radius = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchSummaryPreview.pending, (state) => {
        state.request.status = 'loading';
        state.request.error = null;
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

export const { setCoordinates, setRadius } = summaryPreviewSlice.actions;
export default summaryPreviewSlice.reducer;

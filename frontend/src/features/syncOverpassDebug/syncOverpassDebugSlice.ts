import { createAsyncThunk, createSlice, PayloadAction } from '@reduxjs/toolkit';
import {
  postDbDebugLoad,
  postSyncOverpassToDb,
  type DbDebugLoadResponse,
  type SyncOverpassToDbResponse,
} from '../../api/chatApi';

interface SyncOverpassDebugFormState {
  coordinates: string;
  radius: string;
}

interface SyncOverpassDebugState {
  form: SyncOverpassDebugFormState;
  syncLoading: boolean;
  syncResult: SyncOverpassToDbResponse | null;
  syncError: string | null;
  dbLoadLoading: boolean;
  dbNormalizedResult: DbDebugLoadResponse | null;
  dbLoadError: string | null;
}

const initialState: SyncOverpassDebugState = {
  form: {
    coordinates: '34.03051902687699, -84.06309056978101',
    radius: '300',
  },
  syncLoading: false,
  syncResult: null,
  syncError: null,
  dbLoadLoading: false,
  dbNormalizedResult: null,
  dbLoadError: null,
};

function parseNormalizedForm(form: SyncOverpassDebugFormState): ParsedNormalizedForm {
  const coordinateParts = form.coordinates
    .trim()
    .split(/[\s,，;；]+/)
    .filter((part) => part.length > 0);

  if (coordinateParts.length !== 2) {
    return { error: 'Coordinates must contain latitude and longitude, separated by a comma, space, or similar delimiter.' } as const;
  }

  const lat = Number(coordinateParts[0]);
  const lon = Number(coordinateParts[1]);
  const radius = Number(form.radius);

  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(radius)) {
    return { error: 'Coordinates and radius must be valid numbers.' } as const;
  }

  if (radius <= 0) {
    return { error: 'Radius must be greater than 0.' } as const;
  }

  return { value: { lat, lon, radius } } as const;
}

type ParsedNormalizedForm =
  | { error: string }
  | {
      value: {
        lat: number;
        lon: number;
        radius: number;
      };
    };

export const submitSyncOverpassToDb = createAsyncThunk<
  SyncOverpassToDbResponse,
  SyncOverpassDebugFormState,
  { rejectValue: string }
>('syncOverpassDebug/submitSyncOverpassToDb', async (form, { rejectWithValue }) => {
  const parsed = parseNormalizedForm(form);
  if ('error' in parsed) {
    return rejectWithValue(parsed.error);
  }

  try {
    return await postSyncOverpassToDb(parsed.value);
  } catch (error) {
    return rejectWithValue(error instanceof Error ? error.message : 'Unknown error.');
  }
});

export const submitDbDebugLoad = createAsyncThunk<DbDebugLoadResponse, SyncOverpassDebugFormState, { rejectValue: string }>(
  'syncOverpassDebug/submitDbDebugLoad',
  async (form, { rejectWithValue }) => {
    const parsed = parseNormalizedForm(form);
    if ('error' in parsed) {
      return rejectWithValue(parsed.error);
    }

    try {
      return await postDbDebugLoad(parsed.value);
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : 'Unknown error.');
    }
  },
);

const syncOverpassDebugSlice = createSlice({
  name: 'syncOverpassDebug',
  initialState,
  reducers: {
    updateSyncOverpassDebugField(
      state,
      action: PayloadAction<{ field: keyof SyncOverpassDebugFormState; value: string }>,
    ) {
      state.form[action.payload.field] = action.payload.value;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(submitSyncOverpassToDb.pending, (state) => {
        state.syncLoading = true;
        state.syncError = null;
      })
      .addCase(submitSyncOverpassToDb.fulfilled, (state, action) => {
        state.syncLoading = false;
        state.syncResult = action.payload;
      })
      .addCase(submitSyncOverpassToDb.rejected, (state, action) => {
        state.syncLoading = false;
        state.syncError = action.payload || 'Unknown error.';
      })
      .addCase(submitDbDebugLoad.pending, (state) => {
        state.dbLoadLoading = true;
        state.dbLoadError = null;
      })
      .addCase(submitDbDebugLoad.fulfilled, (state, action) => {
        state.dbLoadLoading = false;
        state.dbNormalizedResult = action.payload;
      })
      .addCase(submitDbDebugLoad.rejected, (state, action) => {
        state.dbLoadLoading = false;
        state.dbLoadError = action.payload || 'Unknown error.';
      });
  },
});

export const { updateSyncOverpassDebugField } = syncOverpassDebugSlice.actions;
export default syncOverpassDebugSlice.reducer;

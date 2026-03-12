import { createAsyncThunk, createSlice, PayloadAction } from '@reduxjs/toolkit';
import {
  type DbDebugLoadResponse,
  postDbNormalizedLoad,
  postOverpassQuery,
  postSyncOverpassToDb,
  type OverpassResponse,
  type SyncOverpassToDbResponse,
} from '../../api/chatApi';

// 规范化查询表单在 Redux 里的形状。
// 这里故意保留 string，是因为输入框编辑过程中可能暂时不是合法数字；
// 真正提交请求前，再统一做解析和校验。
interface NormalizeFormState {
  coordinates: string;
  radius: string;
}

// debug slice 统一管理两个调试页面的数据：
// 1. normalization 页面
// 2. raw overpass 页面
// 这两个页面共享的特点是：表单输入、接口结果、loading、error 都需要跨组件保留。
interface DebugState {
  normalizeForm: NormalizeFormState;
  rawQuery: string;
  normalizeLoading: boolean;
  syncLoading: boolean;
  rawLoading: boolean;
  normalizedResult: DbDebugLoadResponse | null;
  syncResult: SyncOverpassToDbResponse | null;
  rawResult: OverpassResponse | null;
  normalizeError: string | null;
  syncError: string | null;
  rawError: string | null;
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

const initialState: DebugState = {
  normalizeForm: {
    coordinates: '34.03051902687699, -84.06309056978101',
    radius: '30',
  },
  rawQuery: '[out:json];\nnwr(around:30, 34.02466920711174, -84.09143822250903)(if:count_tags()>0);\nout center geom;',
  normalizeLoading: false,
  syncLoading: false,
  rawLoading: false,
  normalizedResult: null,
  syncResult: null,
  rawResult: null,
  normalizeError: null,
  syncError: null,
  rawError: null,
};

function parseNormalizedForm(form: NormalizeFormState): ParsedNormalizedForm {
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

  return {
    value: {
      lat,
      lon,
      radius,
    },
  } as const;
}

// normalization 页面现在走数据库正式链路：
// 先 Sync Overpass -> DB，再显式 Load From DB。
export const submitSyncOverpassToDb = createAsyncThunk<
  SyncOverpassToDbResponse,
  NormalizeFormState,
  { rejectValue: string }
>('debug/submitSyncOverpassToDb', async (form, { rejectWithValue }) => {
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

export const submitNormalizedQuery = createAsyncThunk<
  DbDebugLoadResponse,
  NormalizeFormState,
  { rejectValue: string }
>('debug/submitNormalizedQuery', async (form, { rejectWithValue }) => {
  const parsed = parseNormalizedForm(form);
  if ('error' in parsed) {
    return rejectWithValue(parsed.error);
  }

  try {
    return await postDbNormalizedLoad(parsed.value);
  } catch (error) {
    return rejectWithValue(error instanceof Error ? error.message : 'Unknown error.');
  }
});

// 这个 thunk 负责 raw overpass 调试页。
// 和 normalization 的区别是：它不组装结构化参数，直接把用户输入的 QL 原样发给后端。
export const submitRawQuery = createAsyncThunk<OverpassResponse, string, { rejectValue: string }>(
  'debug/submitRawQuery',
  async (query, { rejectWithValue }) => {
    const trimmedQuery = query.trim();

    if (!trimmedQuery) {
      return rejectWithValue('Query is required.');
    }

    try {
      return await postOverpassQuery(trimmedQuery);
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : 'Unknown error.');
    }
  },
);

const debugSlice = createSlice({
  name: 'debug',
  initialState,
  reducers: {
    // 这几个同步 reducer 都是表单输入类状态：
    // 用户每敲一个字符，就立刻回写到 Redux。
    updateNormalizeField(
      state,
      action: PayloadAction<{ field: keyof NormalizeFormState; value: string }>,
    ) {
      state.normalizeForm[action.payload.field] = action.payload.value;
    },
    updateRawQuery(state, action: PayloadAction<string>) {
      state.rawQuery = action.payload;
    },
  },
  extraReducers: (builder) => {
    // 异步状态管理按接口分成两套：
    // 1. normalizeLoading / normalizedResult / normalizeError
    // 2. rawLoading / rawResult / rawError
    // 这样两个 debug 页面即使来回切换，也不会互相覆盖对方的结果。
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
      .addCase(submitNormalizedQuery.pending, (state) => {
        state.normalizeLoading = true;
        state.normalizeError = null;
      })
      .addCase(submitNormalizedQuery.fulfilled, (state, action) => {
        state.normalizeLoading = false;
        state.normalizedResult = action.payload;
      })
      .addCase(submitNormalizedQuery.rejected, (state, action) => {
        state.normalizeLoading = false;
        state.normalizeError = action.payload || 'Unknown error.';
      })
      .addCase(submitRawQuery.pending, (state) => {
        state.rawLoading = true;
        state.rawError = null;
      })
      .addCase(submitRawQuery.fulfilled, (state, action) => {
        state.rawLoading = false;
        state.rawResult = action.payload;
      })
      .addCase(submitRawQuery.rejected, (state, action) => {
        state.rawLoading = false;
        state.rawError = action.payload || 'Unknown error.';
      });
  },
});

export const { updateNormalizeField, updateRawQuery } = debugSlice.actions;
export default debugSlice.reducer;

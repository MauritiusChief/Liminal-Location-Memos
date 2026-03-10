import { createAsyncThunk, createSlice, PayloadAction } from '@reduxjs/toolkit';
import {
  postNormalizedOverpassQuery,
  postOverpassQuery,
  type NormalizedOverpassResponse,
  type OverpassResponse,
} from '../../api/chatApi';

// 规范化查询表单在 Redux 里的形状。
// 这里故意保留 string，是因为输入框编辑过程中可能暂时不是合法数字；
// 真正提交请求前，再统一做解析和校验。
interface NormalizeFormState {
  coordinates: string;
  radius: string;
  includeRaw: boolean;
}

// debug slice 统一管理两个调试页面的数据：
// 1. normalization 页面
// 2. raw overpass 页面
// 这两个页面共享的特点是：表单输入、接口结果、loading、error 都需要跨组件保留。
interface DebugState {
  normalizeForm: NormalizeFormState;
  rawQuery: string;
  normalizeLoading: boolean;
  rawLoading: boolean;
  normalizedResult: NormalizedOverpassResponse | null;
  rawResult: OverpassResponse | null;
  normalizeError: string | null;
  rawError: string | null;
}

const initialState: DebugState = {
  normalizeForm: {
    coordinates: '34.03051902687699, -84.06309056978101',
    radius: '30',
    includeRaw: false,
  },
  rawQuery: '[out:json];\nnwr(around:30, 34.02466920711174, -84.09143822250903)(if:count_tags()>0);\nout center geom;',
  normalizeLoading: false,
  rawLoading: false,
  normalizedResult: null,
  rawResult: null,
  normalizeError: null,
  rawError: null,
};

// 这个 thunk 负责 normalization 页面整条异步链路：
// 表单字符串 -> 解析经纬度/半径 -> 调 /api/overpass/normalize -> 返回规范化结果。
export const submitNormalizedQuery = createAsyncThunk<
  NormalizedOverpassResponse,
  NormalizeFormState,
  { rejectValue: string }
>('debug/submitNormalizedQuery', async (form, { rejectWithValue }) => {
  const coordinateParts = form.coordinates
    .trim()
    .split(/[\s,，;；]+/)
    .filter((part) => part.length > 0);

  if (coordinateParts.length !== 2) {
    return rejectWithValue('Coordinates must contain latitude and longitude, separated by a comma, space, or similar delimiter.');
  }

  const lat = Number(coordinateParts[0]);
  const lon = Number(coordinateParts[1]);
  const radius = Number(form.radius);

  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(radius)) {
    return rejectWithValue('Coordinates and radius must be valid numbers.');
  }

  if (radius <= 0) {
    return rejectWithValue('Radius must be greater than 0.');
  }

  try {
    return await postNormalizedOverpassQuery({
      lat,
      lon,
      radius,
      includeRaw: form.includeRaw,
    });
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
      action: PayloadAction<{ field: keyof Omit<NormalizeFormState, 'includeRaw'>; value: string }>,
    ) {
      state.normalizeForm[action.payload.field] = action.payload.value;
    },
    updateIncludeRaw(state, action: PayloadAction<boolean>) {
      state.normalizeForm.includeRaw = action.payload;
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

export const { updateNormalizeField, updateIncludeRaw, updateRawQuery } = debugSlice.actions;
export default debugSlice.reducer;

import { createAsyncThunk, createSlice, PayloadAction } from '@reduxjs/toolkit';
import {
  postNormalizedOverpassQuery,
  postOverpassQuery,
  type NormalizedOverpassResponse,
  type OverpassResponse,
} from '../../api/chatApi';

// 这个接口描述“规范化查询表单”在 Redux 里的形状。
// 这里把输入值保留为 string，是为了让表单输入过程更自然；
// 真正发请求前再统一转换成 number 并校验。
interface NormalizeFormState {
  lat: string;
  lon: string;
  radius: string;
  includeRaw: boolean;
}

// ChatState 是 chat slice 管理的整块状态。
// 最终它会挂在全局 store 的 state.chat 下。
interface ChatState {
  normalizeForm: NormalizeFormState;
  rawQuery: string;
  normalizeLoading: boolean;
  rawLoading: boolean;
  normalizedResult: NormalizedOverpassResponse | null;
  rawResult: OverpassResponse | null;
  error: string | null;
}

// initialState 是 chat slice 的默认值。
// 应用首次启动时，界面上看到的初始输入框内容就来自这里。
const initialState: ChatState = {
  normalizeForm: {
    lat: '34.03051902687699',
    lon: '-84.06309056978101',
    radius: '30',
    includeRaw: true,
  },
  rawQuery: '[out:json];\nnwr(around:30, 34.02466920711174, -84.09143822250903)(if:count_tags()>0);\nout center geom;',
  normalizeLoading: false,
  rawLoading: false,
  normalizedResult: null,
  rawResult: null,
  error: null,
};

// createAsyncThunk 会自动帮我们生成 pending / fulfilled / rejected 三种 action。
// 这个 thunk 用来处理“结构化参数 -> 调标准化接口”的完整异步流程。
export const submitNormalizedQuery = createAsyncThunk<
  NormalizedOverpassResponse,
  NormalizeFormState,
  { rejectValue: string }
>('chat/submitNormalizedQuery', async (form, { rejectWithValue }) => {
  const lat = Number(form.lat);
  const lon = Number(form.lon);
  const radius = Number(form.radius);

  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(radius)) {
    return rejectWithValue('Latitude, longitude, and radius must be valid numbers.');
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

// 这个 thunk 保留“原始 Overpass QL playground”的能力。
// 它和上面的区别在于：这里直接发送用户输入的 query 字符串。
export const submitRawQuery = createAsyncThunk<OverpassResponse, string, { rejectValue: string }>(
  'chat/submitRawQuery',
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

// createSlice 把“状态、同步 reducer、异步 action 响应”放在一起定义。
const chatSlice = createSlice({
  name: 'chat',
  initialState,
  reducers: {
    // 这类 reducer 处理同步状态更新。
    // 典型场景就是输入框 onChange 时，把最新输入写回 Redux。
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
    // extraReducers 专门处理 thunk 这类“本 slice 外部生成的 action”。
    // 这里根据异步请求的不同阶段来更新 loading / result / error。
    builder
      .addCase(submitNormalizedQuery.pending, (state) => {
        state.normalizeLoading = true;
        state.error = null;
      })
      .addCase(submitNormalizedQuery.fulfilled, (state, action) => {
        state.normalizeLoading = false;
        state.normalizedResult = action.payload;
      })
      .addCase(submitNormalizedQuery.rejected, (state, action) => {
        state.normalizeLoading = false;
        state.error = action.payload || 'Unknown error.';
      })
      .addCase(submitRawQuery.pending, (state) => {
        state.rawLoading = true;
        state.error = null;
      })
      .addCase(submitRawQuery.fulfilled, (state, action) => {
        state.rawLoading = false;
        state.rawResult = action.payload;
      })
      .addCase(submitRawQuery.rejected, (state, action) => {
        state.rawLoading = false;
        state.error = action.payload || 'Unknown error.';
      });
  },
});

// actions 会被组件通过 dispatch 调用。
export const { updateNormalizeField, updateIncludeRaw, updateRawQuery } = chatSlice.actions;

// reducer 会在 store.ts 里注册到全局 store。
export default chatSlice.reducer;

import { createAsyncThunk, createSlice, PayloadAction } from '@reduxjs/toolkit';
import { runRawOverpassQuery } from '../../api/sceneDebugApi';
import type { RawOverpassResponse } from '../../api/sceneTypes';
import type { RootState } from '../../app/store';

type RequestStatus = 'idle' | 'loading' | 'succeeded' | 'failed';

interface RawQueryRequestState {
  status: RequestStatus;
  error: string | null;
  result: RawOverpassResponse | null;
}

// Raw Overpass 调试页只关心一段原始 QL 文本和一次执行结果。
// 这里把输入框内容与异步请求结果放在同一个 slice，是为了让页面刷新/切页后仍能保留调试上下文。
interface RawOverpassDebugState {
  query: string;
  request: RawQueryRequestState;
}

const initialState: RawOverpassDebugState = {
  query: '[out:json];\nnwr(around:30, 34.02466920711174, -84.09143822250903)(if:count_tags()>0);\nout center geom;',
  request: {
    status: 'idle',
    error: null,
    result: null,
  },
};

// 这个 thunk 负责把原始 Overpass QL 发给后端。
// 与 normalization 页不同，这里不做结构化参数拼装，只校验“输入不能为空”。
export const submitRawOverpassQuery = createAsyncThunk<RawOverpassResponse, string, { rejectValue: string }>(
  'rawOverpassDebug/submitRawOverpassQuery',
  async (query, { rejectWithValue }) => {
    const trimmedQuery = query.trim();

    if (!trimmedQuery) {
      return rejectWithValue('Query is required.');
    }

    try {
      return await runRawOverpassQuery({ query: trimmedQuery });
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : 'Unknown error.');
    }
  },
);

const rawOverpassDebugSlice = createSlice({
  name: 'rawOverpassDebug',
  initialState,
  reducers: {
    // 同步 reducer 只负责“文本框输入变化”这类本地交互。
    setQuery(state, action: PayloadAction<string>) {
      state.query = action.payload;
    },
  },
  extraReducers: (builder) => {
    // 异步请求阶段和 UI 展示状态一一对应：
    // loading 控制按钮禁用，succeeded 写回结果，failed 写回错误。
    builder
      .addCase(submitRawOverpassQuery.pending, (state) => {
        state.request.status = 'loading';
        state.request.error = null;
      })
      .addCase(submitRawOverpassQuery.fulfilled, (state, action) => {
        state.request.status = 'succeeded';
        state.request.result = action.payload;
      })
      .addCase(submitRawOverpassQuery.rejected, (state, action) => {
        state.request.status = 'failed';
        state.request.error = action.payload || 'Unknown error.';
      });
  },
});

// selector 让页面只关心“拿到 raw overpass 页面状态”，
// 不需要知道 store 里这个 slice 挂在哪个 key 上。
export const selectRawOverpassDebugState = (state: RootState) => state.rawOverpassDebug;

export const { setQuery } = rawOverpassDebugSlice.actions;
export default rawOverpassDebugSlice.reducer;

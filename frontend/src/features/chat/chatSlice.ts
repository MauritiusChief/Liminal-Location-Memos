import { createAsyncThunk, createSlice, PayloadAction } from '@reduxjs/toolkit';
import {
  postNormalizedOverpassQuery,
  postOverpassQuery,
  type FeatureCategory,
  type NormalizedOverpassResponse,
  type OverpassResponse,
} from '../../api/chatApi';
// ChatState 描述了 chat 这块状态分片的结构。
// 因为 store.ts 里把它注册为 chat，所以它最终会出现在 state.chat 中。
interface NormalizeFormState {
  lat: string;
  lon: string;
  radius: string;
  includeRaw: boolean;
}

interface ChatState {
  normalizeForm: NormalizeFormState;
  rawQuery: string;
  categories: FeatureCategory[];
  normalizeLoading: boolean;
  rawLoading: boolean;
  normalizedResult: NormalizedOverpassResponse | null;
  rawResult: OverpassResponse | null;
  error: string | null;
}

const initialState: ChatState = {
  normalizeForm: {
    lat: '34.03051902687699',
    lon: '-84.06309056978101',
    radius: '30',
    includeRaw: true,
  },
  rawQuery: '[out:json];\nnwr(around:30, 34.02466920711174, -84.09143822250903)(if:count_tags()>0);\nout center geom;',
  categories: ['building', 'landuse', 'natural', 'leisure', 'amenity'],
  normalizeLoading: false,
  rawLoading: false,
  normalizedResult: null,
  rawResult: null,
  error: null,
};

// submitMessage 是一个异步 thunk action。
// 它负责处理“提交消息给后端”这件异步工作，并自动生成 pending / fulfilled / rejected 三种状态。
export const submitNormalizedQuery = createAsyncThunk<
  NormalizedOverpassResponse,
  NormalizeFormState,
  { rejectValue: string; state: { chat: ChatState } }
>(
  // 这是 action type 的前缀，最终会扩展成 chat/submitMessage/pending 等形式。
  'chat/submitNormalizedQuery',
  async (form, { getState, rejectWithValue }) => {
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
        featureCategories: getState().chat.categories,
      });
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : 'Unknown error.');
    }
  }
);

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

// createSlice 用来把“状态 + 修改状态的规则 + 自动生成的 actions”放在一起定义。
const chatSlice = createSlice({
  // name 会作为 action type 的前缀，例如 chat/updateInput。
  name: 'chat',
  initialState,
  reducers: {
    // reducers 里放同步状态更新逻辑。
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
    toggleCategory(state, action: PayloadAction<FeatureCategory>) {
      if (state.categories.includes(action.payload)) {
        if (state.categories.length > 1) {
          state.categories = state.categories.filter((category) => category !== action.payload);
        }
        return;
      }

      state.categories.push(action.payload);
    },
  },
  extraReducers: (builder) => {
    // extraReducers 用来处理当前 slice 自己定义之外的 actions，
    // 这里主要处理 submitMessage 这个异步 thunk 的三种阶段。
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

// chatSlice.actions 里会自动生成与 reducers 同名的 action creator。
export const { updateNormalizeField, updateIncludeRaw, updateRawQuery, toggleCategory } = chatSlice.actions;

// 默认导出 reducer，供 store.ts 注册到 Redux store 中。
// store.ts 里把它命名为 chatReducer 导入，再挂到 reducer.chat 上。
export default chatSlice.reducer;

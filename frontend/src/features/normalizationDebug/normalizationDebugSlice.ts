import { createAsyncThunk, createSlice, PayloadAction } from '@reduxjs/toolkit';
import { loadSceneFromDb, syncSceneFromOverpass } from '../../api/sceneDebugApi';
import type { SceneLoadResponse, SceneQuery, SceneSyncResponse } from '../../api/sceneTypes';
import type { RootState } from '../../app/store';

type RequestStatus = 'idle' | 'loading' | 'succeeded' | 'failed';

interface NormalizationFormState {
  coordinates: string;
  radius: string;
}

interface AsyncRequestState<T> {
  status: RequestStatus;
  error: string | null;
  result: T | null;
}

// normalization 页是 Redux 初学者最值得看的状态流示例：
// 用户先在表单里输入坐标和半径，thunk 再把字符串解析成真正的数值请求，
// 然后调用后端把 OSM 数据同步进 DB，或者直接从 DB 读取 scene 投影结果，
// 最后 reducer 把结果写回 store，页面再从 selector 里读出 grid / polar / prompt preview 渲染。
interface NormalizationDebugState {
  form: NormalizationFormState;
  syncRequest: AsyncRequestState<SceneSyncResponse>;
  dbLoadRequest: AsyncRequestState<SceneLoadResponse>;
}

type ParsedNormalizationForm =
  | { error: string }
  | {
      value: SceneQuery;
    };

const initialState: NormalizationDebugState = {
  form: {
    coordinates: '39.99952202640245, -83.01270469750418',
    radius: '200',
  },
  syncRequest: {
    status: 'idle',
    error: null,
    result: null,
  },
  dbLoadRequest: {
    status: 'idle',
    error: null,
    result: null,
  },
};

function parseNormalizationForm(form: NormalizationFormState): ParsedNormalizationForm {
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

// 这个 thunk 负责“先从用户输入拿到表单值，再请求 /api/db/sync-overpass”。
// 它成功后只更新 syncRequest，不会碰 dbLoadRequest，这样用户可以分别观察两步结果。
export const syncScene = createAsyncThunk<SceneSyncResponse, NormalizationFormState, { rejectValue: string }>(
  'normalizationDebug/syncScene',
  async (form, { rejectWithValue }) => {
    const parsed = parseNormalizationForm(form);
    if ('error' in parsed) {
      return rejectWithValue(parsed.error);
    }

    try {
      return await syncSceneFromOverpass(parsed.value);
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : 'Unknown error.');
    }
  },
);

// 这个 thunk 负责“用同一份表单参数从 DB 读取已经规整化好的 scene”。
// 页面渲染的大部分调试内容都来自 dbLoadRequest.result。
export const loadScene = createAsyncThunk<SceneLoadResponse, NormalizationFormState, { rejectValue: string }>(
  'normalizationDebug/loadScene',
  async (form, { rejectWithValue }) => {
    const parsed = parseNormalizationForm(form);
    if ('error' in parsed) {
      return rejectWithValue(parsed.error);
    }

    try {
      return await loadSceneFromDb(parsed.value);
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : 'Unknown error.');
    }
  },
);

const normalizationDebugSlice = createSlice({
  name: 'normalizationDebug',
  initialState,
  reducers: {
    // 同步 reducer 只负责表单输入。
    // 用户每输入一个字符，就 dispatch 一个 action，由 reducer 回写到 Redux。
    setCoordinates(state, action: PayloadAction<string>) {
      state.form.coordinates = action.payload;
    },
    setRadius(state, action: PayloadAction<string>) {
      state.form.radius = action.payload;
    },
  },
  extraReducers: (builder) => {
    // extraReducers 负责把异步请求阶段映射成页面可读的状态。
    // 这里故意把 sync 和 db load 分成两套 request，避免两个按钮互相覆盖结果。
    builder
      .addCase(syncScene.pending, (state) => {
        state.syncRequest.status = 'loading';
        state.syncRequest.error = null;
      })
      .addCase(syncScene.fulfilled, (state, action) => {
        state.syncRequest.status = 'succeeded';
        state.syncRequest.result = action.payload;
      })
      .addCase(syncScene.rejected, (state, action) => {
        state.syncRequest.status = 'failed';
        state.syncRequest.error = action.payload || 'Unknown error.';
      })
      .addCase(loadScene.pending, (state) => {
        state.dbLoadRequest.status = 'loading';
        state.dbLoadRequest.error = null;
      })
      .addCase(loadScene.fulfilled, (state, action) => {
        state.dbLoadRequest.status = 'succeeded';
        state.dbLoadRequest.result = action.payload;
      })
      .addCase(loadScene.rejected, (state, action) => {
        state.dbLoadRequest.status = 'failed';
        state.dbLoadRequest.error = action.payload || 'Unknown error.';
      });
  },
});

// 组件通过 selector 读状态，而不是直接持有整个 store，
// 这样页面只知道“我要 normalizationDebug 这一块数据”，不依赖 store 结构细节。
export const selectNormalizationDebugState = (state: RootState) => state.normalizationDebug;

export const { setCoordinates, setRadius } = normalizationDebugSlice.actions;
export default normalizationDebugSlice.reducer;

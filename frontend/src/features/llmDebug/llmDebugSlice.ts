import { createAsyncThunk, createSlice, PayloadAction } from '@reduxjs/toolkit';
import { submitDebugLlm, type DebugLlmRequest, type DebugLlmResponse } from '../../api/llmDebugApi';
import type { RootState } from '../../app/store';
import { DEFAULT_LLM_DEBUG_SYSTEM_PROMPT, DEFAULT_BUILDING_SCHEMA_SYSTEM_PROMPT } from './defaultSystemPrompt';

type RequestStatus = 'idle' | 'loading' | 'succeeded' | 'failed';

interface LlmDebugRequestState {
  status: RequestStatus;
  error: string | null;
  reply: string | null;
  reasoning: string | null;
}

// 这个 slice 只服务 LLM 环境调试页。
// 把 system prompt、user message 和请求结果都放进 Redux 后，
// 页面切换时调试上下文不会丢，便于反复对比 prompt 与模型输出。
interface LlmDebugState {
  systemPrompt: string;
  message: string;
  request: LlmDebugRequestState;
}

const initialState: LlmDebugState = {
  // systemPrompt: DEFAULT_LLM_DEBUG_SYSTEM_PROMPT,
  systemPrompt: DEFAULT_BUILDING_SCHEMA_SYSTEM_PROMPT,
  message: '',
  request: {
    status: 'idle',
    error: null,
    reply: null,
    reasoning: null,
  },
};

// 这个 thunk 负责把调试页里的 system prompt + user message 一起提交给后端。
// 它和首页 chat 的区别是：首页只有普通 message，而这里还要保留可编辑的系统提示词。
export const submitDebugLlmMessage = createAsyncThunk<DebugLlmResponse, DebugLlmRequest, { rejectValue: string }>(
  'llmDebug/submitDebugLlmMessage',
  async (input, { rejectWithValue }) => {
    if (!input.message.trim()) {
      return rejectWithValue('Message is required.');
    }

    try {
      return await submitDebugLlm({
        systemPrompt: input.systemPrompt,
        message: input.message.trim(),
      });
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : 'Unknown error.');
    }
  },
);

const llmDebugSlice = createSlice({
  name: 'llmDebug',
  initialState,
  reducers: {
    // 同步 reducer 负责输入框内容本身。
    setSystemPrompt(state, action: PayloadAction<string>) {
      state.systemPrompt = action.payload;
    },
    setMessage(state, action: PayloadAction<string>) {
      state.message = action.payload;
    },
    resetSystemPrompt(state) {
      state.systemPrompt = DEFAULT_LLM_DEBUG_SYSTEM_PROMPT;
    },
  },
  extraReducers: (builder) => {
    // 请求开始时进入 loading，并清掉上一次错误与 reasoning；
    // 请求成功后写入 reply / reasoning；失败后只保留错误信息。
    builder
      .addCase(submitDebugLlmMessage.pending, (state) => {
        state.request.status = 'loading';
        state.request.error = null;
        state.request.reasoning = null;
      })
      .addCase(submitDebugLlmMessage.fulfilled, (state, action) => {
        state.request.status = 'succeeded';
        state.request.reply = action.payload.reply;
        state.request.reasoning = action.payload.reasoning;
      })
      .addCase(submitDebugLlmMessage.rejected, (state, action) => {
        state.request.status = 'failed';
        state.request.reasoning = null;
        state.request.error = action.payload || 'Unknown error.';
      });
  },
});

// selector 把页面需要读取的状态出口固定下来，
// 组件不必关心 reducer key 以外的实现细节。
export const selectLlmDebugState = (state: RootState) => state.llmDebug;

export const { resetSystemPrompt, setMessage, setSystemPrompt } = llmDebugSlice.actions;
export default llmDebugSlice.reducer;

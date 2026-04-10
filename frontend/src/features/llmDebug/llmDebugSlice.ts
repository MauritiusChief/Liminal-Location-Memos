import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import { streamDebugLlm, type DebugLlmRequest, type DebugLlmStreamEvent } from '../../api/llmDebugApi';
import type { AppDispatch, RootState } from '../../app/store';
import { DEFAULT_LLM_DEBUG_SYSTEM_PROMPT, DEFAULT_BUILDING_SCHEMA_SYSTEM_PROMPT } from './defaultSystemPrompt';

type RequestStatus = 'idle' | 'loading' | 'succeeded' | 'failed';

interface LlmDebugRequestState {
  status: RequestStatus;
  error: string | null;
  reply: string | null;
  reasoning: string | null;
  hasReceivedAnyChunk: boolean;
}

// 这个 slice 只服务 LLM 环境调试页。
// 把 system prompt、user message 和流式请求结果都放进 Redux 后，
// 页面切换时调试上下文不会丢，后续若把主游戏回合也接成 stream，也能复用同样的状态机思路。
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
    hasReceivedAnyChunk: false,
  },
};

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

    // streamStarted / deltaReceived / streamFinished / streamFailed 这组 action
    // 是一个显式的流式状态机。
    // createAsyncThunk 更适合“最后一次性拿到 payload”的请求；
    // 这里如果继续用 fulfilled 才落结果的模式，就无法在 token 到达时持续刷新 UI。
    streamStarted(state) {
      state.request.status = 'loading';
      state.request.error = null;
      state.request.reply = null;
      state.request.reasoning = null;
      state.request.hasReceivedAnyChunk = false;
    },
    replyDeltaReceived(state, action: PayloadAction<string>) {
      state.request.reply = `${state.request.reply ?? ''}${action.payload}`;
      state.request.hasReceivedAnyChunk = true;
    },
    reasoningDeltaReceived(state, action: PayloadAction<string>) {
      state.request.reasoning = `${state.request.reasoning ?? ''}${action.payload}`;
      state.request.hasReceivedAnyChunk = true;
    },
    streamFinished(state) {
      state.request.status = 'succeeded';
    },
    streamFailed(state, action: PayloadAction<string>) {
      state.request.status = 'failed';
      state.request.error = action.payload;
    },
  },
});

/**
 * 手写 thunk 的原因是：stream 请求不是“等 Promise resolve 后写最终结果”，
 * 而是需要在请求过程中不断 dispatch 增量 action。
 * 这里先明确采用单飞行策略，loading 中重复点击直接忽略，避免本阶段就引入取消/并发的复杂度。
 */
export function submitDebugLlmMessage(input: DebugLlmRequest) {
  return async (dispatch: AppDispatch, getState: () => RootState): Promise<void> => {
    const beforeSubmit = getState().llmDebug;
    if (beforeSubmit.request.status === 'loading') {
      return;
    }

    if (!input.message.trim()) {
      dispatch(streamFailed('Message is required.'));
      return;
    }

    dispatch(streamStarted());

    try {
      let hasFinished = false;

      await streamDebugLlm({
        systemPrompt: input.systemPrompt,
        message: input.message.trim(),
      }, (event: DebugLlmStreamEvent) => {
        switch (event.type) {
          case 'reply_delta':
            dispatch(replyDeltaReceived(event.text));
            return;
          case 'reasoning_delta':
            dispatch(reasoningDeltaReceived(event.text));
            return;
          case 'done':
            hasFinished = true;
            dispatch(streamFinished());
            return;
          case 'error':
            throw new Error(event.message);
        }
      });

      if (!hasFinished) {
        dispatch(streamFinished());
      }
    } catch (error) {
      dispatch(streamFailed(error instanceof Error ? error.message : 'Unknown error.'));
    }
  };
}

// selector 把页面需要读取的状态出口固定下来，
// 组件不必关心 reducer key 以外的实现细节。
export const selectLlmDebugState = (state: RootState) => state.llmDebug;

export const {
  replyDeltaReceived,
  reasoningDeltaReceived,
  resetSystemPrompt,
  setMessage,
  setSystemPrompt,
  streamFailed,
  streamFinished,
  streamStarted,
} = llmDebugSlice.actions;

export default llmDebugSlice.reducer;

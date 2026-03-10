import { createAsyncThunk, createSlice, PayloadAction } from '@reduxjs/toolkit';
import { postDebugLlmMessage, type ChatResponse } from '../../api/chatApi';
import { DEFAULT_LLM_DEBUG_SYSTEM_PROMPT } from './defaultSystemPrompt';

interface LlmDebugState {
  systemPrompt: string;
  message: string;
  loading: boolean;
  reply: string | null;
  error: string | null;
}

const initialState: LlmDebugState = {
  systemPrompt: DEFAULT_LLM_DEBUG_SYSTEM_PROMPT,
  message: '',
  loading: false,
  reply: null,
  error: null,
};

// 这个 slice 专门服务 debug/llm-environment 页面。
// 它和首页 chat 分开，避免调试时的系统提示词、消息内容污染首页的简单聊天体验。
export const submitDebugLlmMessage = createAsyncThunk<
  ChatResponse,
  { systemPrompt: string; message: string },
  { rejectValue: string }
>('llmDebug/submitDebugLlmMessage', async (input, { rejectWithValue }) => {
  if (!input.message.trim()) {
    return rejectWithValue('Message is required.');
  }

  try {
    return await postDebugLlmMessage({
      systemPrompt: input.systemPrompt,
      message: input.message.trim(),
    });
  } catch (error) {
    return rejectWithValue(error instanceof Error ? error.message : 'Unknown error.');
  }
});

const llmDebugSlice = createSlice({
  name: 'llmDebug',
  initialState,
  reducers: {
    updateSystemPrompt(state, action: PayloadAction<string>) {
      state.systemPrompt = action.payload;
    },
    updateMessage(state, action: PayloadAction<string>) {
      state.message = action.payload;
    },
    resetSystemPrompt(state) {
      state.systemPrompt = DEFAULT_LLM_DEBUG_SYSTEM_PROMPT;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(submitDebugLlmMessage.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(submitDebugLlmMessage.fulfilled, (state, action) => {
        state.loading = false;
        state.reply = action.payload.reply;
      })
      .addCase(submitDebugLlmMessage.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload || 'Unknown error.';
      });
  },
});

export const { resetSystemPrompt, updateMessage, updateSystemPrompt } = llmDebugSlice.actions;
export default llmDebugSlice.reducer;

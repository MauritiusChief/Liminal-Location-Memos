import { createAsyncThunk, createSlice, PayloadAction } from '@reduxjs/toolkit';
import { postChatMessage, type ChatResponse } from '../../api/chatApi';

// chat slice 只服务首页的简易聊天页。
// 它不再承担 normalization 或 raw overpass 的状态，职责非常单一：
// 当前输入、请求中状态、最后一条回复、错误信息。
interface ChatState {
  message: string;
  loading: boolean;
  reply: string | null;
  error: string | null;
}

const initialState: ChatState = {
  message: '',
  loading: false,
  reply: null,
  error: null,
};

// 这个 thunk 负责“把首页输入发给 /api/chat，再把回复带回 Redux”。
// createAsyncThunk 会自动生成 pending / fulfilled / rejected 三个阶段。
export const submitChatMessage = createAsyncThunk<ChatResponse, string, { rejectValue: string }>(
  'chat/submitChatMessage',
  async (message, { rejectWithValue }) => {
    const trimmedMessage = message.trim();

    if (!trimmedMessage) {
      return rejectWithValue('Message is required.');
    }

    try {
      return await postChatMessage(trimmedMessage);
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : 'Unknown error.');
    }
  },
);

const chatSlice = createSlice({
  name: 'chat',
  initialState,
  reducers: {
    // 同步 reducer 只处理输入框这种即时状态。
    updateMessage(state, action: PayloadAction<string>) {
      state.message = action.payload;
    },
  },
  extraReducers: (builder) => {
    // 异步请求的三个阶段统一写在 extraReducers 里：
    // pending 开启 loading，fulfilled 写入 reply，rejected 写入 error。
    builder
      .addCase(submitChatMessage.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(submitChatMessage.fulfilled, (state, action) => {
        state.loading = false;
        state.reply = action.payload.reply;
      })
      .addCase(submitChatMessage.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload || 'Unknown error.';
      });
  },
});

export const { updateMessage } = chatSlice.actions;
export default chatSlice.reducer;

import { createAsyncThunk, createSlice, PayloadAction } from '@reduxjs/toolkit';
import { submitChat, type ChatResponse } from '../../api/chatApi';
import type { RootState } from '../../app/store';

type RequestStatus = 'idle' | 'loading' | 'succeeded' | 'failed';

interface ChatRequestState {
  status: RequestStatus;
  error: string | null;
  reply: string | null;
}

// 首页聊天页的 Redux 状态只保留三类信息：
// 1. 用户正在编辑的输入框内容
// 2. 当前请求处于什么阶段
// 3. 后端返回的最后一次回复
// 这样页面组件只负责渲染，状态变化统一交给 slice 管理。
interface ChatState {
  message: string;
  request: ChatRequestState;
}

const initialState: ChatState = {
  message: '',
  request: {
    status: 'idle',
    error: null,
    reply: null,
  },
};

// 这个 thunk 负责把首页输入发送给 /api/chat。
// 组件先 dispatch 它，Redux Toolkit 会自动派生 pending / fulfilled / rejected 三个阶段，
// extraReducers 再根据这三个阶段回写 loading、reply 和 error。
export const submitChatMessage = createAsyncThunk<ChatResponse, string, { rejectValue: string }>(
  'chat/submitChatMessage',
  async (message, { rejectWithValue }) => {
    const trimmedMessage = message.trim();

    if (!trimmedMessage) {
      return rejectWithValue('Message is required.');
    }

    try {
      return await submitChat({ message: trimmedMessage });
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : 'Unknown error.');
    }
  },
);

const chatSlice = createSlice({
  name: 'chat',
  initialState,
  reducers: {
    // 同步 reducer 专门处理“用户输入过程中立刻更新状态”的场景。
    // 组件不会直接改 state.message，而是 dispatch 一个 action，请 reducer 来改。
    setMessage(state, action: PayloadAction<string>) {
      state.message = action.payload;
    },
  },
  extraReducers: (builder) => {
    // extraReducers 只处理异步 thunk 的生命周期。
    // pending 表示请求开始，fulfilled 表示成功写入 reply，rejected 表示失败写入 error。
    builder
      .addCase(submitChatMessage.pending, (state) => {
        state.request.status = 'loading';
        state.request.error = null;
      })
      .addCase(submitChatMessage.fulfilled, (state, action) => {
        state.request.status = 'succeeded';
        state.request.reply = action.payload.reply;
      })
      .addCase(submitChatMessage.rejected, (state, action) => {
        state.request.status = 'failed';
        state.request.error = action.payload || 'Unknown error.';
      });
  },
});

// selector 的作用是把“组件需要读什么状态”集中声明出来。
// 页面只调用 selector，不需要知道 store 里更深层的字段路径细节。
export const selectChatState = (state: RootState) => state.chat;

export const { setMessage } = chatSlice.actions;
export default chatSlice.reducer;

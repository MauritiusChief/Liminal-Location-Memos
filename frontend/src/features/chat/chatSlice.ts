import { createAsyncThunk, createSlice, PayloadAction } from '@reduxjs/toolkit';
import { postChatMessage } from '../../api/chatApi';

// ChatState 描述了 chat 这块状态分片的结构。
// 因为 store.ts 里把它注册为 chat，所以它最终会出现在 state.chat 中。
interface ChatState {
  // input: 当前文本框里正在输入的内容。
  input: string;
  // loading: 是否正在等待异步请求返回。
  loading: boolean;
  // response: 后端成功返回的消息内容。
  response: string;
  // error: 请求失败时保存错误信息，没有错误时为 null。
  error: string | null;
}

// initialState 是 chat 这块状态的初始值。
// 当应用第一次加载时，Redux 会先使用这里的默认数据。
const initialState: ChatState = {
  input: '',
  loading: false,
  response: '',
  error: null,
};

// submitMessage 是一个异步 thunk action。
// 它负责处理“提交消息给后端”这件异步工作，并自动生成 pending / fulfilled / rejected 三种状态。
export const submitMessage = createAsyncThunk<string, string, { rejectValue: string }>(
  // 这是 action type 的前缀，最终会扩展成 chat/submitMessage/pending 等形式。
  'chat/submitMessage',
  async (message, { rejectWithValue }) => {
    // 先去掉首尾空格，避免只输入空白字符也发请求。
    const trimmedMessage = message.trim();

    if (!trimmedMessage) {
      // rejectWithValue 可以返回一个自定义错误信息，
      // 这样在 rejected 阶段就能通过 action.payload 取到它。
      return rejectWithValue('Message is required.');
    }

    try {
      // 调用 API，把用户输入发送到后端。
      const result = await postChatMessage(trimmedMessage);
      // fulfilled 时，这个返回值会成为 action.payload。
      return result.reply;
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
    // 这里的 updateInput 表示：用户输入变化时，更新 state.input。
    updateInput(state, action: PayloadAction<string>) {
      state.input = action.payload;
    },
  },
  extraReducers: (builder) => {
    // extraReducers 用来处理当前 slice 自己定义之外的 actions，
    // 这里主要处理 submitMessage 这个异步 thunk 的三种阶段。
    builder
      .addCase(submitMessage.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(submitMessage.fulfilled, (state, action) => {
        state.loading = false;
        state.response = action.payload;
      })
      .addCase(submitMessage.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload || 'Unknown error.';
      });
  },
});

// chatSlice.actions 里会自动生成与 reducers 同名的 action creator。
export const { updateInput } = chatSlice.actions;

// 默认导出 reducer，供 store.ts 注册到 Redux store 中。
// store.ts 里把它命名为 chatReducer 导入，再挂到 reducer.chat 上。
export default chatSlice.reducer;

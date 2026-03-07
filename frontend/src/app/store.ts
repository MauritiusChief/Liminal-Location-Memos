import { configureStore } from '@reduxjs/toolkit';
import chatReducer from '../features/chat/chatSlice';

// 这个文件负责创建整个应用的 Redux store。
// 你可以把 store 理解成“全局状态仓库”，应用里共享的数据会放在这里管理。
export const store = configureStore({
  // reducer 用来告诉 Redux：全局状态由哪些“状态分片”组成。
  reducer: {
    // chat 这块状态交给 chatReducer 管理。
    // 所以之后可以通过 state.chat 读取这部分数据。
    chat: chatReducer,
  },
});

// RootState 是整个 Redux 状态树的类型。
// 当你在 useSelector 里写 state 时，state 的类型就是 RootState。
export type RootState = ReturnType<typeof store.getState>;

// AppDispatch 是当前 store 的 dispatch 函数类型。
// 这样 dispatch 普通 action 或异步 thunk 时，TypeScript 都能给出正确提示。
export type AppDispatch = typeof store.dispatch;

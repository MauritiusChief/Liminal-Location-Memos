import { configureStore } from '@reduxjs/toolkit';
import chatReducer from '../features/chat/chatSlice';

// store 可以理解为整个前端应用的“全局状态仓库”。
// 当前项目只注册了一个 slice：chat。
export const store = configureStore({
  reducer: {
    // 这里的 key 会决定状态树里的访问路径。
    // 也就是说，组件里读取这块状态时要用 state.chat。
    chat: chatReducer,
  },
});

// RootState 表示整个 Redux 状态树的类型。
// 在 useSelector 里，state 的类型就是它。
export type RootState = ReturnType<typeof store.getState>;

// AppDispatch 表示当前 store 的 dispatch 类型。
// 有了它，dispatch thunk 时 TypeScript 才能正确推断返回值和参数。
export type AppDispatch = typeof store.dispatch;

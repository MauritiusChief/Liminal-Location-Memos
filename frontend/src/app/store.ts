import { configureStore } from '@reduxjs/toolkit';
import chatReducer from '../features/chat/chatSlice';
import llmDebugReducer from '../features/llmDebug/llmDebugSlice';
import normalizationDebugReducer from '../features/normalizationDebug/normalizationDebugSlice';
import rawOverpassDebugReducer from '../features/rawOverpassDebug/rawOverpassDebugSlice';

// store 是 Redux 的全局状态仓库。
// configureStore 会把多个 feature slice 组合成一棵状态树，
// 页面之后通过 selector 读取自己那一块状态，而不是互相直接共享局部变量。
export const store = configureStore({
  reducer: {
    chat: chatReducer,
    normalizationDebug: normalizationDebugReducer,
    rawOverpassDebug: rawOverpassDebugReducer,
    llmDebug: llmDebugReducer,
  },
});

// RootState 表示“整个 store 长什么样”。
// 任何 selector 只要接收 state，它的类型都应该基于 RootState 推导。
export type RootState = ReturnType<typeof store.getState>;

// AppDispatch 表示当前 store 支持派发哪些 action / thunk。
// useAppDispatch 用它做类型约束后，组件 dispatch 异步 thunk 时才会有完整提示。
export type AppDispatch = typeof store.dispatch;

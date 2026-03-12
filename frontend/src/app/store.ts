import { configureStore } from '@reduxjs/toolkit';
import chatReducer from '../features/chat/chatSlice';
import debugReducer from '../features/debug/debugSlice';
import llmDebugReducer from '../features/llmDebug/llmDebugSlice';
import syncOverpassDebugReducer from '../features/syncOverpassDebug/syncOverpassDebugSlice';

// store 是整个前端应用的全局状态仓库。
// 现在它分成两块：
// 1. chat：首页单轮 LLM 聊天
// 2. debug：normalization 和 raw overpass 两个调试页面
export const store = configureStore({
  reducer: {
    chat: chatReducer,
    debug: debugReducer,
    llmDebug: llmDebugReducer,
    syncOverpassDebug: syncOverpassDebugReducer,
  },
});

// RootState 表示整个 Redux 状态树的类型。
// 组件里用 useAppSelector 时，state 的类型就是它。
export type RootState = ReturnType<typeof store.getState>;

// AppDispatch 表示当前 store 的 dispatch 类型。
// 有了它，dispatch thunk 时 TypeScript 才能正确知道返回值和参数。
export type AppDispatch = typeof store.dispatch;

import React from 'react';
import ReactDOM from 'react-dom/client';
import { Provider } from 'react-redux';
import { RouterProvider } from 'react-router-dom';
import { router } from './app/routes';
import { store } from './app/store';

// 入口文件只做两件事：
// 1. 用 Provider 把 Redux store 注入整棵组件树
// 2. 用 RouterProvider 挂上页面路由
// 这样任何页面组件都能同时访问全局状态和当前路由。
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Provider store={store}>
      <RouterProvider router={router} />
    </Provider>
  </React.StrictMode>,
);

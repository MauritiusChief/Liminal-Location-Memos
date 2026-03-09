import React from 'react';
import ReactDOM from 'react-dom/client';
import { Provider } from 'react-redux';
import App from './App';
import { store } from './app/store';

// Provider 的作用是把 Redux store 注入整个 React 组件树。
// 没有这一层的话，下面的组件就不能使用 useAppDispatch / useAppSelector。
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Provider store={store}>
      <App />
    </Provider>
  </React.StrictMode>,
);

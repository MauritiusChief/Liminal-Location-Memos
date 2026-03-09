import { useDispatch, useSelector } from 'react-redux';
import type { AppDispatch, RootState } from './store';

// React Redux 原生 hooks 本身是通用的。
// 这里封装成项目专用版本后，组件里就不需要每次手写类型。
export const useAppDispatch = useDispatch.withTypes<AppDispatch>();

// useAppSelector 会把 selector 里的 state 自动推断成 RootState。
// 这样访问 state.chat 之类的字段时会有完整类型提示。
export const useAppSelector = useSelector.withTypes<RootState>();

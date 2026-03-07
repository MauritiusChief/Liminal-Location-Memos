import { useDispatch, useSelector } from 'react-redux';
import type { AppDispatch, RootState } from './store';

// 这个文件把 React Redux 自带的 hooks 封装成“带类型的项目专用版本”。
// 这样在组件里使用时，TypeScript 能自动知道 dispatch 和 state 的类型。
// useAppDispatch 用来替代直接使用 useDispatch。
// 好处是返回的 dispatch 已经带上 AppDispatch 类型，不需要你在每个组件里重复声明。
export const useAppDispatch = useDispatch.withTypes<AppDispatch>();

// useAppSelector 用来替代直接使用 useSelector。
// 好处是 selector 里的 state 会自动推断成 RootState，读取 state.chat 这类字段时更安全。
export const useAppSelector = useSelector.withTypes<RootState>();

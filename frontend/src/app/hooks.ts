import { useDispatch, useSelector } from 'react-redux';
import type { AppDispatch, RootState } from './store';

// React Redux 原生 hooks 本身是通用版。
// 这里包一层项目专用类型后，组件里拿到的 dispatch 和 state 都会自动带上正确类型。
export const useAppDispatch = useDispatch.withTypes<AppDispatch>();

// 这个 selector hook 会把回调里的 state 自动推断成 RootState。
// 因此页面里访问 state.chat / state.debug 时会有完整的类型提示。
export const useAppSelector = useSelector.withTypes<RootState>();

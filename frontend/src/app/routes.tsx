import { createBrowserRouter } from 'react-router-dom';
import App from '../App';
import { HomeChatPage } from '../pages/HomeChatPage';
import { LlmEnvironmentDebugPage } from '../pages/LlmEnvironmentDebugPage';
import { NormalizationDebugPage } from '../pages/NormalizationDebugPage';
import { RawOverpassDebugPage } from '../pages/RawOverpassDebugPage';

export const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      {
        index: true,
        element: <HomeChatPage />,
      },
      {
        path: 'debug/normalization',
        element: <NormalizationDebugPage />,
      },
      {
        path: 'debug/overpass',
        element: <RawOverpassDebugPage />,
      },
      {
        path: 'debug/llm-environment',
        element: <LlmEnvironmentDebugPage />,
      },
    ],
  },
]);

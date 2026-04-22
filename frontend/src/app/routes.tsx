import { createBrowserRouter } from 'react-router-dom';
import App from '../App';
import { BuildingSchemaDebugPage } from '../pages/BuildingSchemaDebugPage';
import { HomeChatPage } from '../pages/HomeChatPage';
import { LlmEnvironmentDebugPage } from '../pages/LlmEnvironmentDebugPage';
import { NormalizationDebugPage } from '../pages/NormalizationDebugPage';
import { RawOverpassDebugPage } from '../pages/RawOverpassDebugPage';
import { SummaryPreviewPage } from '../pages/SummaryPreviewPage';

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
        path: 'debug/scene-prompt-preview',
        element: <SummaryPreviewPage />,
      },
      {
        path: 'debug/llm-environment',
        element: <LlmEnvironmentDebugPage />,
      },
      {
        path: 'debug/building-schema',
        element: <BuildingSchemaDebugPage />,
      },
    ],
  },
]);

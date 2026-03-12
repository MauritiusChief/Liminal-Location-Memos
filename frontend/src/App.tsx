import { NavLink, Outlet } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { fetchHealth, type HealthResponse } from './api/chatApi';

function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);

  useEffect(() => {
    fetchHealth()
      .then((result) => {
        setHealth(result);
        setHealthError(null);
      })
      .catch(() => {
        setHealth(null);
        setHealthError('Backend unavailable');
      });
  }, []);

  const healthSummary = healthError
    ? healthError
    : health
      ? [
          `backend: ${health.ok ? `${health.service} online` : 'unavailable'}`,
          `database enabled: ${health.database.enabled ? 'yes' : 'no'}`,
          `database ok: ${health.database.ok ? 'yes' : 'no'}`,
          'tableNames' in health.database && health.database.tableNames
            ? `tables: ${health.database.tableNames}`
            : 'reason' in health.database
              ? `reason: ${health.database.reason}`
              : null,
        ]
          .filter(Boolean)
          .join(' | ')
      : 'Checking backend...';

  return (
    <main style={{ padding: '16px', fontFamily: 'sans-serif' }}>
      <header style={{ marginBottom: '24px' }}>
        <h1>Liminal Location Memos</h1>
        <p>System status: {healthSummary}</p>
        <nav style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
          <NavLink to="/" end>
            Chat
          </NavLink>
          <NavLink to="/debug/normalization">Debug / Normalization</NavLink>
          <NavLink to="/debug/sync-overpass">Debug / Sync Overpass</NavLink>
          <NavLink to="/debug/overpass">Debug / Overpass</NavLink>
          <NavLink to="/debug/llm-environment">Debug / LLM Environment</NavLink>
        </nav>
      </header>
      <Outlet />
    </main>
  );
}

export default App;

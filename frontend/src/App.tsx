import { NavLink, Outlet } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { fetchHealth } from './api/chatApi';

function App() {
  const [health, setHealth] = useState<string>('Checking backend...');

  useEffect(() => {
    fetchHealth()
      .then((result) => setHealth(result.ok ? `${result.service} online` : 'Backend unavailable'))
      .catch(() => setHealth('Backend unavailable'));
  }, []);

  return (
    <main style={{ padding: '16px', fontFamily: 'sans-serif' }}>
      <header style={{ marginBottom: '24px' }}>
        <h1>Liminal Location Memos</h1>
        <p>Backend status: {health}</p>
        <nav style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
          <NavLink to="/" end>
            Chat
          </NavLink>
          <NavLink to="/debug/normalization">Debug / Normalization</NavLink>
          <NavLink to="/debug/overpass">Debug / Overpass</NavLink>
        </nav>
      </header>
      <Outlet />
    </main>
  );
}

export default App;

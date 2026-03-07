import { SubmitEvent, useEffect, useState } from 'react';
import { useAppDispatch, useAppSelector } from './app/hooks';
import { submitMessage, updateInput } from './features/chat/chatSlice';
import { fetchHealth } from './api/chatApi';

function App() {
  const dispatch = useAppDispatch();
  const { input, loading, response, error } = useAppSelector((state) => state.chat);
  const [health, setHealth] = useState<string>('Checking backend...');

  useEffect(() => {
    fetchHealth()
      .then((result) => setHealth(result.ok ? `${result.service} online` : 'Backend unavailable'))
      .catch(() => setHealth('Backend unavailable'));
  }, []);

  const handleSubmit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    await dispatch(submitMessage(input));
  };

  return (
    <main>
      <h1>React + Redux + TypeScript Template</h1>
      <p>Backend status: {health}</p>

      <form onSubmit={handleSubmit}>
        <label htmlFor="message">Message</label>
        <br />
        <textarea
          id="message"
          rows={8}
          cols={60}
          value={input}
          onChange={(event) => dispatch(updateInput(event.target.value))}
        />
        <br />
        <button type="submit" disabled={loading}>
          {loading ? 'Sending...' : 'Send'}
        </button>
      </form>

      <section>
        <h2>Response</h2>
        <pre>{response || 'No response yet.'}</pre>
      </section>

      {error ? (
        <section>
          <h2>Error</h2>
          <pre>{error}</pre>
        </section>
      ) : null}
    </main>
  );
}

export default App;


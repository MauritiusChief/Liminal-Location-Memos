import { FormEvent } from 'react';
import { useAppDispatch, useAppSelector } from '../app/hooks';
import { submitChatMessage, updateMessage } from '../features/chat/chatSlice';

export function HomeChatPage() {
  const dispatch = useAppDispatch();
  const { message, loading, reply, error } = useAppSelector((state) => state.chat);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await dispatch(submitChatMessage(message));
  };

  return (
    <section>
      <h2>LLM Chat</h2>
      <form onSubmit={handleSubmit}>
        <label htmlFor="chatMessage">Message</label>
        <br />
        <textarea
          id="chatMessage"
          rows={8}
          cols={80}
          value={message}
          onChange={(event) => dispatch(updateMessage(event.target.value))}
          placeholder="Ask the LLM about a place, route, or memo."
        />
        <br />
        <button type="submit" disabled={loading}>
          {loading ? 'Sending...' : 'Send'}
        </button>
      </form>

      <h3>Reply</h3>
      <pre style={{ border: '1px solid', minHeight: '160px', padding: '8px', whiteSpace: 'pre-wrap' }}>
        {reply || 'No reply yet.'}
      </pre>

      {error ? (
        <section>
          <h3>Error</h3>
          <pre>{error}</pre>
        </section>
      ) : null}
    </section>
  );
}

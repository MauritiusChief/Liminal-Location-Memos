import { FormEvent } from 'react';
import { useAppDispatch, useAppSelector } from '../app/hooks';
import { selectChatState, setMessage, submitChatMessage } from '../features/chat/chatSlice';

export function HomeChatPage() {
  const dispatch = useAppDispatch();
  const { message, request } = useAppSelector(selectChatState);

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
          onChange={(event) => dispatch(setMessage(event.target.value))}
          placeholder="Ask the LLM about a place, route, or memo."
        />
        <br />
        <button type="submit" disabled={request.status === 'loading'}>
          {request.status === 'loading' ? 'Sending...' : 'Send'}
        </button>
      </form>

      <h3>Reply</h3>
      <pre style={{ border: '1px solid', minHeight: '160px', padding: '8px', whiteSpace: 'pre-wrap' }}>
        {request.reply || 'No reply yet.'}
      </pre>

      {request.error ? (
        <section>
          <h3>Error</h3>
          <pre>{request.error}</pre>
        </section>
      ) : null}
    </section>
  );
}

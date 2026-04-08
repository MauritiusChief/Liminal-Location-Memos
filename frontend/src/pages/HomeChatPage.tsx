import { FormEvent, useEffect } from 'react';
import { useAppDispatch, useAppSelector } from '../app/hooks';
import {
  hydrateStoredSessionId,
  restoreStoredSession,
  selectChatState,
  setMessage,
  startGame,
  submitChatMessage,
} from '../features/chat/chatSlice';

export function HomeChatPage() {
  const dispatch = useAppDispatch();
  const {
    message,
    session,
    hasStarted,
    detectedStoredSessionId,
    hasCheckedStoredSessionId,
    request,
  } = useAppSelector(selectChatState);

  const activeOutdoorVisualDescriptions = session
    ? session.activeOutdoorVisualDescriptions
        .map((id) => session.outdoorVisualDescriptions[id])
        .filter((record): record is NonNullable<typeof record> => Boolean(record))
    : [];

  useEffect(() => {
    if (!hasCheckedStoredSessionId) {
      void dispatch(hydrateStoredSessionId());
    }
  }, [dispatch, hasCheckedStoredSessionId]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await dispatch(submitChatMessage());
  };

  return (
    <section>
      <h2>Game Chat</h2>
      <div style={{ display: 'grid', gap: '16px', gridTemplateColumns: 'minmax(0, 2fr) minmax(320px, 1fr)' }}>
        <section>
          <div style={{ border: '1px solid', minHeight: '240px', padding: '8px' }}>
            {session?.messageHistory.length ? session.messageHistory.map((entry, index) => (
              <article key={`${entry.role}-${index}`} style={{ marginBottom: '12px' }}>
                <strong>{entry.role === 'player' ? 'You' : 'Book'}</strong>
                <pre style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap' }}>{entry.content}</pre>
              </article>
            )) : 'No messages yet.'}
          </div>

          {hasStarted ? (
            <form onSubmit={handleSubmit} style={{ marginTop: '16px' }}>
              <label htmlFor="chatMessage">Message</label>
              <br />
              <textarea
                id="chatMessage"
                rows={8}
                cols={80}
                value={message}
                onChange={(event) => dispatch(setMessage(event.target.value))}
                placeholder="Tell the book what you do next."
              />
              <br />
              <button type="submit" disabled={request.status === 'loading'}>
                {request.status === 'loading' ? 'Sending...' : 'Send'}
              </button>
            </form>
          ) : (
            <section style={{ marginTop: '16px' }}>
              {detectedStoredSessionId ? (
                <div style={{ marginBottom: '12px' }}>
                  <p>检测到已有存档。</p>
                  <button
                    type="button"
                    onClick={() => void dispatch(restoreStoredSession())}
                    disabled={request.status === 'loading'}
                    style={{ marginRight: '8px' }}
                  >
                    {request.status === 'loading' ? 'Restoring...' : '读取检测到的存档'}
                  </button>
                </div>
              ) : null}
              <button type="button" onClick={() => void dispatch(startGame())} disabled={request.status === 'loading'}>
                {request.status === 'loading' ? 'Starting...' : '开始游戏'}
              </button>
            </section>
          )}
        </section>

        <aside style={{ border: '1px solid', padding: '12px' }}>
          <h3>Debug</h3>
          <p>
            Current position:{' '}
            {session
              ? `${session.playerPosition.lat.toFixed(6)}, ${session.playerPosition.lon.toFixed(6)}`
              : 'Unknown'}
          </p>
          <p>
            Current orientation:{' '}
            {session ? `${Math.round(session.playerOrientation)}°` : 'Unknown'}
          </p>
          <h4>Active Outdoor Visual Descriptions</h4>
          <div>
            {activeOutdoorVisualDescriptions.length ? activeOutdoorVisualDescriptions.map((record) => (
              <article key={record.id} style={{ marginBottom: '12px' }}>
                <div>
                  <strong>{record.center.lat.toFixed(6)}, {record.center.lon.toFixed(6)}</strong>
                </div>
                <pre style={{ margin: '4px 0', whiteSpace: 'pre-wrap' }}>{record.content}</pre>
              </article>
            )) : 'No active outdoor visual descriptions yet.'}
          </div>
        </aside>
      </div>

      {request.error ? (
        <section>
          <h3>Error</h3>
          <pre>{request.error}</pre>
        </section>
      ) : null}
    </section>
  );
}

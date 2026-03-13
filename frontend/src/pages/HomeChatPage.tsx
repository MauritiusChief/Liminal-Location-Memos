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
import {
  findLatestMovementFromMessages,
  formatMovePlayerToolMessage,
  parseMovePlayerToolMessage,
  shouldDisplayGameMessage,
} from '../features/chat/messagePresentation';

export function HomeChatPage() {
  const dispatch = useAppDispatch();
  const {
    message,
    messages,
    hasStarted,
    detectedStoredSessionId,
    hasCheckedStoredSessionId,
    playerPosition,
    activeLargeDescription,
    nearbySmallDescriptions,
    request,
  } = useAppSelector(selectChatState);
  const latestMovementResult = findLatestMovementFromMessages(messages);
  const visibleMessages = messages.filter(shouldDisplayGameMessage);

  useEffect(() => {
    if (!hasCheckedStoredSessionId) {
      void dispatch(hydrateStoredSessionId());
    }
  }, [dispatch, hasCheckedStoredSessionId]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await dispatch(submitChatMessage());
  };

  const handleStartGame = async () => {
    await dispatch(startGame());
  };

  const handleRestoreStoredSession = async () => {
    await dispatch(restoreStoredSession());
  };

  return (
    <section>
      <h2>Game Chat</h2>
      {/* 左侧是消息流，右侧是世界状态的 debug 面板。 */}
      <div style={{ display: 'grid', gap: '16px', gridTemplateColumns: 'minmax(0, 2fr) minmax(320px, 1fr)' }}>
        <section>
          <div style={{ border: '1px solid', minHeight: '240px', padding: '8px' }}>
            {visibleMessages.length > 0 ? visibleMessages.map((entry, index) => {
              const movement = parseMovePlayerToolMessage(entry);
              if (movement) {
                return (
                  <article
                    key={`${entry.role}-${index}`}
                    style={{ marginBottom: '12px', color: '#666', fontStyle: 'italic' }}
                  >
                    <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{formatMovePlayerToolMessage(movement)}</pre>
                  </article>
                );
              }

              return (
                <article key={`${entry.role}-${index}`} style={{ marginBottom: '12px' }}>
                  <strong>{entry.role === 'user' ? 'You' : 'World'}</strong>
                  <pre style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap' }}>{entry.content}</pre>
                </article>
              );
            }) : 'No messages yet.'}
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
                placeholder="Ask the LLM about the world, or tell it where to move."
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
                    onClick={() => void handleRestoreStoredSession()}
                    disabled={request.status === 'loading'}
                    style={{ marginRight: '8px' }}
                  >
                    {request.status === 'loading' ? 'Restoring...' : '读取检测到的存档'}
                  </button>
                </div>
              ) : null}
              <button type="button" onClick={() => void handleStartGame()} disabled={request.status === 'loading'}>
                {request.status === 'loading' ? 'Starting...' : '开始游戏'}
              </button>
            </section>
          )}
        </section>

        <aside style={{ border: '1px solid', padding: '12px' }}>
          <h3>Debug</h3>
          {/* 当前经纬度、大描述和小描述都会直接展示，方便校验后端回合逻辑。 */}
          <p>
            Current position:{' '}
            {playerPosition
              ? `${playerPosition.lat.toFixed(6)}, ${playerPosition.lon.toFixed(6)}`
              : 'Unknown'}
          </p>
          <h4>Current Large Description</h4>
          <pre style={{ whiteSpace: 'pre-wrap' }}>
            {activeLargeDescription?.descriptionText || 'No large description yet.'}
          </pre>
          <h4>Nearby Small Descriptions (200m)</h4>
          <div>
            {nearbySmallDescriptions.length > 0 ? nearbySmallDescriptions.map((record) => (
              <article key={record.id} style={{ marginBottom: '12px' }}>
                <div>
                  <strong>{record.distanceMeters !== undefined ? `${Math.round(record.distanceMeters)}m` : 'distance n/a'}</strong>
                </div>
                <pre style={{ margin: '4px 0', whiteSpace: 'pre-wrap' }}>{record.descriptionText}</pre>
              </article>
            )) : 'No small descriptions yet.'}
          </div>
          <h4>Latest Movement</h4>
          <pre style={{ whiteSpace: 'pre-wrap' }}>
            {latestMovementResult
              ? `bearing=${Math.round(latestMovementResult.bearingDegrees)}°, distance=${Math.round(latestMovementResult.distanceMeters)}m`
              : 'No movement yet.'}
          </pre>
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

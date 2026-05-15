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
    streamingBookMessage,
    hasStarted,
    detectedStoredSessionId,
    hasCheckedStoredSessionId,
    request,
  } = useAppSelector(selectChatState);

  const activeFieldVisualDescriptions = session
    ? session.activeFieldVisualDescriptions
        .map((id) => session.fieldVisualDescriptions[id])
        .filter((record): record is NonNullable<typeof record> => Boolean(record))
    : [];
  const activeExteriorVisualDescriptions = session
    ? session.activeExteriorVisualDescriptions
        .map((buildingId) => session.exteriorVisualDescriptions[buildingId])
        .filter((record): record is NonNullable<typeof record> => Boolean(record))
    : [];
  const activeRoomVisualDescriptions = session
    ? session.activeRoomVisualDescriptions
        .map((id) => session.roomVisualDescriptions[id])
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

  const canSubmitMessage = hasStarted
    && !request.activeBookStream
    && !session?.hasQueuedPlayerMessage;
  const isBusy = request.status === 'loading';
  const isStarting = isBusy && request.activeAction === 'start';
  const isRestoring = isBusy && request.activeAction === 'restore';

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
            {streamingBookMessage ? (
              <article style={{ marginBottom: '12px' }}>
                <strong>Book</strong>
                <pre style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap' }}>{streamingBookMessage}</pre>
              </article>
            ) : null}
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
              <button type="submit" disabled={!canSubmitMessage}>
                {request.activeBookStream
                  ? 'Streaming...'
                  : session?.hasQueuedPlayerMessage
                    ? 'Queued'
                    : 'Send'}
              </button>
              {session?.pendingVisualDescription ? (
                <p>Visual Description 正在后台更新。此时允许再发送 1 条消息排队。</p>
              ) : null}
              {session?.hasQueuedPlayerMessage ? (
                <p>已存在 1 条排队消息，后台准备完成前不会再接受新的输入。</p>
              ) : null}
            </form>
          ) : (
            <section style={{ marginTop: '16px' }}>
              {detectedStoredSessionId ? (
                <div style={{ marginBottom: '12px' }}>
                  <p>检测到已有存档。</p>
                  <button
                    type="button"
                    onClick={() => void dispatch(restoreStoredSession())}
                    disabled={isBusy}
                    style={{ marginRight: '8px' }}
                  >
                    {isRestoring ? 'Restoring...' : '读取检测到的存档'}
                  </button>
                  <button type="button" onClick={() => void dispatch(startGame())} disabled={isBusy}>
                    {isStarting ? 'Starting...' : '新游戏'}
                  </button>
                </div>
              ) : (
                <button type="button" onClick={() => void dispatch(startGame())} disabled={isBusy}>
                  {isStarting ? 'Starting...' : '开始游戏'}
                </button>
              )}
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
          <p>
            Pending Visual Description:{' '}
            {session?.pendingVisualDescription ? 'Yes' : 'No'}
          </p>
          <p>
            Queued Next Turn:{' '}
            {session?.hasQueuedPlayerMessage ? 'Yes' : 'No'}
          </p>
          <h4>Active Field Visual Descriptions</h4>
          <div>
            {activeFieldVisualDescriptions.length ? activeFieldVisualDescriptions.map((record) => (
              <article key={record.id} style={{ marginBottom: '12px' }}>
                <div>
                  <strong>{record.center.lat.toFixed(6)}, {record.center.lon.toFixed(6)}</strong>
                </div>
                <pre style={{ margin: '4px 0', whiteSpace: 'pre-wrap' }}>{record.content}</pre>
              </article>
            )) : 'No active field visual descriptions yet.'}
          </div>
          <h4>Active Exterior Visual Descriptions</h4>
          <div>
            {activeExteriorVisualDescriptions.length ? activeExteriorVisualDescriptions.map((record) => (
              <article key={record.buildingId} style={{ marginBottom: '12px' }}>
                <div>
                  <strong>{record.buildingId}</strong>
                </div>
                <pre style={{ margin: '4px 0', whiteSpace: 'pre-wrap' }}>{record.content}</pre>
              </article>
            )) : 'No active exterior visual descriptions yet.'}
          </div>
          <h4>Active Room Visual Descriptions</h4>
          <div>
            {activeRoomVisualDescriptions.length ? activeRoomVisualDescriptions.map((record, index) => (
              <article
                key={`${record.buildingId}-${record.level}-${record.sectorName}-${index}`}
                style={{ marginBottom: '12px' }}
              >
                <div>
                  <strong>{record.buildingId}</strong>
                </div>
                <div>Level {record.level} / Sector {record.sectorName}</div>
                <pre style={{ margin: '4px 0', whiteSpace: 'pre-wrap' }}>{record.content}</pre>
              </article>
            )) : 'No active room visual descriptions yet.'}
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

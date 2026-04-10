import { createAsyncThunk, createSlice, PayloadAction } from '@reduxjs/toolkit';
import { fetchGameSession, streamGameStart, streamGameTurn } from '../../api/gameApi';
import type { GameSessionSnapshot, GameStreamEvent } from '../../api/gameTypes';
import type { AppDispatch, RootState } from '../../app/store';
import { readStoredSessionId, writeStoredSessionId } from './sessionStorage';

type RequestStatus = 'idle' | 'loading' | 'succeeded' | 'failed';

interface ChatRequestState {
  status: RequestStatus;
  error: string | null;
  activeBookStream: boolean;
}

interface ChatState {
  session: GameSessionSnapshot | null;
  message: string;
  streamingBookMessage: string | null;
  hasStarted: boolean;
  detectedStoredSessionId: string | null;
  hasCheckedStoredSessionId: boolean;
  request: ChatRequestState;
}

const initialState: ChatState = {
  session: null,
  message: '',
  streamingBookMessage: null,
  hasStarted: false,
  detectedStoredSessionId: null,
  hasCheckedStoredSessionId: false,
  request: {
    status: 'idle',
    error: null,
    activeBookStream: false,
  },
};

export const hydrateStoredSessionId = createAsyncThunk<string | null>(
  'chat/hydrateStoredSessionId',
  async () => readStoredSessionId(),
);

export const restoreStoredSession = createAsyncThunk<GameSessionSnapshot, void, { state: RootState; rejectValue: string }>(
  'chat/restoreStoredSession',
  async (_unused, { getState, rejectWithValue }) => {
    const { chat } = getState();
    const sessionId = chat.detectedStoredSessionId;

    if (!sessionId) {
      return rejectWithValue('No stored session detected.');
    }

    try {
      return await fetchGameSession(sessionId);
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : 'Unknown error.');
    }
  },
);

function applyLoadedSession(state: ChatState, session: GameSessionSnapshot): void {
  state.session = session;
  state.hasStarted = true;
  state.detectedStoredSessionId = session.sessionId;
  writeStoredSessionId(session.sessionId);
}

const chatSlice = createSlice({
  name: 'chat',
  initialState,
  reducers: {
    setMessage(state, action: PayloadAction<string>) {
      state.message = action.payload;
    },
    streamStarted(state) {
      state.request.status = 'loading';
      state.request.error = null;
      state.request.activeBookStream = true;
      state.streamingBookMessage = null;
    },
    playerMessageAccepted(state, action: PayloadAction<string>) {
      if (!state.session) {
        return;
      }

      state.session.messageHistory.push({
        role: 'player',
        content: action.payload,
      });
      state.message = '';
    },
    bookReplyDeltaReceived(state, action: PayloadAction<string>) {
      state.streamingBookMessage = `${state.streamingBookMessage ?? ''}${action.payload}`;
    },
    bookStreamFinished(state) {
      state.request.activeBookStream = false;
      state.request.status = 'succeeded';
    },
    sessionCommitted(state, action: PayloadAction<GameSessionSnapshot>) {
      applyLoadedSession(state, action.payload);
      state.request.status = 'succeeded';
      state.request.activeBookStream = false;
      state.streamingBookMessage = null;
      state.message = '';
    },
    visualDescriptionUpdated(state, action: PayloadAction<GameSessionSnapshot>) {
      applyLoadedSession(state, action.payload);
      state.request.status = 'succeeded';
    },
    queuedNextTurn(state, action: PayloadAction<{ queuedMessage: string; session: GameSessionSnapshot }>) {
      applyLoadedSession(state, action.payload.session);
      state.message = '';
      state.request.status = 'succeeded';
      state.request.activeBookStream = false;
    },
    queueRejected(state, action: PayloadAction<{ message: string; session: GameSessionSnapshot }>) {
      applyLoadedSession(state, action.payload.session);
      state.request.status = 'failed';
      state.request.error = action.payload.message;
      state.request.activeBookStream = false;
    },
    streamFailed(state, action: PayloadAction<string>) {
      state.request.status = 'failed';
      state.request.error = action.payload;
      state.request.activeBookStream = false;
      state.streamingBookMessage = null;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(hydrateStoredSessionId.fulfilled, (state, action) => {
        state.detectedStoredSessionId = action.payload;
        state.hasCheckedStoredSessionId = true;
      })
      .addCase(restoreStoredSession.pending, (state) => {
        state.request.status = 'loading';
        state.request.error = null;
      })
      .addCase(restoreStoredSession.fulfilled, (state, action) => {
        state.request.status = 'succeeded';
        applyLoadedSession(state, action.payload);
      })
      .addCase(restoreStoredSession.rejected, (state, action) => {
        state.request.status = 'failed';
        state.request.error = action.payload || 'Unknown error.';
      });
  },
});

function handleGameStreamEvent(dispatch: AppDispatch, event: GameStreamEvent): void {
  switch (event.type) {
    case 'player_message_accepted':
      dispatch(playerMessageAccepted(event.text));
      return;
    case 'book_reply_delta':
      dispatch(bookReplyDeltaReceived(event.text));
      return;
    case 'book_done':
      dispatch(bookStreamFinished());
      return;
    case 'session_committed':
      dispatch(sessionCommitted(event.session));
      return;
    case 'visual_description_done':
      dispatch(visualDescriptionUpdated(event.session));
      return;
    case 'queued_next_turn':
      dispatch(queuedNextTurn({ queuedMessage: event.queuedMessage, session: event.session }));
      return;
    case 'queue_rejected':
      dispatch(queueRejected({ message: event.message, session: event.session }));
      return;
    case 'visual_description_started':
      return;
    case 'error':
      throw new Error(event.message);
  }
}

export function startGame() {
  return async (dispatch: AppDispatch, getState: () => RootState): Promise<void> => {
    const beforeSubmit = getState().chat;
    if (beforeSubmit.request.activeBookStream) {
      return;
    }

    dispatch(streamStarted());

    try {
      await streamGameStart((event) => {
        handleGameStreamEvent(dispatch, event);
      });
    } catch (error) {
      dispatch(streamFailed(error instanceof Error ? error.message : 'Unknown error.'));
    }
  };
}

export function submitChatMessage() {
  return async (dispatch: AppDispatch, getState: () => RootState): Promise<void> => {
    const { chat } = getState();
    const trimmedMessage = chat.message.trim();
    const sessionId = chat.session?.sessionId;

    if (!trimmedMessage) {
      dispatch(streamFailed('Message is required.'));
      return;
    }

    if (!sessionId) {
      dispatch(streamFailed('Session is not started.'));
      return;
    }

    if (chat.request.activeBookStream) {
      return;
    }

    if (chat.session?.hasQueuedPlayerMessage) {
      dispatch(streamFailed('A queued player message is already waiting.'));
      return;
    }

    dispatch(streamStarted());

    try {
      await streamGameTurn({
        sessionId,
        message: trimmedMessage,
      }, (event) => {
        handleGameStreamEvent(dispatch, event);
      });
    } catch (error) {
      dispatch(streamFailed(error instanceof Error ? error.message : 'Unknown error.'));
    }
  };
}

export const selectChatState = (state: RootState) => state.chat;

export const {
  bookReplyDeltaReceived,
  bookStreamFinished,
  playerMessageAccepted,
  queueRejected,
  queuedNextTurn,
  sessionCommitted,
  setMessage,
  streamFailed,
  streamStarted,
  visualDescriptionUpdated,
} = chatSlice.actions;

export default chatSlice.reducer;

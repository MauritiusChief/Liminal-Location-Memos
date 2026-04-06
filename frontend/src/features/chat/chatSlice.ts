import { createAsyncThunk, createSlice, PayloadAction } from '@reduxjs/toolkit';
import { fetchGameSession, startGame as startGameRequest, submitGameTurn } from '../../api/gameApi';
import { readStoredSessionId, writeStoredSessionId } from './sessionStorage';
import type { GameSession } from '../../api/gameTypes';
import type { RootState } from '../../app/store';

type RequestStatus = 'idle' | 'loading' | 'succeeded' | 'failed';

interface ChatRequestState {
  status: RequestStatus;
  error: string | null;
}

interface ChatState {
  session: GameSession | null;
  message: string;
  hasStarted: boolean;
  detectedStoredSessionId: string | null;
  hasCheckedStoredSessionId: boolean;
  request: ChatRequestState;
}

const initialState: ChatState = {
  session: null,
  message: '',
  hasStarted: false,
  detectedStoredSessionId: null,
  hasCheckedStoredSessionId: false,
  request: {
    status: 'idle',
    error: null,
  },
};

export const submitChatMessage = createAsyncThunk<GameSession, void, { state: RootState; rejectValue: string }>(
  'chat/submitChatMessage',
  async (_unused, { getState, rejectWithValue }) => {
    const { chat } = getState();
    const trimmedMessage = chat.message.trim();
    const sessionId = chat.session?.sessionId;

    if (!trimmedMessage) {
      return rejectWithValue('Message is required.');
    }

    if (!sessionId) {
      return rejectWithValue('Session is not started.');
    }

    try {
      return await submitGameTurn({
        sessionId,
        message: trimmedMessage,
      });
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : 'Unknown error.');
    }
  },
);

export const hydrateStoredSessionId = createAsyncThunk<string | null>(
  'chat/hydrateStoredSessionId',
  async () => readStoredSessionId(),
);

export const startGame = createAsyncThunk<GameSession, void, { rejectValue: string }>(
  'chat/startGame',
  async (_unused, { rejectWithValue }) => {
    try {
      return await startGameRequest();
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : 'Unknown error.');
    }
  },
);

export const restoreStoredSession = createAsyncThunk<GameSession, void, { state: RootState; rejectValue: string }>(
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

function applyLoadedSession(state: ChatState, session: GameSession): void {
  state.session = session;
  state.hasStarted = true;
  state.detectedStoredSessionId = session.sessionId;
  state.message = '';
  writeStoredSessionId(session.sessionId);
}

const chatSlice = createSlice({
  name: 'chat',
  initialState,
  reducers: {
    setMessage(state, action: PayloadAction<string>) {
      state.message = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(submitChatMessage.pending, (state) => {
        state.request.status = 'loading';
        state.request.error = null;
      })
      .addCase(submitChatMessage.fulfilled, (state, action) => {
        state.request.status = 'succeeded';
        applyLoadedSession(state, action.payload);
      })
      .addCase(submitChatMessage.rejected, (state, action) => {
        state.request.status = 'failed';
        state.request.error = action.payload || 'Unknown error.';
      })
      .addCase(hydrateStoredSessionId.fulfilled, (state, action) => {
        state.detectedStoredSessionId = action.payload;
        state.hasCheckedStoredSessionId = true;
      })
      .addCase(startGame.pending, (state) => {
        state.request.status = 'loading';
        state.request.error = null;
      })
      .addCase(startGame.fulfilled, (state, action) => {
        state.request.status = 'succeeded';
        applyLoadedSession(state, action.payload);
      })
      .addCase(startGame.rejected, (state, action) => {
        state.request.status = 'failed';
        state.request.error = action.payload || 'Unknown error.';
        state.hasStarted = false;
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

export const selectChatState = (state: RootState) => state.chat;

export const { setMessage } = chatSlice.actions;
export default chatSlice.reducer;

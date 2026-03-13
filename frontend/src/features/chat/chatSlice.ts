import { createAsyncThunk, createSlice, PayloadAction } from '@reduxjs/toolkit';
import { submitGameChat } from '../../api/gameApi';
import { OPENING_GAME_PROMPT } from './openingPrompt';
import type {
  GameChatResponse,
  GameMessage,
  GamePosition,
  LargeDescriptionRecord,
  SmallDescriptionRecord,
  MovePlayerToolResult,
} from '../../api/sceneTypes';
import type { RootState } from '../../app/store';

type RequestStatus = 'idle' | 'loading' | 'succeeded' | 'failed';

interface ChatRequestState {
  status: RequestStatus;
  error: string | null;
}

interface ChatState {
  // 首页状态除了消息流，还额外保留“世界状态”：
  // 当前 session、玩家位置、大描述、小描述列表、最近移动结果。
  sessionId: string | null;
  message: string;
  messages: GameMessage[];
  hasStarted: boolean;
  playerPosition: GamePosition | null;
  activeLargeDescription: LargeDescriptionRecord | null;
  nearbySmallDescriptions: SmallDescriptionRecord[];
  latestMovementResult: MovePlayerToolResult | null;
  request: ChatRequestState;
}

const initialState: ChatState = {
  sessionId: null,
  message: '',
  messages: [],
  hasStarted: false,
  playerPosition: null,
  activeLargeDescription: null,
  nearbySmallDescriptions: [],
  latestMovementResult: null,
  request: {
    status: 'idle',
    error: null,
  },
};

export const submitChatMessage = createAsyncThunk<GameChatResponse, void, { state: RootState; rejectValue: string }>(
  'chat/submitChatMessage',
  async (_unused, { getState, rejectWithValue }) => {
    // thunk 直接从 Redux 里取当前输入和 sessionId，
    // 页面组件不需要关心请求体拼装细节。
    const { chat } = getState();
    const trimmedMessage = chat.message.trim();

    if (!trimmedMessage) {
      return rejectWithValue('Message is required.');
    }

    try {
      return await submitGameChat({
        sessionId: chat.sessionId || undefined,
        message: trimmedMessage,
      });
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : 'Unknown error.');
    }
  },
);

export const startGame = createAsyncThunk<GameChatResponse, void, { state: RootState; rejectValue: string }>(
  'chat/startGame',
  async (_unused, { getState, rejectWithValue }) => {
    const { chat } = getState();

    try {
      return await submitGameChat({
        sessionId: chat.sessionId || undefined,
        message: OPENING_GAME_PROMPT,
      });
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : 'Unknown error.');
    }
  },
);

const chatSlice = createSlice({
  name: 'chat',
  initialState,
  reducers: {
    setMessage(state, action: PayloadAction<string>) {
      state.message = action.payload;
    },
  },
  extraReducers: (builder) => {
    // fulfilled 时同时更新两条线：
    // 1. 对话消息流
    // 2. 世界状态 / debug 面板数据
    builder
      .addCase(submitChatMessage.pending, (state) => {
        state.request.status = 'loading';
        state.request.error = null;
      })
      .addCase(submitChatMessage.fulfilled, (state, action) => {
        const userMessage = state.message.trim();

        state.request.status = 'succeeded';
        state.hasStarted = true;
        state.sessionId = action.payload.sessionId;
        state.playerPosition = action.payload.playerPosition;
        state.activeLargeDescription = action.payload.activeLargeDescription;
        state.nearbySmallDescriptions = action.payload.nearbySmallDescriptions;
        state.latestMovementResult = action.payload.movementResult;
        state.messages.push(
          { role: 'user', content: userMessage },
          { role: 'assistant', content: action.payload.assistantMessage },
        );
        state.message = '';
      })
      .addCase(submitChatMessage.rejected, (state, action) => {
        state.request.status = 'failed';
        state.request.error = action.payload || 'Unknown error.';
      })
      .addCase(startGame.pending, (state) => {
        state.request.status = 'loading';
        state.request.error = null;
      })
      .addCase(startGame.fulfilled, (state, action) => {
        state.request.status = 'succeeded';
        state.hasStarted = true;
        state.sessionId = action.payload.sessionId;
        state.playerPosition = action.payload.playerPosition;
        state.activeLargeDescription = action.payload.activeLargeDescription;
        state.nearbySmallDescriptions = action.payload.nearbySmallDescriptions;
        state.latestMovementResult = action.payload.movementResult;
        state.messages.push(
          { role: 'assistant', content: action.payload.assistantMessage },
        );
      })
      .addCase(startGame.rejected, (state, action) => {
        state.request.status = 'failed';
        state.request.error = action.payload || 'Unknown error.';
        state.hasStarted = false;
      });
  },
});

export const selectChatState = (state: RootState) => state.chat;

export const { setMessage } = chatSlice.actions;
export default chatSlice.reducer;

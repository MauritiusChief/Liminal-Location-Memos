import { createAsyncThunk, createSlice, PayloadAction } from '@reduxjs/toolkit';
import { postChatMessage } from '../../api/chatApi';

interface ChatState {
  input: string;
  loading: boolean;
  response: string;
  error: string | null;
}

const initialState: ChatState = {
  input: '',
  loading: false,
  response: '',
  error: null,
};

export const submitMessage = createAsyncThunk<string, string, { rejectValue: string }>(
  'chat/submitMessage',
  async (message, { rejectWithValue }) => {
    const trimmedMessage = message.trim();

    if (!trimmedMessage) {
      return rejectWithValue('Message is required.');
    }

    try {
      const result = await postChatMessage(trimmedMessage);
      return result.reply;
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : 'Unknown error.');
    }
  },
);

const chatSlice = createSlice({
  name: 'chat',
  initialState,
  reducers: {
    updateInput(state, action: PayloadAction<string>) {
      state.input = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(submitMessage.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(submitMessage.fulfilled, (state, action) => {
        state.loading = false;
        state.response = action.payload;
      })
      .addCase(submitMessage.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload || 'Unknown error.';
      });
  },
});

export const { updateInput } = chatSlice.actions;
export default chatSlice.reducer;


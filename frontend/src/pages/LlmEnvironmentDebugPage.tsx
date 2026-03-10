import { FormEvent } from 'react';
import { useAppDispatch, useAppSelector } from '../app/hooks';
import {
  resetSystemPrompt,
  submitDebugLlmMessage,
  updateMessage,
  updateSystemPrompt,
} from '../features/llmDebug/llmDebugSlice';

// 这个页面用于隔离调试 LLM 的输入环境：
// 一边编辑系统提示词，一边粘贴 normalization 页复制来的用户提示词，直接看模型回复。
export function LlmEnvironmentDebugPage() {
  const dispatch = useAppDispatch();
  const { systemPrompt, message, loading, reply, error } = useAppSelector((state) => state.llmDebug);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await dispatch(submitDebugLlmMessage({ systemPrompt, message }));
  };

  return (
    <section>
      <h2>LLM Environment Debug</h2>
      <form onSubmit={handleSubmit}>
        <label htmlFor="systemPrompt">System Prompt</label>
        <br />
        <textarea
          id="systemPrompt"
          rows={8}
          cols={100}
          value={systemPrompt}
          onChange={(event) => dispatch(updateSystemPrompt(event.target.value))}
        />
        <br />
        <button type="button" onClick={() => dispatch(resetSystemPrompt())}>
          Use Default System Prompt
        </button>
        <br />
        <br />
        <label htmlFor="llmDebugMessage">User Message</label>
        <br />
        <textarea
          id="llmDebugMessage"
          rows={16}
          cols={100}
          value={message}
          onChange={(event) => dispatch(updateMessage(event.target.value))}
          placeholder="Paste the prompt preview from debug/normalization here."
        />
        <br />
        <button type="submit" disabled={loading}>
          {loading ? 'Sending...' : 'Send to LLM'}
        </button>
      </form>

      <h3>Reply</h3>
      <pre style={{ border: '1px solid', minHeight: '200px', padding: '8px', whiteSpace: 'pre-wrap' }}>
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

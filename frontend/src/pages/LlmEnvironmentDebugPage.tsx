import { FormEvent } from 'react';
import { useAppDispatch, useAppSelector } from '../app/hooks';
import {
  resetSystemPrompt,
  selectLlmDebugState,
  setMessage,
  setSystemPrompt,
  submitDebugLlmMessage,
} from '../features/llmDebug/llmDebugSlice';

/**
 * 用于隔离调试单轮 LLM 的输入输出，主要用来调试提示词。
 * 名叫 environment 是因为早期是用来调试 Summary Preview / Scene Prompt 的
 *
 * 页面本身仍然只关心 reply / reasoning 两个结果区。
 * 原始 stream 读取与状态累积都放在 API + Redux 层，这样未来若主游戏回合也改成流式，
 * 页面组件依然只负责渲染，而不用重复处理传输层细节。
 */

export function LlmEnvironmentDebugPage() {
  const dispatch = useAppDispatch();
  const { systemPrompt, message, request } = useAppSelector(selectLlmDebugState);

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
          onChange={(event) => dispatch(setSystemPrompt(event.target.value))}
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
          onChange={(event) => dispatch(setMessage(event.target.value))}
          placeholder="Single message would send to LLM."
        />
        <br />
        <button type="submit" disabled={request.status === 'loading'}>
          {request.status === 'loading' ? 'Streaming...' : 'Send to LLM'}
        </button>
      </form>

      <h3>Reply</h3>
      <pre style={{ border: '1px solid', minHeight: '200px', padding: '8px', whiteSpace: 'pre-wrap' }}>
        {request.reply || 'No reply yet.'}
      </pre>

      <h3>Reasoning</h3>
      <pre style={{ border: '1px solid', minHeight: '200px', padding: '8px', whiteSpace: 'pre-wrap' }}>
        {request.reasoning || 'Model did not return separate reasoning.'}
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

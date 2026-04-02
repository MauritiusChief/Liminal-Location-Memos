import { config } from "@/config.js";

/**
 * 不包含工具的 chat message
 */
type ChatRequestMessage = { role: 'system' | 'user'; content: string }

type ResponseWithReasoning = {
  reply: string;
  reasoning: string | null;
}

//#region 主函数

/**
 * 仅输入 system prompt 和单个 use message 的单一回合 LLM call
 * @param systemPrompt
 * @param message
 * @returns
 */
export async function generateReplySingleMessage(
  systemPrompt: string,
  message: string,
): Promise<ResponseWithReasoning> {
  const messages: ChatRequestMessage[] = [
    {role: 'system', content: systemPrompt},
    {role: 'user', content: message}
  ]
  const payload = await chatCompletionSingleMessage( messages );
  return {
    reply: payload.choices[0].message.content,
    reasoning: payload.choices[0].message.reasoning_content
  };
}

//#region 帮助函数

/**
 * TODO 目前仅覆盖单轮，视后续情况再抽出 fetch 逻辑或者兼容工具
 * @param messages
 * @returns
 */
async function chatCompletionSingleMessage(messages: ChatRequestMessage[]): Promise<any> {
  const response = await fetch(`${config.llmBaseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.llmApiKey}`,
    },
    body: JSON.stringify({
      model: config.llmModel,
      messages,
    }),
  });

  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload?.error?.message || 'LLM request failed.');
  }

  return payload;
}
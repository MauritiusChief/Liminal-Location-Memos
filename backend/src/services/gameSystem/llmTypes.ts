
//#region DeepSeek 类型

export type DeepSeekTool = {
  type: "function"
  function: {
    name: string
    description?: string
    strict?: boolean                    // Beta：启用 strict 模式
    parameters: {
      type: "object"
      properties: Record<string, any>
      required?: string[]
      additionalProperties?: boolean   // strict 模式中必须为 false
    }
  }
}

export type DeepSeekMessage = {
  role: "system" | "user" | "assistant" | "tool"
  content?: string
  reasoning_content?: string
  tool_calls?: DeepSeekToolCall[]
  tool_call_id?: string
}

export type DeepSeekChatRequest = {
  model: string
  messages: DeepSeekMessage[]
  thinking?: { type: "enabled" | "disabled"}  // thinking 模式控制
  response_format?: {  type: "json_object" }  // JSON Output 控制
  stream?: boolean
  tools?: DeepSeekTool[]
  tool_choice?: "auto" | "none" | { type: "function"; function: { name: string } }
}

export type DeepSeekToolCall = {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string // 注意：是 JSON string
  }
}

export type DeepSeekChatResponse = {
  choices: {
    message: {
      role: "assistant"
      content?: string
      reasoning_content?: string
      tool_calls?: DeepSeekToolCall[]
    }
    finish_reason: "stop" | "tool_calls"
  }[]
}

//#region Openrouter 类型

export type OpenRouterTool = DeepSeekTool

export type OpenRouterToolCall = DeepSeekToolCall

export type OpenRouterMessage = {
  role: "system" | "user" | "assistant" | "tool"
  content?: string
  reasoning?: string
  reasoning_content?: string
  tool_calls?: OpenRouterToolCall[]
  tool_call_id?: string
}

export type OpenRouterChatRequest = {
  model: string
  messages: OpenRouterMessage[]
  stream?: boolean
  tools?: OpenRouterTool[]
  tool_choice?: "auto" | "none" | { type: "function"; function: { name: string } }
  reasoning?: { enabled: boolean }
  include_reasoning?: boolean
  response_format?: { type: "json_object" }
}

export type OpenRouterChatResponse = {
  choices: {
    message: {
      role: "assistant"
      content?: string
      reasoning?: string
      reasoning_content?: string
      tool_calls?: OpenRouterToolCall[]
    }
    finish_reason?: "stop" | "tool_calls" | string
  }[]
}

//#region 共享类型

export type LlmProviderMessage = DeepSeekMessage | OpenRouterMessage

export type NormalizedLlmResponse = {
  choices: {
    message: {
      role: "assistant"
      content?: string
      reasoning_content?: string
      tool_calls?: DeepSeekToolCall[] | OpenRouterToolCall[]
    }
    finish_reason?: "stop" | "tool_calls" | string
  }[]
}

export type NormalizedLlmStreamEvent = {
  replyDelta?: string
  reasoningDelta?: string
  done: boolean
}

/**
 * 所有 LLM 可查询信息的地方都扩展此处
 */
export interface GeneralSource {
  id: string;
  keyword: string; // 用来给搜索引擎比对的
  description: string;
}
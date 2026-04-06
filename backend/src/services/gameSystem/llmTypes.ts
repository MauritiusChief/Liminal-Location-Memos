
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
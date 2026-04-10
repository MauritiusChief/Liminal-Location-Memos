// 这里保留一份前端默认系统提示词，方便 debug/llm-environment 页面直接预填充。
// 它需要和后端 buildDefaultDebugSystemPrompt() 保持同步。

export const DEFAULT_LLM_DEBUG_SYSTEM_PROMPT = `
输出时请尽量使用丰富的格式与文本，但不要与用户请求相差太远，用以测试前端的 UI 输出功能。
`

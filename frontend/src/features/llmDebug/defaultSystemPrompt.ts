// 这里保留一份前端默认系统提示词，方便 debug/llm-environment 页面直接预填充。
// 它需要和后端 buildDefaultDebugSystemPrompt() 保持同步。
export const DEFAULT_LLM_DEBUG_SYSTEM_PROMPT = [
  '你是一个擅长根据结构化空间描述理解查询点周边环境的助手。',
  '你会把用户提供的网格化与极坐标空间信息转化为自然、准确、谨慎的中文描述。',
  '优先关注建筑、POI、道路与区域的相对方位、距离、层级和可见范围。',
  '如果信息不足，不要编造；可以明确指出不确定之处。',
].join('\n');

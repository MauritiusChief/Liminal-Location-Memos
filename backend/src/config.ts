import dotenv from 'dotenv';

dotenv.config();

type LlmProvider = 'deepseek' | 'openrouter';

function readRequiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function readOptionalEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value) {
      return value;
    }
  }

  return undefined;
}

function readLlmProvider(): LlmProvider {
  const provider = readRequiredEnv('LLM_PROVIDER').trim().toLowerCase();
  console.log(`模型供应商：${provider}`);

  if (provider === 'deepseek' || provider === 'openrouter') {
    return provider;
  }

  throw new Error(`Unsupported LLM_PROVIDER: ${provider}`);
}

function readProviderConfig(provider: LlmProvider): { apiKey: string; baseUrl: string; model: string; reasoningMode: 'deepseek-thinking' | 'openrouter-reasoning' } {
  if (provider === 'deepseek') {
    return {
      apiKey: readRequiredEnv('DEEPSEEK_API_KEY'),
      baseUrl: readRequiredEnv('DEEPSEEK_URL'),
      model: readRequiredEnv('DEEPSEEK_MODEL'),
      reasoningMode: 'deepseek-thinking',
    };
  }

  const model =readRequiredEnv('OPENROUTER_MODEL')
  console.log(`所选模型：${model}`)
  return {
    apiKey: readRequiredEnv('OPENROUTER_API_KEY'),
    baseUrl: readRequiredEnv('OPENROUTER_URL'),
    model,
    reasoningMode: 'openrouter-reasoning',
  };
}

const dbHost = readOptionalEnv('PGHOST', 'DB_HOST');
const dbPort = readOptionalEnv('PGPORT', 'DB_PORT');
const dbDatabase = readOptionalEnv('PGDATABASE', 'DB_NAME');
const dbUser = readOptionalEnv('PGUSER', 'DB_USER');
const dbPassword = readOptionalEnv('PGPASSWORD', 'DB_PASSWORD');
const llmProvider = readLlmProvider();
const llmProviderConfig = readProviderConfig(llmProvider);

export const config = {
  port: Number(process.env.PORT || '3001'),
  llmProvider,
  llmApiKey: llmProviderConfig.apiKey,
  llmBaseUrl: llmProviderConfig.baseUrl,
  llmModel: llmProviderConfig.model,
  llmReasoningMode: llmProviderConfig.reasoningMode,
  gameChatDebugLogEnabled: /^true$/i.test(process.env.GAME_CHAT_DEBUG_LOG || ''),
  db: {
    enabled: Boolean(dbHost && dbPort && dbDatabase && dbUser && dbPassword),
    host: dbHost,
    port: dbPort ? Number(dbPort) : undefined,
    database: dbDatabase,
    user: dbUser,
    password: dbPassword,
    sslMode: readOptionalEnv('PGSSLMODE'),
  },
};

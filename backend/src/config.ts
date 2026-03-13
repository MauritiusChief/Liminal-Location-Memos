import dotenv from 'dotenv';

dotenv.config();

const requiredEnvVars = ['LLM_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL'] as const;

function readRequiredEnv(name: (typeof requiredEnvVars)[number]): string {
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

const dbHost = readOptionalEnv('PGHOST', 'DB_HOST');
const dbPort = readOptionalEnv('PGPORT', 'DB_PORT');
const dbDatabase = readOptionalEnv('PGDATABASE', 'DB_NAME');
const dbUser = readOptionalEnv('PGUSER', 'DB_USER');
const dbPassword = readOptionalEnv('PGPASSWORD', 'DB_PASSWORD');

export const config = {
  port: Number(process.env.PORT || '3001'),
  llmApiKey: readRequiredEnv('LLM_API_KEY'),
  llmBaseUrl: readRequiredEnv('LLM_BASE_URL'),
  llmModel: readRequiredEnv('LLM_MODEL'),
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

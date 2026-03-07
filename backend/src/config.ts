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

export const config = {
  port: Number(process.env.PORT || '3001'),
  llmApiKey: readRequiredEnv('LLM_API_KEY'),
  llmBaseUrl: readRequiredEnv('LLM_BASE_URL'),
  llmModel: readRequiredEnv('LLM_MODEL'),
};


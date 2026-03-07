import { Router } from 'express';
import { generateReply } from '../services/llm.js';

interface ChatRequestBody {
  message?: string;
}

export const apiRouter = Router();

apiRouter.get('/health', (_request, response) => {
  response.json({ ok: true, service: 'backend' });
});

apiRouter.post('/chat', async (request, response) => {
  const { message } = request.body as ChatRequestBody;

  if (!message || !message.trim()) {
    response.status(400).json({ error: 'Message is required.' });
    return;
  }

  try {
    const reply = await generateReply(message.trim());
    response.json({ reply });
  } catch (error) {
    response.status(502).json({
      error: error instanceof Error ? error.message : 'Unexpected upstream error.',
    });
  }
});


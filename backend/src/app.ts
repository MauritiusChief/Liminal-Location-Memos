import express from 'express';
import { apiRouter } from './routes/api.js';

export function createApp() {
  const app = express();

  app.use(express.json());
  app.use('/api', apiRouter);

  app.use((_request, response) => {
    response.status(404).json({ error: 'Not found.' });
  });

  return app;
}


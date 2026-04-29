import { createApp } from './app.js';
import { config } from './config.js';

const app = createApp();

app.listen(config.port, () => {
  console.log(`后端正在监听端口 http://localhost:${config.port}`);
});

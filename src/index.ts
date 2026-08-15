import { loadConfig } from './config.js';
import { log } from './logger.js';
import { createApp } from './server.js';

const config = loadConfig(process.env);
const app = createApp({});

app.listen(config.port, () => {
  log('info', 'hub started', { port: config.port });
});

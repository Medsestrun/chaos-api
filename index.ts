import { Hono } from 'hono';
import { logger } from 'hono/logger';
import metricsRouter from './src/routes/metricsRouter';
import strategyRunner from './src/services/strategyRunner';
import strategiesRouter from './src/strategies';

const app = new Hono();

app.use('*', logger());

app.route('/strategies', strategiesRouter);
app.route('/metrics', metricsRouter);

app.get('/', (c) => {
  return c.json({
    message: 'Chaos API is running',
    strategyRunning: strategyRunner.isStrategyRunning(),
  });
});

app.get('/health', (c) => {
  return c.json({
    message: 'Chaos API is healthy',
  });
});

const port = Number(process.env.PORT) || 3040;

console.log(`Server is running on port ${port}`);

// Запускаем стратегию при старте приложения
strategyRunner.start().catch((error) => {
  console.error('Failed to start strategy runner:', error);
});

export default {
  port,
  fetch: app.fetch,
};

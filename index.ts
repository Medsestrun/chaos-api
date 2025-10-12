import { Hono } from 'hono';
import { logger } from 'hono/logger';
import strategiesRouter from './src/strategies';

const app = new Hono();

app.use('*', logger());

app.route('/strategies', strategiesRouter);

app.get('/', (c) => {
  return c.json({ message: 'Chaos API is running' });
});

const port = Number(process.env.PORT) || 3040;

console.log(`Server is running on port ${port}`);

export default {
  port,
  fetch: app.fetch,
};

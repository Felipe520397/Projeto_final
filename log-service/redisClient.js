const Redis = require('ioredis');
require('dotenv').config();

const redisHost = process.env.REDIS_HOST || 'redis';
const redisPort = parseInt(process.env.REDIS_PORT || '6379', 10);
const redisPassword = process.env.REDIS_PASSWORD || undefined;

const redis = new Redis({
  host: redisHost,
  port: redisPort,
  password: redisPassword,
  retryStrategy(times) {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
  maxRetriesPerRequest: null
});

redis.on('connect', () => {
  console.log(`[Log-Service] Conectado ao Redis em ${redisHost}:${redisPort}`);
});

redis.on('error', (err) => {
  console.error('[Log-Service] Erro na conexão com o Redis:', err.message);
});

module.exports = redis;

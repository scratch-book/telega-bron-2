import { createBot } from './bot';
import { logger } from './services/logger';

async function main(): Promise<void> {
  logger.info('Starting telega-bron bot...');

  const bot = createBot();

  // Graceful shutdown
  const shutdown = (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`);
    bot.stop(signal);
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await bot.launch();
  logger.info('Bot is running. Press Ctrl+C to stop.');
}

main().catch((err) => {
  logger.error('Fatal error', { error: err.message, stack: err.stack });
  process.exit(1);
});

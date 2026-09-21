import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registry } from './adapters/index.js';
import { BrowserManager } from './browser/browser-manager.js';
import { loadConfig } from './config.js';
import { errorMessage } from './errors.js';
import { createLogger } from './logger.js';
import { createServer } from './server.js';
import { openStores, type Stores } from './store/index.js';

/**
 * Starts the MCP server on stdio. History and credentials are optional: if the database or key
 * cannot be opened, the server still works (without dashboard data or injected logins).
 */
export async function startMcp(): Promise<void> {
  const config = loadConfig();

  let stores: Stores | undefined;
  let storeError: string | undefined;
  try {
    stores = openStores(config);
  } catch (error) {
    storeError = errorMessage(error);
  }

  const logger = createLogger(stores?.calls);
  if (storeError)
    logger.error({ error: storeError, dbPath: config.dbPath }, 'History/credentials disabled');

  const manager = new BrowserManager(
    config,
    logger.child({ component: 'browser' }),
    stores?.credentials
  );
  const server = createServer({ manager, registry, config, logger, history: stores?.calls });

  let shuttingDown = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ reason }, 'Shutting down');
    await manager.shutdown();
    await server.close().catch((error: unknown) => {
      logger.warn({ error: errorMessage(error) }, 'Error closing MCP server');
    });
    stores?.db.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.stdin.on('end', () => void shutdown('stdin ended'));
  process.stdin.on('close', () => void shutdown('stdin closed'));
  process.on('unhandledRejection', (error) => {
    logger.error({ error: errorMessage(error) }, 'Unhandled rejection');
  });

  const transport = new StdioServerTransport();
  transport.onclose = () => void shutdown('transport closed');
  await server.connect(transport);
  logger.info(
    { profileDir: config.profileDir, headless: config.headless },
    'readit-idgaf MCP server ready (stdio)'
  );
}

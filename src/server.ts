import { loadConfig } from './config.js';
import { installShutdownHandlers } from './lifecycle.js';
import { startServer } from './start.js';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await startServer(config);
  installShutdownHandlers(app);
}

void main().catch((error: unknown) => {
  console.error(`Failed to start server: ${errorMessage(error)}`);
  process.exitCode = 1;
});

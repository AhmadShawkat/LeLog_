import type { ServerInstance } from './start.js';

type ShutdownSignal = 'SIGINT' | 'SIGTERM';
type SignalListener = () => void;

export interface ProcessRuntime {
  exitCode: string | number | null | undefined;
  on(signal: ShutdownSignal, listener: SignalListener): unknown;
  removeListener(signal: ShutdownSignal, listener: SignalListener): unknown;
}

export interface ShutdownController {
  shutdown(): Promise<void>;
  dispose(): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function installShutdownHandlers(
  app: Pick<ServerInstance, 'close'>,
  runtime: ProcessRuntime = process,
  reportError: (message: string) => void = (message) => console.error(message),
): ShutdownController {
  let shutdownPromise: Promise<void> | undefined;
  let installed = true;

  const handleSignal = (): void => {
    void shutdown();
  };

  const dispose = (): void => {
    if (!installed) {
      return;
    }

    installed = false;
    runtime.removeListener('SIGINT', handleSignal);
    runtime.removeListener('SIGTERM', handleSignal);
  };

  const shutdown = (): Promise<void> => {
    if (shutdownPromise) {
      return shutdownPromise;
    }

    shutdownPromise = Promise.resolve()
      .then(() => app.close())
      .catch((error: unknown) => {
        runtime.exitCode = 1;
        reportError(`Failed to shut down server: ${errorMessage(error)}`);
      })
      .finally(dispose);

    return shutdownPromise;
  };

  runtime.on('SIGINT', handleSignal);
  runtime.on('SIGTERM', handleSignal);

  return { shutdown, dispose };
}

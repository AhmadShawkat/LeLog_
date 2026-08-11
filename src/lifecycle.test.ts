import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { installShutdownHandlers, type ProcessRuntime } from './lifecycle.js';

class TestRuntime extends EventEmitter implements ProcessRuntime {
  exitCode: string | number | null | undefined;
}

describe('installShutdownHandlers', () => {
  it.each(['SIGINT', 'SIGTERM'] as const)(
    'closes once after %s',
    async (signal) => {
      const runtime = new TestRuntime();
      const close = vi.fn().mockResolvedValue(undefined);
      const controller = installShutdownHandlers({ close }, runtime);

      runtime.emit(signal);
      runtime.emit(signal);
      await controller.shutdown();

      expect(close).toHaveBeenCalledOnce();
      expect(runtime.listenerCount('SIGINT')).toBe(0);
      expect(runtime.listenerCount('SIGTERM')).toBe(0);
    },
  );

  it('returns the same shutdown operation for repeated calls', async () => {
    const runtime = new TestRuntime();
    const close = vi.fn().mockResolvedValue(undefined);
    const controller = installShutdownHandlers({ close }, runtime);

    const first = controller.shutdown();
    const second = controller.shutdown();

    expect(second).toBe(first);
    await first;
    expect(close).toHaveBeenCalledOnce();
  });

  it('sets a failure exit code and reports shutdown errors', async () => {
    const runtime = new TestRuntime();
    const reportError = vi.fn();
    const controller = installShutdownHandlers(
      { close: vi.fn().mockRejectedValue(new Error('close failed')) },
      runtime,
      reportError,
    );

    await controller.shutdown();

    expect(runtime.exitCode).toBe(1);
    expect(reportError).toHaveBeenCalledWith(
      'Failed to shut down server: close failed',
    );
  });

  it('disposes handlers without closing the app', () => {
    const runtime = new TestRuntime();
    const close = vi.fn().mockResolvedValue(undefined);
    const controller = installShutdownHandlers({ close }, runtime);

    controller.dispose();
    controller.dispose();
    runtime.emit('SIGINT');

    expect(close).not.toHaveBeenCalled();
    expect(runtime.listenerCount('SIGINT')).toBe(0);
    expect(runtime.listenerCount('SIGTERM')).toBe(0);
  });
});

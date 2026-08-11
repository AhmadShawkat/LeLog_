import { describe, it, expect } from 'vitest';

describe('toolchain', () => {
  it('runs on the Node.js version declared by the project', () => {
    const nodeMajorVersion = Number.parseInt(process.versions.node, 10);

    expect(nodeMajorVersion).toBeGreaterThanOrEqual(24);
  });
});

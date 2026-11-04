import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { importOrReload, isChunkLoadError, reloadOnce } from './lazy';

const reload = vi.fn();

beforeEach(() => {
  window.sessionStorage.clear();
  reload.mockReset();
  vi.stubGlobal('location', { ...window.location, reload });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isChunkLoadError', () => {
  it('recognizes the browsers’ messages for a module that cannot be fetched', () => {
    expect(
      isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: /a.js')),
    ).toBe(true);
    expect(isChunkLoadError(new TypeError('error loading dynamically imported module'))).toBe(true);
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(new Error('boom'))).toBe(false);
  });
});

describe('reloadOnce', () => {
  it('reloads once per minute at most', () => {
    expect(reloadOnce(() => 1_000_000)).toBe(true);
    expect(reloadOnce(() => 1_030_000)).toBe(false);
    expect(reloadOnce(() => 1_061_000)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });
});

describe('importOrReload', () => {
  it('returns the module when it loads', async () => {
    await expect(importOrReload(async () => ({ value: 1 }))).resolves.toEqual({ value: 1 });
  });

  it('reloads the page instead of failing when the chunk is gone after a deploy', async () => {
    const pending = importOrReload(() =>
      Promise.reject(new TypeError('Failed to fetch dynamically imported module: /x.js')),
    );
    const settled = vi.fn();
    void pending.then(settled, settled);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(settled).not.toHaveBeenCalled();
  });

  it('rethrows any other error, and a chunk error right after a reload', async () => {
    await expect(importOrReload(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    reloadOnce();
    reload.mockReset();
    await expect(
      importOrReload(() => Promise.reject(new TypeError('Importing a module script failed.'))),
    ).rejects.toThrow('Importing a module script failed.');
    expect(reload).not.toHaveBeenCalled();
  });
});

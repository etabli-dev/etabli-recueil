import { describe, expect, it, vi } from 'vitest';

vi.mock('../shell/runtime.js', () => ({ defaultSettings: () => null, nativeCapabilities: () => ({}) }));
(globalThis as { recueilHostTest?: boolean }).recueilHostTest = true;

const { createHost, installHost } = await import('../shell/host.js');
const { memorySettings } = await import('../shell/settings.js');

describe('the mobile host', () => {
  it('answers with the stored server and token, and offers the capabilities', async () => {
    const host = createHost(memorySettings({ baseUrl: 'https://example.org', token: 'rc_x' }), { platform: 'android' }, () => undefined);
    await expect(host.connection()).resolves.toEqual({ baseUrl: 'https://example.org', token: 'rc_x' });
    expect(host.capabilities.platform).toBe('android');
  });

  it('sends the app to the connection page when no server is configured', async () => {
    const onMissing = vi.fn();
    const host = createHost(memorySettings(), {}, onMissing);
    await expect(host.connection()).rejects.toThrow(/No server/u);
    expect(onMissing).toHaveBeenCalledOnce();
  });

  it('installs itself once, read-only', () => {
    const scope: { recueilHost?: unknown } = {};
    const host = createHost(memorySettings(), {}, () => undefined);
    installHost(scope as never, host);
    expect(scope.recueilHost).toBe(host);
    expect(() => installHost(scope as never, host)).toThrow();
  });
});

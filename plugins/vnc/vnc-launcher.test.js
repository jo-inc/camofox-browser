import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { resolveVncConfig } from './vnc-launcher.js';

describe('vnc launcher configuration', () => {
  let previousEnableVnc;

  beforeEach(() => {
    previousEnableVnc = process.env.ENABLE_VNC;
    delete process.env.ENABLE_VNC;
  });

  afterEach(() => {
    if (previousEnableVnc === undefined) delete process.env.ENABLE_VNC;
    else process.env.ENABLE_VNC = previousEnableVnc;
  });

  test('loads the plugin for display override while keeping transport disabled', () => {
    const config = resolveVncConfig({
      enabled: true,
      transportEnabled: false,
      overrideDisplay: true,
      resolution: '1920x1080',
    });

    expect(config.enabled).toBe(false);
    expect(config.resolution).toBe('1920x1080x24');
  });

  test('preserves an explicit zero idle timeout', () => {
    const config = resolveVncConfig({ enabled: true, idleTimeoutMs: 0 });
    expect(config.idleTimeoutMs).toBe(0);
  });

  test('legacy noVNC stays disabled unless explicitly requested', () => {
    expect(resolveVncConfig({ enabled: true }).enableNoVnc).toBe(false);
    expect(resolveVncConfig({ enabled: true, enableNoVnc: true }).enableNoVnc).toBe(true);
  });

  test('ENABLE_VNC=1 explicitly enables transport', () => {
    process.env.ENABLE_VNC = '1';
    expect(resolveVncConfig({ enabled: true, transportEnabled: false }).enabled).toBe(true);
  });
});

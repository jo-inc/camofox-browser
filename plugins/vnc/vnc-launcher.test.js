import { describe, expect, test } from '@jest/globals';
import { buildWatcherEnv, resolveVncConfig } from './vnc-launcher.js';

describe('vnc launcher config', () => {
  test('ENABLE_VNC enables the plugin over disabled config', () => {
    const config = resolveVncConfig(
      { enabled: false, resolution: '1280x720' },
      { ENABLE_VNC: '1' }
    );

    expect(config.enabled).toBe(true);
    expect(config.resolution).toBe('1280x720x24');
  });

  test('buildWatcherEnv only includes watcher env whitelist', () => {
    const env = buildWatcherEnv(
      {
        resolution: '1920x1080x24',
        vncPassword: 'secret',
        viewOnly: true,
        vncPort: 5901,
        novncPort: 6081,
      },
      {
        PATH: '/usr/bin',
        HOME: '/home/camofox',
        VNC_BIND: '0.0.0.0',
        VNC_RFB_BIND: '192.0.2.1',
        SECRET_TOKEN: 'do-not-forward',
      }
    );

    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/camofox',
      VNC_BIND: '0.0.0.0',
      VNC_RFB_BIND: '192.0.2.1',
      VNC_PASSWORD: 'secret',
      VNC_RESOLUTION: '1920x1080x24',
      VIEW_ONLY: '1',
      VNC_PORT: '5901',
      NOVNC_PORT: '6081',
    });
  });
});

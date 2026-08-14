import { x11PinnedEnv } from '../../lib/display-env.js';

describe('x11PinnedEnv', () => {
  test('removes Wayland session variables', () => {
    const env = x11PinnedEnv({
      WAYLAND_DISPLAY: 'wayland-1',
      XDG_SESSION_TYPE: 'wayland',
      HOME: '/home/user',
    });
    expect(env).not.toHaveProperty('WAYLAND_DISPLAY');
    expect(env).not.toHaveProperty('XDG_SESSION_TYPE');
  });

  test('forces the X11 backend', () => {
    const env = x11PinnedEnv({ MOZ_ENABLE_WAYLAND: '1', GDK_BACKEND: 'wayland,x11,*' });
    expect(env.MOZ_ENABLE_WAYLAND).toBe('0');
    expect(env.GDK_BACKEND).toBe('x11');
  });

  test('preserves unrelated variables', () => {
    const env = x11PinnedEnv({ HOME: '/home/user', PATH: '/usr/bin', DISPLAY: ':0' });
    expect(env.HOME).toBe('/home/user');
    expect(env.PATH).toBe('/usr/bin');
    // DISPLAY passes through untouched; camoufox-js repoints it at the Xvfb display.
    expect(env.DISPLAY).toBe(':0');
  });

  test('never mutates the input', () => {
    const input = { WAYLAND_DISPLAY: 'wayland-1', MOZ_ENABLE_WAYLAND: '1' };
    x11PinnedEnv(input);
    expect(input).toEqual({ WAYLAND_DISPLAY: 'wayland-1', MOZ_ENABLE_WAYLAND: '1' });
  });

  test('defaults to process.env without mutating it', () => {
    const before = { ...process.env };
    const env = x11PinnedEnv();
    expect(env.MOZ_ENABLE_WAYLAND).toBe('0');
    expect(process.env).toEqual(before);
  });
});

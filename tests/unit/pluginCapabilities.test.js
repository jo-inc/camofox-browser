import { describe, expect, test } from '@jest/globals';
import { VirtualDisplay } from 'camoufox-js/dist/virtdisplay.js';
import { generateFingerprint } from 'camoufox-js/dist/fingerprints.js';
import { createVirtualDisplayRegistry, virtualDisplayScreen } from '../../lib/plugin-capabilities.js';

describe('virtual display plugin capability', () => {
  test('uses the registered plugin provider instead of the default provider', () => {
    const registry = createVirtualDisplayRegistry(() => ({ owner: 'core' }));

    registry.register('vnc', () => ({ owner: 'vnc' }));

    expect(registry.owner).toBe('vnc');
    expect(registry.create()).toEqual({ owner: 'vnc' });
  });

  test('rejects a second plugin provider instead of relying on load order', () => {
    const registry = createVirtualDisplayRegistry(() => ({ owner: 'core' }));
    registry.register('vnc', () => ({ owner: 'vnc' }));

    expect(() => registry.register('other-display', () => ({ owner: 'other' }))).toThrow(
      '"vnc" already owns the capability; "other-display" cannot also provide it'
    );
  });
});

describe('fingerprint screen on a virtual display', () => {
  class SizedDisplay extends VirtualDisplay {
    get xvfb_args() {
      const args = [...super.xvfb_args];
      args[args.indexOf('-screen') + 2] = '1920x1080x24';
      return args;
    }
  }

  test('reads the cap from the Xvfb screen argument', () => {
    expect(virtualDisplayScreen(new SizedDisplay())).toEqual({ maxWidth: 1920, maxHeight: 1080 });
  });

  test('keeps every generated Linux window within the display', () => {
    const screen = virtualDisplayScreen(new SizedDisplay());
    for (let i = 0; i < 50; i++) {
      const { screen: generated } = generateFingerprint(undefined, { screen, operatingSystems: ['linux'] });
      expect(generated.outerWidth).toBeLessThanOrEqual(screen.maxWidth);
      expect(generated.outerHeight).toBeLessThanOrEqual(screen.maxHeight);
    }
  });
});

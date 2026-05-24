import { isBrowserProcessCmdline, selectBrowserProcessVictims } from '../../lib/browser-processes.js';

describe('browser process survivor selection', () => {
  test('identifies Camoufox, Firefox, Gecko children, and Xvfb processes', () => {
    expect(isBrowserProcessCmdline('/app/camoufox-bin --profile /tmp/x')).toBe(true);
    expect(isBrowserProcessCmdline('/usr/lib/firefox-esr/firefox-esr')).toBe(true);
    expect(isBrowserProcessCmdline('GeckoChildProcess -contentproc')).toBe(true);
    expect(isBrowserProcessCmdline('/usr/bin/Xvfb :99')).toBe(true);
    expect(isBrowserProcessCmdline('node server.js')).toBe(false);
  });

  test('never selects the current process or explicitly excluded browser pid', () => {
    const victims = selectBrowserProcessVictims([
      { pid: 10, cmdline: 'node server.js' },
      { pid: 11, cmdline: '/app/camoufox-bin' },
      { pid: 12, cmdline: '/usr/bin/Xvfb :99' },
      { pid: 13, cmdline: 'GeckoChildProcess -contentproc' },
    ], { myPid: 12, excludePid: 11 });

    expect(victims).toEqual([13]);
  });

  test('snapshot-based cleanup cannot include processes launched after the snapshot', () => {
    const beforeClose = [
      { pid: 21, cmdline: '/app/camoufox-bin --old' },
      { pid: 22, cmdline: '/usr/bin/Xvfb :98' },
    ];
    const launchedAfterCloseStarted = { pid: 99, cmdline: '/app/camoufox-bin --new' };

    const snapshotVictims = selectBrowserProcessVictims(beforeClose, { myPid: 1, excludePid: null });
    const unsafeFreshScanVictims = selectBrowserProcessVictims([...beforeClose, launchedAfterCloseStarted], { myPid: 1, excludePid: null });

    expect(snapshotVictims).toEqual([21, 22]);
    expect(unsafeFreshScanVictims).toEqual([21, 22, 99]);
  });
});

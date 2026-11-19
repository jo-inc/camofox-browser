import { execFileSync, spawn } from 'node:child_process';

// camoufox-js starts Xvfb detached, in its own process group, and only the browser's close stops it. A server
// that exits any other way (SIGKILL from a test runner, the shutdown watchdog, a crash) left Xvfb, and the
// dbus-launch Firefox tied to it, running until reboot. setpriv --pdeathsig has the kernel kill Xvfb when the
// server dies; it execs Xvfb, so the process and its command line are Xvfb's own. Without setpriv, Xvfb is
// spawned directly as camoufox-js does. Xvfb gets only PATH and HOME, not the server's environment.
let setprivPath;

export function findSetpriv() {
  if (setprivPath === undefined) {
    try {
      setprivPath = execFileSync('which', ['setpriv'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null;
    } catch {
      setprivPath = null;
    }
  }
  return setprivPath;
}

// The spawn camoufox-js's VirtualDisplay.spawnXvfb makes, with Xvfb tied to this process's life.
export function spawnXvfbTiedToServer(display) {
  const xvfb = [display.xvfb_path, '-displayfd', '3', ...display.xvfb_args];
  const setpriv = findSetpriv();
  const [command, args] = setpriv ? [setpriv, ['--pdeathsig', 'KILL', '--', ...xvfb]] : [xvfb[0], xvfb.slice(1)];
  const output = display.debug ? 'inherit' : 'ignore';
  return spawn(command, args, {
    stdio: ['ignore', output, output, 'pipe'], // fd 3: Xvfb writes "<display>\n" here
    detached: true,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, __GLX_VENDOR_LIBRARY_NAME: 'mesa', LIBGL_ALWAYS_SOFTWARE: '1' },
  });
}

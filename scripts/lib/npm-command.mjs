import { posix, win32 } from 'node:path';

/**
 * Choose how to run npm from a script started by an npm lifecycle command.
 *
 * child_process cannot spawn the "npm" .cmd shim on Windows without a shell.
 * Under "npm run" the npm CLI is known through npm_execpath, so run its
 * npm-cli.js entry point with the current Node executable. Elsewhere fall back
 * to "npm" on PATH. A direct Windows run without that entry point is not
 * supported here, so name the supported command instead of failing later
 * with ENOENT.
 *
 * @param {{ platform: string, env: NodeJS.ProcessEnv, execPath: string }} runtime
 * @returns {{ file: string, args: string[] }} executable and leading arguments
 */
export function selectNpmCommand({ platform, env, execPath }) {
  const pathApi = platform === 'win32' ? win32 : posix;
  const execpath = env.npm_execpath ?? '';
  const npmCli = pathApi.basename(execpath) === 'npm-cli.js' ? execpath : undefined;
  if (platform === 'win32' && !npmCli) {
    throw new Error('Run the MCP package check with "npm run test:mcp" on Windows.');
  }
  return npmCli ? { file: execPath, args: [npmCli] } : { file: 'npm', args: [] };
}

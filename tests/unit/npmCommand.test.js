import { selectNpmCommand } from '../../scripts/lib/npm-command.mjs';

describe('selectNpmCommand', () => {
  const execPath = '/fixture/node';
  const windowsNpmCli = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';

  test('runs the npm entry point through Node when npm started the script', () => {
    expect(selectNpmCommand({
      platform: 'win32', execPath,
      env: { npm_config_user_agent: 'npm/11.0.0 node/v24.0.0 win32 x64', npm_execpath: windowsNpmCli },
    })).toEqual({ file: execPath, args: [windowsNpmCli] });
    expect(selectNpmCommand({
      platform: 'linux', execPath,
      env: { npm_execpath: '/opt/node modules/npm/bin/npm-cli.js' },
    })).toEqual({ file: execPath, args: ['/opt/node modules/npm/bin/npm-cli.js'] });
  });

  test('ignores the configurable user agent', () => {
    expect(selectNpmCommand({
      platform: 'win32', execPath,
      env: { npm_config_user_agent: 'fixture-client/1.0', npm_execpath: '/fixture/npm-cli.js' },
    })).toEqual({ file: execPath, args: ['/fixture/npm-cli.js'] });
  });

  test('explains the supported command for a direct Windows run', () => {
    expect(() => selectNpmCommand({ platform: 'win32', execPath, env: {} })).toThrow('npm run test:mcp');
    expect(() => selectNpmCommand({ platform: 'win32', execPath, env: { npm_execpath: '' } })).toThrow('npm run test:mcp');
  });

  test('rejects other package managers on Windows', () => {
    expect(() => selectNpmCommand({
      platform: 'win32', execPath,
      env: { npm_config_user_agent: 'yarn/1.22.22 npm/? node/v24.0.0 win32 x64', npm_execpath: 'C:\\yarn\\bin\\yarn.js' },
    })).toThrow('npm run test:mcp');
    expect(() => selectNpmCommand({
      platform: 'win32', execPath, env: { npm_execpath: '/fixture/pnpm.cjs' },
    })).toThrow('npm run test:mcp');
  });

  test('falls back to npm on PATH elsewhere', () => {
    expect(selectNpmCommand({
      platform: 'linux', execPath,
      env: { npm_config_user_agent: 'yarn/1.22.22 npm/? node/v24.0.0 linux x64', npm_execpath: '/fixture/yarn.js' },
    })).toEqual({ file: 'npm', args: [] });
    expect(selectNpmCommand({ platform: 'darwin', execPath, env: {} })).toEqual({ file: 'npm', args: [] });
  });
});

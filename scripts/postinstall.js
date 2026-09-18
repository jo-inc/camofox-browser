// Compatibility entrypoint for repository tooling. Published installs run
// ../postinstall.js directly so only the lifecycle hook is shipped.
export { externalExecutableFromEnv, main } from '../postinstall.js';

import { main } from '../postinstall.js';
import { pathToFileURL } from 'node:url';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => process.exit(0));
}

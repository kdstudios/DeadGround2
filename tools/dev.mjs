// Dev mode: TypeScript watch + static server. Refresh the browser to see changes.
import { spawn } from 'node:child_process';
import { startServer } from './serve.mjs';

const tsc = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const watcher = spawn(tsc, ['tsc', '-p', '.', '--watch', '--preserveWatchOutput'], { stdio: 'inherit' });
startServer();
process.on('SIGINT', () => { watcher.kill(); process.exit(0); });

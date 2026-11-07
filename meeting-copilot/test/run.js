// Runs the tests under Electron's Node, because postinstall rebuilds better-sqlite3 for Electron's ABI.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const electron = require('electron'); // path to the electron binary
const tests = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js')).map((f) => path.join(__dirname, f));
const r = spawnSync(electron, ['--test', ...tests], { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
process.exit(r.status ?? 1);

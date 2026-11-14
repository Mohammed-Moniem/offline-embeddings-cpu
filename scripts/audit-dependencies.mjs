import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { packageRoot } from '../src/paths.mjs';
const lock = JSON.parse(await readFile(join(packageRoot, 'package-lock.json'), 'utf8'));
for (const [path, metadata] of Object.entries(lock.packages || {})) {
  if (/(^|\/)node_modules\/axios(\/|$)/i.test(path) || metadata.name?.toLowerCase() === 'axios') {
    throw new Error('Banned dependency found in lockfile: ' + path);
  }
  if (metadata.resolved && !metadata.resolved.startsWith('https://registry.npmjs.org/')) {
    throw new Error('Unexpected package source: ' + path);
  }
}
let installed = 0;
async function audit(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(directory, entry.name);
    if (entry.name.startsWith('@')) { await audit(path); continue; }
    const file = join(path, 'package.json');
    let metadata;
    try { metadata = JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    installed++;
    if (metadata.name?.toLowerCase() === 'axios') throw new Error('Banned installed dependency: ' + path);
    await audit(join(path, 'node_modules'));
  }
}
await audit(join(packageRoot, 'node_modules'));
console.log(JSON.stringify({ passed: true, lockedPackages: Object.keys(lock.packages).length - 1, installedPackages: installed, bannedDependency: 'absent' }));

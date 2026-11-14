import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// SHA-256 values from https://nodejs.org/en/blog/release/v24.18.0 .
const pins = {
  'darwin-arm64': { file: 'node-v24.18.0-darwin-arm64.tar.gz', sha256: 'e1a97e14c99c803e96c7339403282ea05a499c32f8d83defe9ef5ec66f979ed1' },
  'win32-x64': { file: 'win-x64/node.exe', sha256: '9a4eb5f1c29c6a2e93852ead46b999e284a6a5ca8bab4d4e241d587d025a52de' },
};
const options = parseArgs(process.argv.slice(2));
const target = `${process.platform}-${process.arch}`;
const pin = pins[target];
if (!pin) throw new Error(`Unsupported build host ${target}; build each archive on its target OS.`);
if (options['node-version'] && options['node-version'] !== '24.18.0') throw new Error('Only Node 24.18.0 has a checked-in upstream SHA-256 pin.');
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
for (const [dependency, expectedVersion] of Object.entries(pkg.dependencies || {})) {
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(expectedVersion)) throw new Error(`Direct dependency ${dependency} must have an exact version pin.`);
  const metadata = JSON.parse(await fs.readFile(path.join(root, 'node_modules', dependency, 'package.json'), 'utf8'));
  if (metadata.name !== dependency || metadata.version !== expectedVersion) {
    throw new Error(`Installed dependency ${dependency} does not match expected ${expectedVersion}.`);
  }
}
const output = path.resolve(options.output || path.join(root, 'dist'));
if (output === root) throw new Error('Output must be a separate directory.');
for (const input of ['src', 'scripts', 'test', 'docs', 'launchers', 'models', 'node_modules']) {
  const inputPath = path.join(root, input);
  if (output === inputPath || output.startsWith(inputPath + path.sep)) throw new Error('Output cannot be inside a release input directory.');
}
const name = `${pkg.name}-${pkg.version}-${target}`;
const stage = path.join(output, name);
const archivePath = `${stage}.zip`;
await fs.mkdir(output, { recursive: true });
await fs.rm(stage, { recursive: true, force: true });
await fs.mkdir(stage, { recursive: true });

// Copy only release inputs; never package local databases, secrets, Git or caches.
for (const item of ['src', 'scripts', 'test', 'docs', 'launchers', 'models', 'README.md', 'LICENSE', 'package.json', 'package-lock.json']) {
  const from = path.join(root, item);
  await fs.access(from);
  await fs.cp(from, path.join(stage, item), { recursive: true, dereference: true });
}
for (const item of ['rag.sh', 'rag.cmd']) {
  await fs.copyFile(path.join(root, 'launchers', item), path.join(stage, item));
}
if (process.platform !== 'win32') await fs.chmod(path.join(stage, 'rag.sh'), 0o755);

const lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'));
for (const location of Object.keys(lock.packages || {})) {
  if (/(^|\/)node_modules\/axios(?:\/|$)/i.test(location)) throw new Error('Banned HTTP dependency in lockfile.');
}
await fs.cp(path.join(root, 'node_modules'), path.join(stage, 'node_modules'), {
  recursive: true,
  dereference: true,
  filter: (source) => !source.split(path.sep).some((part) => part === '.cache' || part === '.bin'),
});
// ONNX ships several OS/CPU builds; retain the complete selected OS/CPU tree.
const onnxBin = path.join(stage, 'node_modules', 'onnxruntime-node', 'bin');
const napiDirs = (await fs.readdir(onnxBin, { withFileTypes: true })).filter((entry) => entry.isDirectory() && /^napi-v\d+$/.test(entry.name));
if (!napiDirs.length) throw new Error('ONNX Runtime native binaries are missing. Install the production dependencies on the build host first.');
for (const napi of napiDirs) {
  const napiRoot = path.join(onnxBin, napi.name);
  for (const entry of await fs.readdir(napiRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && ['darwin', 'linux', 'win32'].includes(entry.name) && entry.name !== process.platform) {
      await fs.rm(path.join(napiRoot, entry.name), { recursive: true, force: true });
    }
  }
  const selectedOs = path.join(napiRoot, process.platform);
  for (const entry of await fs.readdir(selectedOs, { withFileTypes: true })) {
    if (entry.isDirectory() && ['x64', 'arm64', 'ia32', 'arm'].includes(entry.name) && entry.name !== process.arch) {
      await fs.rm(path.join(selectedOs, entry.name), { recursive: true, force: true });
    }
  }
}

const cache = path.join(root, '.cache', 'bundle-inputs');
await fs.mkdir(cache, { recursive: true });
const runtimeDir = path.join(stage, 'runtime');
await fs.mkdir(runtimeDir, { recursive: true });
const runtimeInput = path.join(cache, path.basename(pin.file));
const runtimeUrl = `https://nodejs.org/dist/v24.18.0/${pin.file}`;
await downloadPinned(runtimeUrl, runtimeInput, pin.sha256);
if (process.platform === 'darwin') {
  const unpack = await fs.mkdtemp(path.join(cache, 'node-extract-'));
  try {
    await run('/usr/bin/tar', ['-xzf', runtimeInput, '-C', unpack]);
    const upstreamRoot = path.join(unpack, 'node-v24.18.0-darwin-arm64');
    await fs.copyFile(path.join(upstreamRoot, 'bin', 'node'), path.join(runtimeDir, 'node'));
    await fs.copyFile(path.join(upstreamRoot, 'LICENSE'), path.join(runtimeDir, 'LICENSE'));
    await fs.chmod(path.join(runtimeDir, 'node'), 0o755);
  } finally { await fs.rm(unpack, { recursive: true, force: true }); }
} else {
  await fs.copyFile(runtimeInput, path.join(runtimeDir, 'node.exe'));
  const license = await fetch('https://raw.githubusercontent.com/nodejs/node/v24.18.0/LICENSE', { signal: AbortSignal.timeout(60000) });
  if (!license.ok) throw new Error(`Node license download failed: ${license.status}`);
  await fs.writeFile(path.join(runtimeDir, 'LICENSE'), await license.text());
}
const nodePath = path.join(runtimeDir, process.platform === 'win32' ? 'node.exe' : 'node');
const nodeVersion = (await run(nodePath, ['--version'])).trim();
if (nodeVersion !== 'v24.18.0') throw new Error(`Unexpected bundled Node: ${nodeVersion}`);

let windowsCrt = null;
if (process.platform === 'win32') {
  const crtDir = options['windows-crt-dir'] || process.env.OFFLINE_EMBEDDINGS_CRT_DIR || await discoverCrt();
  if (!crtDir) throw new Error('No Microsoft x64 CRT redistributable directory found. Supply --windows-crt-dir pointing to an official Microsoft.VC143.CRT directory.');
  const dlls = (await fs.readdir(crtDir)).filter((name) => /^(vcruntime140.*|msvcp140.*|concrt140)\.dll$/i.test(name));
  for (const required of ['vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll', 'concrt140.dll']) {
    if (!dlls.some((name) => name.toLowerCase() === required)) throw new Error(`Official CRT directory is missing ${required}`);
  }
  for (const dll of dlls) {
    const source = path.join(crtDir, dll);
    const escaped = source.replaceAll("'", "''");
    await run(powershell(), ['-NoProfile', '-NonInteractive', '-Command', `$s=Get-AuthenticodeSignature -LiteralPath '${escaped}'; if($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -notmatch 'Microsoft'){exit 1}`]);
    await fs.copyFile(source, path.join(runtimeDir, dll));
  }
  windowsCrt = {
    deployment: 'app-local',
    provenance: 'Microsoft Visual Studio x64 Microsoft.VC143.CRT redistributable; every source DLL verified with Authenticode',
    documentation: 'https://learn.microsoft.com/en-us/cpp/windows/redistributing-visual-cpp-files',
    dlls,
  };
  await fs.writeFile(path.join(runtimeDir, 'MICROSOFT-CRT-NOTICE.txt'), `Microsoft Visual C++ runtime DLLs\nCopyright Microsoft Corporation. All rights reserved.\nThese signed redistributable runtime DLLs are deployed app-locally from the Microsoft Visual Studio x64 Microsoft.VC143.CRT redistributable directory.\nRedistribution and license terms: https://learn.microsoft.com/en-us/visualstudio/releases/2022/redistribution\nDeployment documentation: ${windowsCrt.documentation}\n`);
}

const licenses = [];
for (const location of Object.keys(lock.packages || {}).sort()) {
  if (!location.startsWith('node_modules/')) continue;
  const packageJson = path.join(stage, location, 'package.json');
  try {
    const metadata = JSON.parse(await fs.readFile(packageJson, 'utf8'));
    if (metadata.name?.toLowerCase() === 'axios') throw new Error('Banned HTTP dependency found in packaged files.');
    licenses.push({ name: metadata.name, version: metadata.version, license: metadata.license || 'See package license files', path: location });
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
await fs.writeFile(path.join(stage, 'THIRD-PARTY-LICENSES.json'), JSON.stringify({ node: 'runtime/LICENSE', windowsCrt, packages: licenses }, null, 2) + '\n');
const modelFile = path.join(stage, 'models', 'bge-small-en-v1.5', 'onnx', 'model_quantized.onnx');
const modelSha256 = await sha256(modelFile);
if (modelSha256 !== '6c9c6101a956d62dfb5e7190c538226c0c5bb9cb27b651234b6df063ee7dbfe4') throw new Error('Unexpected BGE q8 model checksum.');
const files = await fileManifest(stage);
const manifest = {
  schemaVersion: 1,
  package: { name: pkg.name, version: pkg.version },
  platform: process.platform,
  arch: process.arch,
  nodeVersion,
  createdAt: new Date().toISOString(),
  runtime: { url: runtimeUrl, upstreamSha256: pin.sha256, sha256: await sha256(nodePath) },
  model: { id: 'Xenova/bge-small-en-v1.5', revision: 'ea104dacec62c0de699686887e3f920caeb4f3e3', dtype: 'q8', sha256: modelSha256 },
  windowsCrt,
  files,
};
const manifestPath = path.join(stage, 'BUNDLE-MANIFEST.json');
await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
await fs.rm(archivePath, { force: true });
if (process.platform === 'darwin') await run('/usr/bin/ditto', ['-c', '-k', '--norsrc', '--noextattr', '--noqtn', '--keepParent', stage, archivePath]);
else await run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-a', '-c', '-f', archivePath, '-C', output, name]);
const sha256Path = `${archivePath}.sha256`;
const archiveSha256 = await sha256(archivePath);
await fs.writeFile(sha256Path, `${archiveSha256}  ${path.basename(archivePath)}\n`);
console.log(JSON.stringify({ platform: process.platform, arch: process.arch, nodeVersion, archivePath, archiveSha256, sha256Path, stagingPath: stage, manifestPath }));

function parseArgs(args) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    if (!['--output', '--node-version', '--windows-crt-dir'].includes(args[i]) || !args[i + 1]) throw new Error(`Unknown or incomplete argument: ${args[i]}`);
    result[args[i].slice(2)] = args[++i];
  }
  return result;
}
async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function downloadPinned(url, destination, expected) {
  try { if (await sha256(destination) === expected) return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const partial = `${destination}.partial`;
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok || !response.body) throw new Error(`Runtime download failed: ${response.status}`);
  try {
    await pipeline(response.body, createWriteStream(partial));
    if (await sha256(partial) !== expected) throw new Error('Official runtime SHA-256 mismatch.');
    await fs.rm(destination, { force: true });
    await fs.rename(partial, destination);
  } finally { await fs.rm(partial, { force: true }); }
}
async function fileManifest(directory, prefix = '') {
  const items = [];
  for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) items.push(...await fileManifest(absolute, relative));
    else if (entry.isFile()) items.push({ path: relative, size: (await fs.stat(absolute)).size, sha256: await sha256(absolute) });
    else throw new Error(`Unexpected non-file in bundle: ${relative}`);
  }
  return items;
}
function run(command, args) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    // A parent pwsh PSModulePath can break built-in modules in Windows PowerShell.
    // Each PowerShell runtime should construct its own default module search path.
    if (/(?:powershell|pwsh)\.exe$/i.test(command)) delete env.PSModulePath;
    const child = spawn(command, args, { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve(stdout) : reject(new Error(`${command} exited ${code}: ${stderr || stdout}`)));
  });
}
function powershell() {
  const modern = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe');
  return existsSync(modern) ? modern : path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}
async function discoverCrt() {
  const candidates = [];
  if (process.env.VCToolsRedistDir) candidates.push(path.join(process.env.VCToolsRedistDir, 'x64', 'Microsoft.VC143.CRT'));
  for (const programFiles of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)) {
    const vs = path.join(programFiles, 'Microsoft Visual Studio');
    for (const year of (await fs.readdir(vs).catch(() => [])).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
      for (const edition of ['Enterprise', 'Professional', 'Community', 'BuildTools']) {
        const redist = path.join(vs, year, edition, 'VC', 'Redist', 'MSVC');
        for (const version of (await fs.readdir(redist).catch(() => [])).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
          candidates.push(path.join(redist, version, 'x64', 'Microsoft.VC143.CRT'));
        }
      }
    }
  }
  for (const candidate of candidates) {
    try { await fs.access(path.join(candidate, 'vcruntime140.dll')); return candidate; } catch {}
  }
  return null;
}

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const options = parseArgs(process.argv.slice(2));
if (!options.archive) throw new Error('Usage: node scripts/verify-bundle.mjs --archive FILE.zip [--output REPORT.json] [--firewall]');
const archive = path.resolve(options.archive);
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'offline embeddings extracted '));
const report = { schemaVersion: 1, startedAt: new Date().toISOString(), archive, platform: process.platform, arch: process.arch, extractedTo: workspace, passed: false };
const output = options.output ? path.resolve(options.output) : null;
let firewallRule = null;
try {
  const expected = (await fs.readFile(`${archive}.sha256`, 'utf8')).trim().split(/\s+/)[0];
  report.archiveSha256 = await sha256(archive);
  if (!/^[0-9a-f]{64}$/.test(expected) || report.archiveSha256 !== expected) throw new Error('Archive checksum mismatch.');
  if (process.platform === 'darwin') await run('/usr/bin/ditto', ['-x', '-k', archive, workspace]);
  else if (process.platform === 'win32') await run(system('tar.exe'), ['-xf', archive, '-C', workspace]);
  else throw new Error('Extracted acceptance is supported on macOS and Windows targets.');
  const roots = (await fs.readdir(workspace, { withFileTypes: true })).filter((entry) => entry.isDirectory() && entry.name !== '__MACOSX');
  if (roots.length !== 1) throw new Error('Archive must contain exactly one package directory.');
  const extracted = await fs.realpath(path.join(workspace, roots[0].name));
  report.packageDirectory = extracted;
  const manifest = JSON.parse(await fs.readFile(path.join(extracted, 'BUNDLE-MANIFEST.json'), 'utf8'));
  if (manifest.platform !== process.platform || manifest.arch !== process.arch) throw new Error('Archive target does not match current host.');
  for (const file of manifest.files) {
    const absolute = safeChild(extracted, file.path);
    if ((await fs.stat(absolute)).size !== file.size || await sha256(absolute) !== file.sha256) throw new Error(`Extracted file checksum mismatch: ${file.path}`);
  }
  report.verifiedFiles = manifest.files.length;
  const node = await fs.realpath(path.join(extracted, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'));
  const emptyPath = path.join(workspace, 'empty executable path');
  const userHome = path.join(workspace, 'fresh user home');
  const data = path.join(workspace, 'fresh data');
  await Promise.all([emptyPath, userHome, data].map((directory) => fs.mkdir(directory, { recursive: true })));
  const env = {
    PATH: emptyPath,
    HOME: userHome,
    USERPROFILE: userHome,
    APPDATA: path.join(userHome, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(userHome, 'AppData', 'Local'),
    TMPDIR: workspace,
    TMP: workspace,
    TEMP: workspace,
    OFFLINE_EMBEDDINGS_DATA: data,
    HF_HUB_OFFLINE: '1',
    TRANSFORMERS_OFFLINE: '1',
    LANG: 'en_US.UTF-8',
    ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot || 'C:\\Windows', WINDIR: process.env.WINDIR || 'C:\\Windows' } : {}),
  };
  let command = node;
  let prefix = [];
  if (process.platform === 'darwin') {
    command = '/usr/bin/sandbox-exec';
    prefix = ['-p', '(version 1) (allow default) (deny network*)', node];
    report.networkIsolation = 'macOS sandbox-exec deny network*';
  } else {
    if (!options.firewall) throw new Error('Windows acceptance requires --firewall on an elevated test runner to prove OS-level network denial. Normal package use does not require administrator access.');
    firewallRule = `OfflineEmbeddingsAcceptance-${randomUUID()}`;
    await run(powershell(), ['-NoProfile', '-NonInteractive', '-Command',
      `$ErrorActionPreference='Stop'; New-NetFirewallRule -Name ${psLiteral(firewallRule)} -DisplayName ${psLiteral(firewallRule)} -Direction Outbound -Action Block -Program ${psLiteral(node)} -Enabled True -Profile Any | Out-Null`]);
    report.networkIsolation = 'Windows Defender Firewall per-program outbound block';
    const rule = JSON.parse((await run(powershell(), ['-NoProfile', '-NonInteractive', '-Command',
      `$ErrorActionPreference='Stop'; $r=Get-NetFirewallRule -Name ${psLiteral(firewallRule)}; $a=$r | Get-NetFirewallApplicationFilter; [pscustomobject]@{Name=$r.Name;Enabled=$r.Enabled.ToString();Direction=$r.Direction.ToString();Action=$r.Action.ToString();Program=$a.Program} | ConvertTo-Json -Compress`])).trim());
    if (rule.Name !== firewallRule || rule.Enabled !== 'True' || rule.Direction !== 'Outbound' || rule.Action !== 'Block' || normalizeWindowsPath(rule.Program) !== normalizeWindowsPath(node)) {
      throw new Error('Could not confirm Windows network-denial rule and executable path.');
    }
    report.firewallRule = rule;
  }
  // Verify denied native socket access, independently of Transformers' offline flags.
  const probe = `const net=await import('node:net');const s=net.connect({host:'1.1.1.1',port:443});const timer=setTimeout(()=>{s.destroy();console.log('NETWORK_DENIED:timeout')},3000);s.on('connect',()=>{clearTimeout(timer);s.destroy();console.error('NETWORK_UNEXPECTEDLY_ALLOWED');process.exitCode=3});s.on('error',e=>{clearTimeout(timer);console.log('NETWORK_DENIED:'+e.code)});`;
  report.networkProbe = (await run(command, [...prefix, '--input-type=module', '-e', probe], { cwd: extracted, env })).trim();
  if (!report.networkProbe.startsWith('NETWORK_DENIED:')) throw new Error('Network-denial probe did not confirm denial.');
  report.nodeVersion = (await run(command, [...prefix, '--version'], { cwd: extracted, env })).trim();
  if (report.nodeVersion !== manifest.nodeVersion) throw new Error('Runtime version differs from manifest.');
  const verificationFile = path.join(workspace, 'functional verification.json');
  const stdout = await run(command, [...prefix, path.join(extracted, 'scripts', 'verify.mjs'), '--output', verificationFile], { cwd: extracted, env, timeoutMs: 600000 });
  report.functional = JSON.parse(await fs.readFile(verificationFile, 'utf8'));
  if (report.functional.passed !== true) throw new Error('Functional verification did not explicitly report passed=true.');
  report.functionalStdout = stdout.trim();
  const launcherStdout = process.platform === 'darwin'
    ? await run('/usr/bin/sandbox-exec', ['-p', '(version 1) (allow default) (deny network*)', '/bin/sh', path.join(extracted, 'rag.sh'), 'doctor'], { cwd: extracted, env, timeoutMs: 120000 })
    : await run(system('cmd.exe'), ['/d', '/c', 'call .\\rag.cmd doctor'], { cwd: extracted, env, timeoutMs: 120000 });
  report.launcher = JSON.parse(launcherStdout.trim());
  if (report.launcher.ready !== true || report.launcher.node !== manifest.nodeVersion) throw new Error('Bundled launcher did not report ready=true with the pinned runtime.');
  // Prove native dependencies load under the same isolation and record DLL origins.
  const nativeProbe = `await import('@huggingface/transformers');await import('onnxruntime-node');console.log(JSON.stringify({sharedObjects:process.report.getReport().sharedObjects}));`;
  const native = JSON.parse((await run(command, [...prefix, '--input-type=module', '-e', nativeProbe], { cwd: extracted, env })).trim());
  report.loadedSharedObjects = native.sharedObjects;
  if (process.platform === 'win32') {
    const crt = native.sharedObjects.filter((filename) => /(?:vcruntime140.*|msvcp140.*|concrt140)\.dll$/i.test(filename));
    report.loadedMicrosoftCrt = crt;
    if (!crt.length || !Array.isArray(manifest.windowsCrt?.copies) || !manifest.windowsCrt.copies.length) throw new Error('Microsoft CRT deployment or loaded-library evidence is missing.');
    const allowedCopies = new Map();
    const declaredFiles = new Map(manifest.files.map((file) => [file.path, file.sha256]));
    for (const copy of manifest.windowsCrt.copies) {
      const packagedPath = await fs.realpath(safeChild(extracted, copy.path));
      if (declaredFiles.get(copy.path) !== copy.sha256 || await sha256(packagedPath) !== copy.sha256) throw new Error(`Microsoft CRT manifest checksum mismatch: ${copy.path}`);
      allowedCopies.set(normalizeWindowsPath(packagedPath), copy);
    }
    report.microsoftCrtVerification = [];
    for (const loadedPath of crt) {
      const canonicalPath = await fs.realpath(loadedPath);
      const copy = allowedCopies.get(normalizeWindowsPath(canonicalPath));
      if (!copy) throw new Error(`Microsoft CRT loaded outside explicitly packaged locations: ${loadedPath}`);
      const loadedSha256 = await sha256(canonicalPath);
      if (loadedSha256 !== copy.sha256) throw new Error(`Loaded Microsoft CRT checksum mismatch: ${loadedPath}`);
      report.microsoftCrtVerification.push({ loadedPath: canonicalPath, packagedPath: copy.path, sha256: loadedSha256 });
    }
  }
  report.passed = true;
} catch (error) {
  report.error = error.stack || String(error);
  process.exitCode = 1;
} finally {
  if (firewallRule) {
    try { await run(powershell(), ['-NoProfile', '-NonInteractive', '-Command',
      `$ErrorActionPreference='Stop'; Get-NetFirewallRule -Name ${psLiteral(firewallRule)} -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction Stop; if(Get-NetFirewallRule -Name ${psLiteral(firewallRule)} -ErrorAction SilentlyContinue){throw 'Firewall rule cleanup failed'}`]); }
    catch (error) { report.firewallCleanupError = String(error); report.passed = false; process.exitCode = 1; }
  }
  report.finishedAt = new Date().toISOString();
  if (output) {
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify(report, null, 2));
}

function parseArgs(args) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--firewall') result.firewall = true;
    else if (['--archive', '--output'].includes(args[i]) && args[i + 1]) result[args[i].slice(2)] = args[++i];
    else throw new Error(`Unknown or incomplete argument: ${args[i]}`);
  }
  return result;
}
function safeChild(directory, relative) {
  const result = path.resolve(directory, relative);
  if (!result.startsWith(directory + path.sep)) throw new Error(`Unsafe manifest path ${relative}`);
  return result;
}
function system(binary) { return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', binary); }
function powershell() {
  const modern = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe');
  return existsSync(modern) ? modern : system(path.join('WindowsPowerShell', 'v1.0', 'powershell.exe'));
}
function psLiteral(value) { return "'" + String(value).replaceAll("'", "''") + "'"; }
function normalizeWindowsPath(filename) {
  let result = String(filename);
  if (result.startsWith('\\\\?\\') || result.startsWith('\\??\\')) result = result.slice(4);
  if (result.startsWith('UNC\\')) result = '\\\\' + result.slice(4);
  return path.win32.normalize(result).toLowerCase();
}
async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const env = options.env ? { ...options.env } : { ...process.env };
    if (/(?:powershell|pwsh)\.exe$/i.test(command)) delete env.PSModulePath;
    const child = spawn(command, args, { cwd: options.cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${command} timed out`)); }, options.timeoutMs || 120000);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); code === 0 ? resolve(stdout) : reject(new Error(`${command} exited ${code}: ${stderr || stdout}`)); });
  });
}

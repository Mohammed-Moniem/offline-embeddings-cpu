import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { cpus, release, tmpdir, totalmem } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { syncBuiltinESMExports } from 'node:module';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${name} needs a value`);
  return args[index + 1];
}
const outputPath = option('--output');
const modelDir = resolve(option('--model-dir') ?? process.env.OFFLINE_EMBEDDINGS_MODEL_DIR ?? join(packageRoot, 'models', 'bge-small-en-v1.5'));

// Defense in depth, not a substitute for the bundle verifier's OS-level sandbox.
// Install before loading Transformers.js so its network clients cannot capture
// an unguarded fetch or socket constructor during import.
const networkAttempts = [];
function blocked(operation) {
  return function () {
    networkAttempts.push(operation);
    throw new Error(`Offline verification blocked network operation: ${operation}`);
  };
}
globalThis.fetch = blocked('fetch');
http.request = blocked('http.request');
http.get = blocked('http.get');
https.request = blocked('https.request');
https.get = blocked('https.get');
net.connect = blocked('net.connect');
net.createConnection = blocked('net.createConnection');
net.Socket.prototype.connect = blocked('net.Socket.connect');
tls.connect = blocked('tls.connect');
syncBuiltinESMExports();

const report = {
  passed: false,
  testedAt: new Date().toISOString(),
  platform: process.platform,
  architecture: process.arch,
  node: process.version,
  host: { osRelease: release(), cpuModel: cpus()[0]?.model, logicalCpus: cpus().length, ramBytes: totalmem() },
  network: { guard: 'JavaScript fetch and sockets blocked', osLevelProof: 'Run through scripts/verify-bundle.mjs for OS-level network-denial evidence.' },
  checks: [],
  timingsMs: {},
};
let directory;
let rag;
let engine;

async function check(name, action) {
  const before = performance.now();
  await action();
  report.checks.push(name);
  report.timingsMs[name] = Math.round((performance.now() - before) * 100) / 100;
}

async function modelFiles() {
  const root = await realpath(modelDir);
  const result = [];
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      const actual = await realpath(full);
      const rel = relative(root, actual);
      assert.ok(rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), 'Model files must remain inside the model directory');
      if (entry.isDirectory()) await visit(full);
      else {
        const bytes = await readFile(full);
        result.push({ path: relative(root, full).split(sep).join('/'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
      }
    }
  }
  await visit(root);
  assert.ok(result.some(file => file.path === 'config.json'), 'Bundled config.json is missing');
  assert.ok(result.some(file => file.path === 'tokenizer.json'), 'Bundled tokenizer.json is missing');
  assert.ok(result.some(file => file.path.endsWith('.onnx') && file.bytes > 1_000_000), 'Bundled ONNX weights are missing');
  return result;
}

function verifyChunkCoverage(text, chunks, maxTokens = 384) {
  let coveredUntil = 0;
  let previousStart = -1;
  for (const chunk of chunks) {
    assert.equal(chunk.text, text.slice(chunk.start, chunk.end));
    assert.ok(Number.isInteger(chunk.start) && Number.isInteger(chunk.end));
    assert.ok(chunk.start > previousStart && chunk.end > chunk.start && chunk.end <= text.length, 'Chunks must advance through the source');
    assert.ok(chunk.text.isWellFormed(), 'A chunk split a UTF-16 surrogate pair');
    assert.ok(chunk.tokens <= maxTokens, 'Chunk exceeds the requested token budget');
    assert.ok(!text.slice(coveredUntil, chunk.start).trim(), 'Chunking dropped non-whitespace source content');
    coveredUntil = Math.max(coveredUntil, chunk.end);
    previousStart = chunk.start;
  }
  assert.ok(!text.slice(coveredUntil).trim(), 'Chunking dropped the document tail');
}

try {
  assert.match(process.versions.node, /^24\./, 'This package is validated against Node 24');
  await check('local-model-files', async () => { report.modelFiles = await modelFiles(); });
  const { EmbeddingEngine } = await import('../src/embedding.mjs');
  const { openRag } = await import('../src/index.mjs');
  await check('cold-model-start', async () => {
    engine = await EmbeddingEngine.create({ modelDir, threads: 2 });
    report.embeddingIdentity = engine.identity;
    assert.equal(engine.identity.dtype, 'q8');
    assert.equal(engine.identity.pooling, 'cls');
    assert.equal(engine.identity.normalize, true);
    assert.equal(engine.identity.dimensions, 384);
    assert.equal(engine.identity.queryPrefix, 'Represent this sentence for searching relevant passages: ');
  });
  await check('embedding-shape-and-normalization', async () => {
    const vectors = await engine.embedDocuments(['Business travel expenses require receipts.', 'Employees should use a password manager.']);
    assert.equal(vectors.length, 2);
    const queryVector = await engine.embedQuery('How can I get paid back for a work trip?');
    for (const vector of [...vectors, queryVector]) {
      assert.equal(vector.length, 384);
      assert.ok(Array.from(vector).every(Number.isFinite));
      assert.ok(Math.abs(Math.hypot(...vector) - 1) < 0.001, 'Embedding is not L2-normalized');
    }
  });
  await check('empty-unicode-unbroken-and-query-limits', async () => {
    assert.deepEqual(engine.chunk(''), []);
    assert.deepEqual(engine.chunk(' \t\r\n '), []);
    assert.deepEqual(await engine.embedDocuments([]), []);
    const unicode = '  👩🏽‍💻 Café: العربية 日本語.\nBusiness travel expenses and receipts. '.repeat(45);
    const unbroken = 'abcdefghij'.repeat(2000);
    for (const text of [unicode, unbroken]) {
      const chunks = engine.chunk(text, { maxTokens: 384, overlapTokens: 48 });
      assert.ok(chunks.length > 0);
      if (text === unbroken) {
        assert.ok(chunks.length <= 4, `Huge unknown word produced ${chunks.length} overlapping chunks instead of at most four`);
        report.unbrokenDocument = { characters: text.length, chunks: chunks.length };
      }
      verifyChunkCoverage(text, chunks);
    }
    await assert.rejects(engine.embedQuery('reimbursement '.repeat(600)), /512|token|limit/i);
    await assert.rejects(engine.embedDocuments(['reimbursement '.repeat(600)]), /512|token|limit/i);
    await assert.rejects(engine.embedQuery(' \n '), /empty/i);
  });
  directory = await mkdtemp(join(tmpdir(), 'offline-embeddings-verification-'));
  const dbPath = join(directory, 'verification.sqlite');
  rag = await openRag({ dbPath, engine });
  const travel = 'Employees may claim reimbursement for business travel expenses. Submit itemized receipts to Finance within thirty days of returning from the trip.';
  await check('paraphrase-retrieval', async () => {
    await rag.index({ id: 'travel', text: travel, source: 'policies/travel.md' });
    await rag.index({ id: 'security', text: 'Use a password manager and multifactor authentication. Never share login credentials with colleagues.', source: 'policies/security.md' });
    await rag.index({ id: 'kitchen', text: 'The staff kitchen serves coffee and tea. Refrigerators are cleaned every Friday.', source: 'policies/kitchen.md' });
    const before = performance.now();
    const hits = await rag.search('How do I get paid back for a work trip?', { mode: 'semantic', limit: 3 });
    report.timingsMs.semanticQuery = Math.round((performance.now() - before) * 100) / 100;
    assert.equal(hits[0]?.id, 'travel', 'Paraphrase query failed to find the travel policy first');
    assert.equal(hits[0].source, 'policies/travel.md');
    assert.equal(hits[0].text, travel.slice(hits[0].start, hits[0].end));
    const unchanged = await rag.index({ id: 'travel', text: travel, source: 'policies/travel.md' });
    assert.equal(unchanged.changed, false);
  });
  await check('collection-before-top-k', async () => {
    for (let index = 0; index < 6; index += 1) {
      await rag.index({ id: `restricted-${index}`, text: travel, collection: 'restricted' });
    }
    await rag.index({ id: 'visible', text: travel, collection: 'visible' });
    for (const mode of ['semantic', 'keyword', 'hybrid']) {
      const hits = await rag.search('business travel expenses', { collection: 'visible', limit: 1, mode });
      assert.equal(hits.length, 1);
      assert.equal(hits[0].id, 'visible');
      assert.equal(hits[0].collection, 'visible');
      assert.deepEqual(await rag.search('business travel', { collection: 'missing', mode }), []);
    }
  });
  const filler = 'The office archive lists conference room names, approved stationery colours, building maintenance dates, and the regular cleaning schedule. ';
  const tail = 'For overseas hotel reimbursement, upload the invoice to TravelDesk within thirty days. Finance pays refunds after manager approval.';
  const longText = `  Café workplace handbook.\n\n${filler.repeat(100)}\n\n${tail}`;
  await check('token-chunking-and-source-offsets', async () => {
    const chunks = engine.chunk(longText, { maxTokens: 384, overlapTokens: 48 });
    assert.ok(chunks.length > 2, 'Long input was not split');
    verifyChunkCoverage(longText, chunks);
    assert.ok(chunks.some(chunk => chunk.text.includes('TravelDesk')));
    report.longDocument = { characters: longText.length, chunks: chunks.length };
  });
  await check('long-document-tail-retrieval', async () => {
    await rag.index({ id: 'handbook', text: longText, collection: 'long-documents' });
    const hits = await rag.search('How do I get reimbursed for a hotel while travelling abroad?', { collection: 'long-documents', mode: 'semantic', limit: 3 });
    assert.ok(hits.some(hit => hit.text.includes('TravelDesk')), 'The relevant tail of the long document was not retrieved');
    for (const hit of hits) assert.equal(hit.text, longText.slice(hit.start, hit.end));
  });
  await check('replacement-and-deletion', async () => {
    await rag.index({ id: 'mutable', text: 'obsoleteverificationword describes an old policy.', collection: 'mutations' });
    await rag.index({ id: 'mutable', text: 'replacementverificationword describes the new policy.', collection: 'mutations' });
    assert.deepEqual(await rag.search('obsoleteverificationword', { collection: 'mutations', mode: 'keyword' }), []);
    assert.equal((await rag.search('replacementverificationword', { collection: 'mutations', mode: 'keyword' }))[0]?.id, 'mutable');
    assert.equal(rag.remove('mutable', { collection: 'mutations' }), true);
    for (const mode of ['semantic', 'keyword', 'hybrid']) {
      assert.deepEqual(await rag.search('new policy', { collection: 'mutations', mode }), []);
    }
  });
  await check('database-reopen', async () => {
    const before = rag.stats();
    rag.close();
    rag = await openRag({ dbPath, engine });
    assert.equal(rag.stats().documents, before.documents);
    assert.equal(rag.stats().chunks, before.chunks);
    assert.equal((await rag.search('work trip expenses', { mode: 'semantic', limit: 1 }))[0]?.id, 'travel');
    report.database = { ...rag.stats(), bytes: (await stat(dbPath)).size };
  });
  assert.equal(networkAttempts.length, 0, 'Inference or retrieval attempted a network request');
  report.network.attempts = networkAttempts;
  report.memory = { rssBytes: process.memoryUsage().rss, maxRssBytes: process.resourceUsage().maxRSS * 1024 };
  report.loadedSharedObjects = process.report.getReport().sharedObjects;
  report.passed = true;
} catch (error) {
  report.error = { name: error.name, message: error.message, stack: error.stack };
  report.network.attempts = networkAttempts;
  process.exitCode = 1;
} finally {
  await rag?.close();
  await engine?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
}

if (outputPath) {
  await mkdir(dirname(resolve(outputPath)), { recursive: true });
  await writeFile(resolve(outputPath), `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify(report));

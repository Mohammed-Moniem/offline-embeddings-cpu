import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRag } from '../src/index.mjs';

// The fake makes database tests fast and deterministic. Real inference and
// model-specific behavior are checked separately by scripts/verify.mjs.
class FakeEngine {
  identity = {
    model: 'test/semantic-fixture', revision: 'fixture-v1', dimensions: 384,
    pooling: 'cls', normalize: true, queryInstruction: 'fixture query: ',
  };
  documentCalls = 0;
  documentCount = 0;
  failNext = false;

  chunk(text) {
    const chunks = [];
    const pattern = /\S[\s\S]*?(?=\n\s*\n|$)/g;
    for (const match of text.matchAll(pattern)) {
      const content = match[0].trimEnd();
      chunks.push({ text: content, start: match.index, end: match.index + content.length,
        tokens: content.split(/\s+/u).length });
    }
    return chunks;
  }

  vector(text) {
    const result = new Array(384).fill(0);
    const synonyms = new Map([
      ['refund', 'expense'], ['reimbursement', 'expense'], ['reimburse', 'expense'],
      ['expenses', 'expense'], ['travel', 'journey'], ['trip', 'journey'],
      ['passwords', 'password'], ['secrets', 'password'],
    ]);
    for (let word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
      word = synonyms.get(word) ?? word;
      let hash = 2166136261;
      for (const char of word) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
      result[(hash >>> 0) % 383] += 1;
    }
    result[383] = 0.01;
    const length = Math.hypot(...result);
    return result.map(value => value / length);
  }

  async embedDocuments(texts) {
    this.documentCalls += 1;
    this.documentCount += texts.length;
    if (this.failNext) {
      this.failNext = false;
      throw new Error('Deliberate embedding failure');
    }
    return texts.map(text => this.vector(text));
  }

  async embedQuery(text) { return this.vector(text); }
}

async function fixture(t, engine = new FakeEngine()) {
  const directory = await mkdtemp(join(tmpdir(), 'offline-rag-unit-'));
  const dbPath = join(directory, 'rag.sqlite');
  let rag = await openRag({ dbPath, engine });
  t.after(async () => {
    rag?.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    engine, dbPath,
    get rag() { return rag; },
    async reopen(nextEngine = new FakeEngine()) {
      rag.close();
      rag = null;
      rag = await openRag({ dbPath, engine: nextEngine });
      return rag;
    },
  };
}

test('indexes source offsets and skips embedding for an unchanged document', async t => {
  const f = await fixture(t);
  const text = '  Expenses require a receipt.\n\nCafé travel policy has two steps.  ';
  assert.equal(f.rag.stats().documents, 0);
  const first = await f.rag.index({ id: 'policy', text, source: '/fixture/policy.md' });
  assert.equal(first.changed, true);
  assert.equal(first.id, 'policy');
  assert.equal(first.chunks, 2);
  const calls = f.engine.documentCalls;
  const second = await f.rag.index({ id: 'policy', text, source: '/fixture/policy.md' });
  assert.equal(second.changed, false);
  assert.equal(f.engine.documentCalls, calls);
  assert.equal(f.rag.stats().documents, 1);
  assert.equal(f.rag.stats().chunks, 2);
  const hits = await f.rag.search('expenses receipt', { mode: 'semantic', limit: 10 });
  assert.ok(hits.length > 0);
  for (const hit of hits) {
    assert.equal(hit.id, 'policy');
    assert.equal(hit.source, '/fixture/policy.md');
    assert.equal(hit.text, text.slice(hit.start, hit.end));
    assert.ok(Number.isFinite(hit.score));
  }
});

test('documents and model identity survive database close and reopen', async t => {
  const f = await fixture(t);
  await f.rag.index({ id: 'expenses', text: 'Travel expenses require receipts.', source: 'policy.md' });
  await f.reopen();
  assert.equal(f.rag.stats().documents, 1);
  const hits = await f.rag.search('travel refund', { mode: 'semantic' });
  assert.equal(hits[0].id, 'expenses');
  assert.equal(hits[0].source, 'policy.md');
});

test('collection is applied before top-k and document IDs are collection-local', async t => {
  const f = await fixture(t);
  const text = 'Travel reimbursement requires a receipt.';
  for (let index = 0; index < 8; index += 1) {
    await f.rag.index({ id: `private-${index}`, text, collection: 'private' });
  }
  await f.rag.index({ id: 'shared-id', text, collection: 'public', source: 'public.md' });
  await f.rag.index({ id: 'shared-id', text: 'Password security is confidential.', collection: 'private' });
  for (const mode of ['semantic', 'keyword', 'hybrid']) {
    const hits = await f.rag.search('travel reimbursement receipt', { collection: 'public', limit: 1, mode });
    assert.equal(hits.length, 1, `${mode}: filtered top-k must retain an available public hit`);
    assert.equal(hits[0].id, 'shared-id');
    assert.equal(hits[0].collection, 'public');
    assert.equal(hits[0].source, 'public.md');
    assert.deepEqual(await f.rag.search('travel', { collection: 'absent', mode }), []);
  }
  assert.equal(f.rag.remove('shared-id', { collection: 'public' }), true);
  assert.equal(f.rag.stats().documents, 9);
  const privateHits = await f.rag.search('password security', { collection: 'private', mode: 'keyword' });
  assert.ok(privateHits.some(hit => hit.id === 'shared-id'));
});

test('replacement removes stale chunks and preserves the other document', async t => {
  const f = await fixture(t);
  await f.rag.index({ id: 'changing', text: 'obsoleteword archive.\n\nOld travel receipts.', source: 'old.md' });
  await f.rag.index({ id: 'other', text: 'Untouched security handbook.' });
  const text = 'replacementword password security.';
  const result = await f.rag.index({ id: 'changing', text, source: 'new.md' });
  assert.equal(result.changed, true);
  assert.equal(f.rag.stats().documents, 2);
  assert.equal(f.rag.stats().chunks, 2);
  assert.deepEqual(await f.rag.search('obsoleteword', { mode: 'keyword' }), []);
  const hits = await f.rag.search('replacementword', { mode: 'keyword' });
  assert.equal(hits[0].id, 'changing');
  assert.equal(hits[0].text, text);
  assert.equal(hits[0].source, 'new.md');
  assert.ok((await f.rag.search('Untouched', { mode: 'keyword' })).some(hit => hit.id === 'other'));
});

test('failed embedding neither destroys the old version nor publishes partial new documents', async t => {
  const f = await fixture(t);
  await f.rag.index({ id: 'existing', text: 'retainedword policy stays available.' });
  f.engine.failNext = true;
  await assert.rejects(f.rag.index({ id: 'existing', text: 'failedword replacement.\n\nAnother new chunk.' }), /embedding failure/i);
  assert.equal(f.rag.stats().documents, 1);
  assert.equal(f.rag.stats().chunks, 1);
  assert.equal((await f.rag.search('retainedword', { mode: 'keyword' }))[0].id, 'existing');
  assert.deepEqual(await f.rag.search('failedword', { mode: 'keyword' }), []);
  f.engine.failNext = true;
  await assert.rejects(f.rag.index({ id: 'new-document', text: 'notpublishedword content.' }), /embedding failure/i);
  assert.equal(f.rag.stats().documents, 1);
  await f.reopen();
  assert.equal(f.rag.stats().documents, 1);
  assert.deepEqual(await f.rag.search('notpublishedword', { mode: 'keyword' }), []);
});

test('failed database insertion rolls back the original document and every search index', async t => {
  const f = await fixture(t);
  const original = 'rollbackretainedword travel policy.';
  await f.rag.index({ id: 'existing', text: original, source: 'original.md' });
  const chunk = f.engine.chunk.bind(f.engine);
  f.engine.chunk = text => {
    const chunks = chunk(text);
    return chunks.map((item, index) => index === chunks.length - 1 ? { ...item, start: item.start + 1 } : item);
  };
  await assert.rejects(f.rag.index({ id: 'existing', text: 'rollbackfailedword new chunk.\n\nInvalid offsets in final chunk.', source: 'new.md' }), /offset|chunk/i);
  assert.equal(f.rag.stats().documents, 1);
  assert.equal(f.rag.stats().chunks, 1);
  for (const mode of ['keyword', 'semantic', 'hybrid']) {
    const hits = await f.rag.search('rollbackretainedword travel policy', { mode });
    assert.equal(hits[0]?.id, 'existing');
    assert.equal(hits[0].text, original);
    assert.equal(hits[0].source, 'original.md');
  }
  assert.deepEqual(await f.rag.search('rollbackfailedword', { mode: 'keyword' }), []);
});

test('remove is idempotent and clears semantic and keyword retrieval', async t => {
  const f = await fixture(t);
  await f.rag.index({ id: 'remove-me', text: 'uniquedeletionword journey refund.' });
  assert.equal(f.rag.remove('remove-me', { collection: 'wrong' }), false);
  assert.equal(f.rag.remove('remove-me'), true);
  assert.equal(f.rag.remove('remove-me'), false);
  assert.equal(f.rag.stats().documents, 0);
  assert.equal(f.rag.stats().chunks, 0);
  for (const mode of ['semantic', 'keyword', 'hybrid']) {
    assert.deepEqual(await f.rag.search('uniquedeletionword', { mode }), []);
  }
});

test('remove cannot race pending indexing and the completed document remains removable', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const embedDocuments = f.engine.embedDocuments.bind(f.engine);
  let release;
  let entered;
  const blocked = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  f.engine.embedDocuments = async texts => {
    entered();
    await blocked;
    return embedDocuments(texts);
  };
  const indexing = f.rag.index({ id: 'pending', text: 'Pending travel reimbursement policy.' });
  await started;
  try {
    assert.throws(() => f.rag.remove('pending'), /await|pending|indexing/i);
  } finally {
    release();
  }
  await indexing;
  assert.equal(f.rag.remove('pending'), true);
  assert.equal(f.rag.stats().documents, 0);
  assert.deepEqual(await f.rag.search('travel reimbursement', { mode: 'semantic' }), []);
});

test('incompatible embedding identity cannot silently reuse an existing index', async t => {
  const f = await fixture(t);
  await f.rag.index({ id: 'policy', text: 'Travel expenses policy.' });
  const incompatible = new FakeEngine();
  incompatible.identity = { ...incompatible.identity, revision: 'fixture-v2' };
  await assert.rejects(f.reopen(incompatible), /identity|incompatible|model|embedding/i);
});

test('search modes obey limit and invalid modes or limits are rejected', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 4; index += 1) {
    await f.rag.index({ id: `policy-${index}`, text: `Travel expenses receipt number ${index}.` });
  }
  for (const mode of ['semantic', 'keyword', 'hybrid']) {
    const hits = await f.rag.search('travel expenses receipt', { mode, limit: 2 });
    assert.equal(hits.length, 2, mode);
  }
  await assert.rejects(f.rag.search('travel', { mode: 'unknown' }), /mode/i);
  for (const limit of [0, -1, 1.5, NaN, Infinity]) {
    await assert.rejects(f.rag.search('travel', { limit }), /limit/i);
  }
});

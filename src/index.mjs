import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import * as sqliteVec from 'sqlite-vec';
import { EmbeddingEngine, validateVector } from './embedding.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const encode = vector => Buffer.from(new Float32Array(validateVector(vector)).buffer);
const validCollection = collection => {
  if (typeof collection !== 'string' || !collection.trim() || collection.length > 256) throw new Error('Invalid collection.');
  return collection;
};

export async function openRag({ dbPath, modelDir, threads, engine } = {}) {
  if (!dbPath || typeof dbPath !== 'string') throw new Error('dbPath is required.');
  if (dbPath !== ':memory:') mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  const embedder = engine || await EmbeddingEngine.create({ modelDir, threads });
  let db;
  try {
    db = new DatabaseSync(dbPath, { allowExtension: true });
    sqliteVec.load(db);
    db.enableLoadExtension(false);
    db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    db.exec('CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const identity = JSON.stringify(embedder.identity);
    const existing = db.prepare("SELECT value FROM metadata WHERE key='embedding_identity'").get();
    if (existing && existing.value !== identity) throw new Error('Embedding model/index identity mismatch. Rebuild into a new database.');
    if (!existing) db.prepare("INSERT INTO metadata(key,value) VALUES('embedding_identity',?)").run(identity);
    db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        key TEXT PRIMARY KEY, external_id TEXT NOT NULL, collection TEXT NOT NULL,
        source TEXT NOT NULL, content_hash TEXT NOT NULL,
        UNIQUE(collection, external_id)
      );
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY, document_key TEXT NOT NULL REFERENCES documents(key) ON DELETE CASCADE,
        collection TEXT NOT NULL, text TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS chunks_document ON chunks(document_key);
      CREATE VIRTUAL TABLE IF NOT EXISTS vectors USING vec0(
        chunk_id INTEGER PRIMARY KEY, collection TEXT PARTITION KEY,
        embedding FLOAT[384] distance_metric=cosine
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text, collection UNINDEXED, chunk_id UNINDEXED);
    `);
  } catch (error) { db?.close(); if (!engine) await embedder.close?.(); throw error; }

  let closed = false;
  let pendingWrites = 0;
  let tail = Promise.resolve();
  const check = () => { if (closed) throw new Error('Database is closed.'); };
  const transaction = action => {
    db.exec('BEGIN IMMEDIATE');
    try { const value = action(); db.exec('COMMIT'); return value; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const keyFor = (id, collection) => hash(JSON.stringify([collection, id]));
  const erase = key => {
    for (const chunk of db.prepare('SELECT id FROM chunks WHERE document_key=?').all(key)) {
      db.prepare('DELETE FROM vectors WHERE chunk_id=CAST(? AS INTEGER)').run(chunk.id);
      db.prepare('DELETE FROM chunks_fts WHERE rowid=?').run(chunk.id);
    }
    db.prepare('DELETE FROM documents WHERE key=?').run(key);
  };
  const joinRow = row => {
    const item = db.prepare(`SELECT c.id AS chunkId, c.text, c.collection, c.start, c.end,
      d.external_id AS id, d.source FROM chunks c JOIN documents d ON c.document_key=d.key WHERE c.id=?`).get(row.chunk_id);
    return item ? { ...item, distance: row.distance } : null;
  };
  const store = {
    identity: embedder.identity,
    async index({ id, text, source = id, collection = 'default' } = {}) {
      check(); validCollection(collection);
      if (typeof id !== 'string' || !id.trim() || typeof source !== 'string') throw new Error('Document id and source must be strings.');
      if (typeof text !== 'string') throw new Error('Document text must be a string.');
      pendingWrites++;
      const run = tail.then(async () => {
        check();
        const key = keyFor(id, collection), contentHash = hash(text);
        const previous = db.prepare('SELECT * FROM documents WHERE key=?').get(key);
        if (previous?.content_hash === contentHash && previous.source === source) {
          return { changed: false, chunks: db.prepare('SELECT count(*) AS n FROM chunks WHERE document_key=?').get(key).n, id };
        }
        const chunks = embedder.chunk(text);
        const vectors = await embedder.embedDocuments(chunks.map(chunk => chunk.text));
        if (vectors.length !== chunks.length) throw new Error('Embedding count does not match chunk count.');
        const blobs = vectors.map(encode);
        check();
        transaction(() => {
          erase(key);
          db.prepare('INSERT INTO documents VALUES(?,?,?,?,?)').run(key, id, collection, source, contentHash);
          chunks.forEach((chunk, i) => {
            if (chunk.text !== text.slice(chunk.start, chunk.end)) throw new Error('Chunk offsets do not match the original text.');
            const inserted = db.prepare('INSERT INTO chunks(document_key,collection,text,start,end) VALUES(?,?,?,?,?)')
              .run(key, collection, chunk.text, chunk.start, chunk.end);
            const chunkId = Number(inserted.lastInsertRowid);
            db.prepare('INSERT INTO vectors(chunk_id,collection,embedding) VALUES(CAST(? AS INTEGER),?,?)').run(chunkId, collection, blobs[i]);
            db.prepare('INSERT INTO chunks_fts(rowid,text,collection,chunk_id) VALUES(?,?,?,?)').run(chunkId, chunk.text, collection, chunkId);
          });
        });
        return { changed: true, chunks: chunks.length, id };
      });
      const settled = run.finally(() => { pendingWrites--; });
      tail = settled.catch(() => {});
      return settled;
    },
    async search(query, { collection = 'default', limit = 5, mode = 'hybrid' } = {}) {
      check(); validCollection(collection);
      if (typeof query !== 'string' || !query.trim()) throw new Error('Query must not be empty.');
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be between 1 and 100.');
      if (!['semantic', 'keyword', 'hybrid'].includes(mode)) throw new Error('Invalid search mode.');
      const candidateCount = mode === 'hybrid' ? Math.max(30, limit * 3) : limit;
      let semantic = [], keyword = [];
      if (mode !== 'keyword') {
        const vector = encode(await embedder.embedQuery(query));
        check();
        semantic = db.prepare(`SELECT chunk_id, distance FROM vectors
          WHERE embedding MATCH ? AND k=CAST(? AS INTEGER) AND collection=? ORDER BY distance`)
          .all(vector, candidateCount, collection).map(joinRow).filter(Boolean);
      }
      if (mode !== 'semantic') {
        const words = [...new Set(query.match(/[\p{L}\p{N}_]+/gu) || [])].slice(0, 32);
        const expression = words.map(word => '"' + word.replaceAll('"', '""') + '"').join(' OR ');
        if (expression) keyword = db.prepare(`SELECT chunk_id FROM chunks_fts
          WHERE chunks_fts MATCH ? AND collection=? ORDER BY bm25(chunks_fts) LIMIT ?`)
          .all(expression, collection, candidateCount).map(joinRow).filter(Boolean);
      }
      if (mode === 'semantic') return semantic.slice(0, limit).map(item => ({ ...item, score: 1 - item.distance }));
      if (mode === 'keyword') return keyword.slice(0, limit).map((item, i) => ({ ...item, score: 1 / (60 + i + 1) }));
      const merged = new Map();
      for (const ranking of [semantic, keyword]) ranking.forEach((item, i) => {
        const old = merged.get(item.chunkId);
        merged.set(item.chunkId, { ...old, ...item, distance: old?.distance ?? item.distance,
          score: (old?.score || 0) + 1 / (60 + i + 1) });
      });
      return [...merged.values()].sort((a, b) => b.score - a.score || a.chunkId - b.chunkId).slice(0, limit);
    },
    remove(id, { collection = 'default' } = {}) {
      check(); validCollection(collection);
      if (typeof id !== 'string' || !id.trim()) throw new Error('Invalid document id.');
      if (pendingWrites) throw new Error('Await pending indexing before removing documents.');
      const key = keyFor(id, collection);
      if (!db.prepare('SELECT key FROM documents WHERE key=?').get(key)) return false;
      transaction(() => erase(key));
      return true;
    },
    stats() {
      check();
      return {
        documents: db.prepare('SELECT count(*) AS n FROM documents').get().n,
        chunks: db.prepare('SELECT count(*) AS n FROM chunks').get().n,
        collections: db.prepare('SELECT collection, count(*) AS documents FROM documents GROUP BY collection').all(),
        identity: embedder.identity,
        sqlite: db.prepare('SELECT sqlite_version() AS version').get().version,
        sqliteVec: db.prepare('SELECT vec_version() AS version').get().version,
      };
    },
    close() { if (!closed) { closed = true; db.close(); return engine ? undefined : embedder.close?.(); } },
  };
  return store;
}

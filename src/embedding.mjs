import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, basename, resolve, join } from 'node:path';
import { modelDirectory } from './paths.mjs';
import { MODEL_FILE_HASHES } from './model-pins.mjs';

export const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';
export const MODEL_REVISION = 'ea104dacec62c0de699686887e3f920caeb4f3e3';
export const MODEL_ID = 'Xenova/bge-small-en-v1.5';
export const DIMENSIONS = 384;
export const WEIGHTS_SHA256 = '6c9c6101a956d62dfb5e7190c538226c0c5bb9cb27b651234b6df063ee7dbfe4';

export function validateVector(vector) {
  if ((!Array.isArray(vector) && !(vector instanceof Float32Array)) || vector.length !== DIMENSIONS ||
      !Array.from(vector).every(Number.isFinite)) throw new Error('Expected 384 finite embedding values.');
  const norm = Math.sqrt(Array.from(vector).reduce((sum, n) => sum + n * n, 0));
  if (Math.abs(norm - 1) > 0.005) throw new Error('Expected an L2-normalized embedding.');
  return vector;
}

export async function verifyModelFiles(modelDir = modelDirectory()) {
  const manifest = JSON.parse(await readFile(join(modelDir, 'manifest.json'), 'utf8'));
  if (manifest.model !== MODEL_ID || manifest.revision !== MODEL_REVISION ||
      manifest.dtype !== 'q8') throw new Error('Unrecognized model manifest. Run the pinned model preparation script.');
  const required = Object.keys(MODEL_FILE_HASHES);
  if (manifest.files.length !== required.length || new Set(manifest.files.map(file => file.path)).size !== required.length) {
    throw new Error('Model manifest contains unexpected or duplicate assets.');
  }
  for (const path of required) {
    const entry = manifest.files.find(file => file.path === path);
    if (!entry || entry.sha256 !== MODEL_FILE_HASHES[path]) throw new Error('Model manifest does not match the pinned assets.');
  }
  if (manifest.files.find(file => file.path === 'onnx/model_quantized.onnx').sha256 !== WEIGHTS_SHA256) {
    throw new Error('Model weight hash differs from this release.');
  }
  for (const file of manifest.files) {
    if (file.path.includes('..') || file.path.startsWith('/') || file.path.includes('\\')) throw new Error('Unsafe model manifest path.');
    const bytes = await readFile(join(modelDir, file.path));
    if (bytes.length !== file.size || createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
      throw new Error('Model integrity check failed: ' + file.path);
    }
  }
  return manifest;
}

export class EmbeddingEngine {
  static async create({ modelDir = modelDirectory(), threads = 2 } = {}) {
    if (!Number.isInteger(threads) || threads < 1 || threads > 32) throw new Error('threads must be between 1 and 32.');
    const localDir = resolve(modelDir);
    const manifest = await verifyModelFiles(localDir);
    const { env, pipeline } = await import('@huggingface/transformers');
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.useFSCache = false;
    env.localModelPath = dirname(localDir) + '/';
    const extractor = await pipeline('feature-extraction', basename(localDir), {
      device: 'cpu', dtype: 'q8', local_files_only: true,
      session_options: { intraOpNumThreads: threads, interOpNumThreads: 1 },
    });
    const engine = new EmbeddingEngine();
    engine.extractor = extractor;
    engine.identity = {
      model: MODEL_ID, revision: MODEL_REVISION, dtype: 'q8', dimensions: DIMENSIONS,
      pooling: 'cls', normalize: true, queryPrefix: QUERY_PREFIX,
      weightsSha256: manifest.files.find(file => file.path === 'onnx/model_quantized.onnx').sha256,
      chunking: { version: 1, maxTokens: 384, overlapTokens: 48 },
    };
    return engine;
  }

  tokenCount(text) { return this.extractor.tokenizer.encode(text, { add_special_tokens: true }).length; }

  chunk(text, { maxTokens = 384, overlapTokens = 48 } = {}) {
    if (typeof text !== 'string') throw new Error('Document text must be a string.');
    if (!Number.isInteger(maxTokens) || maxTokens < 8 || maxTokens > 512 ||
        !Number.isInteger(overlapTokens) || overlapTokens < 0 || overlapTokens >= maxTokens - 2) {
      throw new Error('Invalid chunk token limits.');
    }
    if (!text.trim()) return [];
    const points = Array.from(text);
    const offsets = [0];
    for (const point of points) offsets.push(offsets.at(-1) + point.length);
    const slice = (a, b) => text.slice(offsets[a], offsets[b]);
    const chunks = [];
    let start = 0;
    while (start < points.length) {
      let low = start + 1, high = Math.min(points.length, start + 8192), end = start;
      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        if (this.tokenCount(slice(start, mid)) <= maxTokens) { end = mid; low = mid + 1; }
        else high = mid - 1;
      }
      if (end === start) throw new Error('Unable to fit document text into the model token limit.');
      if (end < points.length) {
        const floor = start + Math.floor((end - start) * 0.75);
        for (let i = end; i > floor; i--) {
          if (/\s/u.test(points[i - 1])) { end = i; break; }
        }
      }
      const content = slice(start, end);
      if (content.trim()) chunks.push({ text: content, start: offsets[start], end: offsets[end], tokens: this.tokenCount(content) });
      if (end === points.length) break;
      let next = end;
      low = start + 1; high = end - 1;
      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        if (this.tokenCount(slice(mid, end)) <= overlapTokens + 2) { next = mid; high = mid - 1; }
        else low = mid + 1;
      }
      start = Math.max(start + 1, next);
    }
    return chunks;
  }

  async embedDocuments(texts) {
    if (!Array.isArray(texts)) throw new Error('Expected an array of document chunks.');
    const result = [];
    for (let i = 0; i < texts.length; i += 8) {
      const batch = texts.slice(i, i + 8);
      for (const text of batch) {
        if (typeof text !== 'string' || !text.trim() || this.tokenCount(text) > 512) throw new Error('Document chunks must contain 1–512 tokens.');
      }
      const tensor = await this.extractor(batch, { pooling: 'cls', normalize: true, truncation: false });
      for (const vector of tensor.tolist()) result.push(Array.from(validateVector(vector)));
    }
    return result;
  }

  async embedQuery(query) {
    if (typeof query !== 'string' || !query.trim()) throw new Error('Query must not be empty.');
    const text = QUERY_PREFIX + query;
    if (this.tokenCount(text) > 512) throw new Error('Query exceeds the 512-token limit including its retrieval instruction.');
    const tensor = await this.extractor(text, { pooling: 'cls', normalize: true, truncation: false });
    return Array.from(validateVector(tensor.tolist()[0]));
  }

  async close() { await this.extractor?.dispose(); }
}

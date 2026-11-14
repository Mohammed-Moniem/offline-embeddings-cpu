import { mkdir, writeFile, readFile, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { MODEL_ID, MODEL_REVISION } from '../src/embedding.mjs';
import { modelDirectory } from '../src/paths.mjs';

// Build-time tool only. Runtime never calls this script or downloads models.
const root = modelDirectory();
const files = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json',
  'vocab.txt', 'quantize_config.json', 'README.md', 'onnx/model_quantized.onnx'];
const expectedWeights = '6c9c6101a956d62dfb5e7190c538226c0c5bb9cb27b651234b6df063ee7dbfe4';
const manifest = { model: MODEL_ID, revision: MODEL_REVISION, dtype: 'q8', license: 'MIT', files: [] };
for (const file of files) {
  const url = 'https://huggingface.co/' + MODEL_ID + '/resolve/' + MODEL_REVISION + '/' + file;
  const destination = join(root, file);
  let bytes;
  try { bytes = await readFile(destination); } catch {}
  const existingHash = bytes && createHash('sha256').update(bytes).digest('hex');
  if (!bytes || (file.endsWith('.onnx') && existingHash !== expectedWeights)) {
    const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error('Model download failed (' + response.status + '): ' + file);
    bytes = Buffer.from(await response.arrayBuffer());
    await mkdir(dirname(destination), { recursive: true });
    const partial = destination + '.partial';
    await writeFile(partial, bytes);
    if (file.endsWith('.onnx') && createHash('sha256').update(bytes).digest('hex') !== expectedWeights) {
      await rm(partial, { force: true }); throw new Error('Pinned model weight SHA-256 mismatch.');
    }
    await rename(partial, destination);
  }
  manifest.files.push({ path: file, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), url });
  console.log('Verified model asset: ' + file + ' (' + bytes.length + ' bytes)');
}
await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log('Pinned local model ready: ' + root);

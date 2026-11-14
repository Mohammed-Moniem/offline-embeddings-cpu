import { mkdir, writeFile, readFile, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { MODEL_ID, MODEL_REVISION } from '../src/embedding.mjs';
import { modelDirectory } from '../src/paths.mjs';
import { MODEL_FILE_HASHES } from '../src/model-pins.mjs';

// Build-time tool only. Runtime never calls this script or downloads models.
const root = modelDirectory();
const files = Object.keys(MODEL_FILE_HASHES);
const manifest = { model: MODEL_ID, revision: MODEL_REVISION, dtype: 'q8', license: 'MIT', files: [] };
for (const file of files) {
  const url = 'https://huggingface.co/' + MODEL_ID + '/resolve/' + MODEL_REVISION + '/' + file;
  const destination = join(root, file);
  let bytes;
  try { bytes = await readFile(destination); } catch {}
  const existingHash = bytes && createHash('sha256').update(bytes).digest('hex');
  if (!bytes || existingHash !== MODEL_FILE_HASHES[file]) {
    const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error('Model download failed (' + response.status + '): ' + file);
    bytes = Buffer.from(await response.arrayBuffer());
    await mkdir(dirname(destination), { recursive: true });
    const partial = destination + '.partial';
    await writeFile(partial, bytes);
    if (createHash('sha256').update(bytes).digest('hex') !== MODEL_FILE_HASHES[file]) {
      await rm(partial, { force: true }); throw new Error('Pinned model asset SHA-256 mismatch: ' + file);
    }
    await rename(partial, destination);
  }
  manifest.files.push({ path: file, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), url });
  console.log('Verified model asset: ' + file + ' (' + bytes.length + ' bytes)');
}
await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log('Pinned local model ready: ' + root);

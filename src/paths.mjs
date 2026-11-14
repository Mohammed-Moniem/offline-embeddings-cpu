import { homedir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function dataDirectory() {
  if (process.env.OFFLINE_EMBEDDINGS_DATA) return resolve(process.env.OFFLINE_EMBEDDINGS_DATA);
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA || homedir(), 'OfflineEmbeddingsCPU');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'OfflineEmbeddingsCPU');
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'offline-embeddings-cpu');
}
export function modelDirectory() {
  return resolve(process.env.OFFLINE_EMBEDDINGS_MODEL_DIR || join(packageRoot, 'models', 'bge-small-en-v1.5'));
}

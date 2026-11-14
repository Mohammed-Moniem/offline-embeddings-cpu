import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve, join, extname, relative } from 'node:path';
import { performance } from 'node:perf_hooks';
import { openRag } from './index.mjs';
import { dataDirectory, modelDirectory } from './paths.mjs';
import { verifyModelFiles } from './embedding.mjs';

const args = process.argv.slice(2), command = args.shift() || 'help';
const options = {}, positionals = [];
const allowed = new Set(['db', 'collection', 'mode', 'limit', 'model-dir', 'threads']);
for (let i = 0; i < args.length; i++) {
  if (!args[i].startsWith('--')) { positionals.push(args[i]); continue; }
  const key = args[i].slice(2);
  if (!allowed.has(key) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Unknown or incomplete option: ' + args[i]);
  options[key] = args[++i];
}
const help = `Offline Embeddings CPU
  rag doctor
  rag demo
  rag index <file.txt|file.md|directory> [--collection NAME]
  rag search "<question>" [--collection NAME] [--mode hybrid|semantic|keyword] [--limit 5]
  rag remove <document-id> [--collection NAME]
  rag stats
  rag benchmark
Options: --db PATH --model-dir PATH --threads 2
The package includes its Node runtime. Use rag.cmd on Windows or ./rag.sh on macOS.
Data defaults to a writable per-user directory; override OFFLINE_EMBEDDINGS_DATA.
CLI accepts UTF-8 text/Markdown. Use the Node API for text extracted elsewhere.`;

let rag;
try {
  if (command === 'help' || command === '--help') console.log(help);
  else {
    const dbPath = options.db || join(dataDirectory(), ['demo', 'benchmark'].includes(command) ? 'demo.sqlite' : 'rag.sqlite');
    const modelDir = options['model-dir'] || modelDirectory();
    if (command === 'doctor') {
      const model = await verifyModelFiles(modelDir);
      rag = await openRag({ dbPath: ':memory:', modelDir, threads: Number(options.threads || 2) });
      console.log(JSON.stringify({ ready: true, platform: process.platform, arch: process.arch, node: process.version,
        modelDir, dataDirectory: dataDirectory(), modelRevision: model.revision, ...rag.stats() }, null, 2));
    } else {
      rag = await openRag({ dbPath, modelDir, threads: Number(options.threads || 2) });
      const collection = options.collection || 'default';
      if (command === 'index') {
        if (positionals.length !== 1) throw new Error('index requires one file or directory.');
        const root = resolve(positionals[0]), rootStat = await stat(root);
        async function visit(path) {
          const info = await stat(path);
          if (info.isDirectory()) {
            for (const entry of (await readdir(path, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
              if (entry.isSymbolicLink()) continue;
              if (entry.isDirectory() || /\.(txt|md|markdown)$/i.test(entry.name)) await visit(join(path, entry.name));
            }
          } else {
            if (!['.txt', '.md', '.markdown'].includes(extname(path).toLowerCase())) throw new Error('Only text and Markdown files are supported.');
            const text = await readFile(path, 'utf8');
            if (text.includes('\0')) throw new Error('Binary-looking input rejected: ' + path);
            const id = rootStat.isDirectory() ? relative(root, path).split('\\').join('/') : root.split('\\').join('/');
            console.log(JSON.stringify(await rag.index({ id, text, source: path, collection })));
          }
        }
        await visit(root);
      } else if (command === 'search') {
        if (!positionals.length) throw new Error('search requires a question.');
        console.log(JSON.stringify(await rag.search(positionals.join(' '), { collection, mode: options.mode || 'hybrid', limit: Number(options.limit || 5) }), null, 2));
      } else if (command === 'remove') {
        if (positionals.length !== 1) throw new Error('remove requires one document id.');
        console.log(JSON.stringify({ removed: rag.remove(positionals[0], { collection }) }));
      } else if (command === 'stats') console.log(JSON.stringify({ dbPath, ...rag.stats() }, null, 2));
      else if (command === 'demo' || command === 'benchmark') {
        const examples = [
          ['travel', 'Submit business travel receipts to Finance within thirty days for reimbursement.'],
          ['passwords', 'Protect your account with a password manager and multifactor authentication.'],
          ['leave', 'Employees receive twenty-five days of annual leave per year. Request time off through HR.'],
        ];
        for (const [id, text] of examples) await rag.index({ id, text, collection: 'demo', source: 'example:' + id });
        const query = 'How do I get paid back for a work trip?';
        const times = [];
        let results;
        for (let i = 0; i < (command === 'benchmark' ? 10 : 1); i++) {
          const start = performance.now();
          results = await rag.search(query, { collection: 'demo', mode: 'semantic', limit: 3 });
          times.push(performance.now() - start);
        }
        times.sort((a,b) => a-b);
        console.log(JSON.stringify({ query, results, dbPath,
          measuredOn: { platform: process.platform, arch: process.arch, node: process.version },
          warmQueryMs: { min: times[0], median: times[Math.floor(times.length / 2)], max: times.at(-1) },
          rssBytes: process.memoryUsage().rss }, null, 2));
      } else throw new Error('Unknown command: ' + command + '\n' + help);
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally { await rag?.close(); }

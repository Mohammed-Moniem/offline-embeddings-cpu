# Offline Embeddings CPU

Local text embeddings and SQLite retrieval for a Node.js harness, with complete downloadable packages for **Windows x64** and **macOS Apple Silicon**. No Python, GPU, cloud API, npm installation, or separate database server is required to run a release package.

The model is **BGE-small-en-v1.5**, an English embedding model. It produces 384-dimensional vectors using CPU ONNX Runtime. The package applies CLS pooling, normalizes vectors, and adds BGE's retrieval instruction to queries only. SQLite stores documents and chunks; sqlite-vec provides semantic search and FTS5 provides keyword search. Hybrid search combines the two rankings.

## Download and run

Download the ZIP matching your computer from [GitHub Releases](https://github.com/Mohammed-Moniem/offline-embeddings-cpu/releases/latest). The automatically generated “Source code” archives are developer sources, not the complete offline runtime.

| Computer | Complete package |
|---|---|
| Windows, Intel/AMD 64-bit | `offline-embeddings-cpu-1.0.0-win32-x64.zip` |
| Mac, Apple Silicon | `offline-embeddings-cpu-1.0.0-darwin-arm64.zip` |

Each platform ZIP includes its Node executable, installed production dependencies and native libraries, model weights, tokenizer/config files, application source, command launchers, licenses, and a file-integrity manifest. Download its adjacent `.sha256` file and verification report as well. The release reports identify the exact archive hash, test platform, and result; a source build or an untested archive is not evidence of target compatibility.

Extract the ZIP completely. Do not run it from inside an archive viewer.

On Windows, open Command Prompt in the extracted folder:

```bat
rag.cmd doctor
rag.cmd demo
rag.cmd index "C:\Documents\policies" --collection policies
rag.cmd search "How do I request annual leave?" --collection policies
```

On macOS, open Terminal in the extracted folder:

```sh
./rag.sh doctor
./rag.sh demo
./rag.sh index "$HOME/Documents/policies" --collection policies
./rag.sh search "How do I request annual leave?" --collection policies
```

Commands use the bundled runtime. If execute permissions were not preserved by your archive tool, run `chmod +x rag.sh runtime/node` once. Local application execution must be permitted by your organization's policy.

The CLI indexes UTF-8 text and Markdown. For PDF, Word, Excel, or other formats, extract text using your harness's existing ingestion pipeline and call the JavaScript API. This package does not include document converters, OCR, an LLM, a chat interface, or an embedding model trainer.

## Harness integration

Use the package from an existing Node worker or process:

```js
import { openRag } from './offline-embeddings-cpu/src/index.mjs';

const rag = await openRag({
  dbPath: '/your/writable/data/knowledge.sqlite',
  // modelDir: '/your/install/models/bge-small-en-v1.5',
  threads: 2,
});

try {
  await rag.index({
    id: 'leave-policy',
    source: 'Employee Handbook, section 8',
    collection: 'policies',
    text: 'Employees request annual leave through the HR portal.',
  });

  const results = await rag.search('How can I book holiday?', {
    collection: 'policies',
    mode: 'hybrid',
    limit: 5,
  });
  console.log(results);
} finally {
  await rag.close();
}
```

Run indexing outside your UI's main thread and control ingestion concurrency. Existing Node applications must use a compatible Node version and native dependencies; embedding this source into another host does not make its runtime automatically compatible. A Rust harness can invoke the bundled CLI as a child process and consume its output, or keep this as a separate local retrieval component.

See [the API and integration guide](docs/INTEGRATION.md), [offline deployment details](docs/OFFLINE.md), and [component inventory](docs/COMPONENTS.md).

## Data and retrieval behavior

- Documents are split with the model tokenizer so every chunk fits the model's input limit. The normal chunk target is 384 tokens with a 48-token overlap.
- Re-indexing identical content avoids repeating embedding work. Replacing or deleting a document updates its text, keyword index, and vector rows together.
- `semantic`, `keyword`, and `hybrid` modes are available. Returned chunks retain their source and character offsets for citations.
- Collections keep separate sets of documents. **A caller-supplied collection name is not authentication or an access-control system.** The harness must choose an authorized collection itself before searching.
- The database records the embedding identity. Changing the model, quantization, pooling, or prompt policy requires rebuilding the index rather than mixing incompatible vectors.
- Databases are local SQLite files. This package does not encrypt them or provide retention, permissions, or backup policy on your behalf.

The model and runtime remain on the computer. Remote model loading is disabled; an absent or changed model file is an error. Performance depends on the CPU, memory, corpus size, and concurrent work. The included benchmark reports measurements for the actual machine, not a universal throughput promise.

## Verify a release

The complete packages are built separately on their target operating systems. The release workflow runs unit tests, real-model retrieval checks, and a fresh-extraction test using the bundled Node executable. The fresh-extraction test uses an empty external PATH/cache and OS-level network denial and confirms an attempted network request fails. It checks the actual ZIP, not just the source tree.

Read the target-specific verification report attached to the release. Corporate endpoint policies and OS versions can still differ from the tested runner, so run `doctor` and `demo` on the destination before connecting your real corpus.

## Build from source

This section is for an internet-connected preparation/build computer. It is not required on the offline destination.

Use Node **24.18.0**. Then:

```sh
npm ci
node scripts/audit-dependencies.mjs
npm test
npm run fetch:model
npm run verify
npm run bundle
```

`fetch:model` downloads the pinned model revision and verifies its files. `bundle` downloads the pinned official Node distribution for the current supported platform, checks its checksum, and creates the complete ZIP in `dist/`. Build on each target platform so native dependencies match. See [release verification](docs/VERIFICATION.md) for the complete acceptance procedure.

## Licensing and provenance

The application code is [MIT licensed](LICENSE). Bundled third-party software and model files keep their own licenses; see [the component inventory](docs/COMPONENTS.md) and the notices inside each archive. BGE-small-en-v1.5's original model license is MIT. The ONNX conversion is pinned by revision and the package verifies the actual downloaded bytes.

Primary references: [BGE model](https://huggingface.co/BAAI/bge-small-en-v1.5), [Transformers.js](https://github.com/huggingface/transformers.js), [ONNX Runtime](https://onnxruntime.ai/docs/get-started/with-javascript/node.html), [sqlite-vec](https://github.com/asg017/sqlite-vec), [SQLite FTS5](https://www.sqlite.org/fts5.html).

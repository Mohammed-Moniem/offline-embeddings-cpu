# Integration

## JavaScript API

Import `openRag` from `src/index.mjs` and await it once per database/worker. Supply a writable `dbPath`; the default model path is `models/bge-small-en-v1.5` relative to the installed package. `threads` limits the model's CPU worker count.

| Method | Purpose |
|---|---|
| `await rag.index({id, text, source, collection})` | Insert or replace a document, returning `{changed, chunks, id}`. `source` defaults to `id`; `collection` defaults to `default`. |
| `await rag.search(query, {collection, limit, mode})` | Retrieve chunks. Modes are `hybrid`, `semantic`, or `keyword`; default limit is 5. |
| `rag.remove(id, {collection})` | Remove a document and its chunk, vector, and keyword records. |
| `rag.stats()` | Read document/chunk counts and index information. |
| `await rag.close()` | Close the SQLite connection and release the owned embedding engine. |

Search results contain `id`, `text`, `source`, `collection`, `start`, `end`, and `score`; semantic results may also contain `distance`. Character offsets refer to the supplied document text. They do not identify pages in an original PDF or Word file; provide your own page/section source labels during ingestion.

SQLite access and model initialization have real costs. Keep a long-lived worker/process and reuse it. Avoid concurrent writes to the same database from multiple application components. Close it during shutdown. For a Rust-owned application, the bundled executable can be invoked as a child process without adding Python or a local HTTP service.

## Input contract

Pass UTF-8 text extracted by your ingestion pipeline. The CLI supports text/Markdown files and directories of supported files. It does not perform OCR or parse office formats. Do not send empty or binary data as text.

Document chunks are token-aware. The embedding model accepts at most 512 tokens including its special tokens. Query validation includes the retrieval instruction prefix in that limit. Overlong queries should be shortened by the caller rather than silently truncated.

The BGE query prefix is:

```text
Represent this sentence for searching relevant passages: 
```

It is applied to search questions only. Stored document chunks receive no prefix. CLS pooling and L2 normalization are part of the index identity, not optional per-query settings. The engine emits 384 finite float values per embedding.

## Collections and authorization

Collections are partitions chosen by the caller. They are useful for separate corpora or tenants but are not user accounts. The application must map its authenticated user to allowed collections and enforce any finer document permissions before exposing retrieved text.

Do not allow an untrusted client to select arbitrary collection names. Apply authorization to both keyword and semantic paths. Do not retrieve all collections and filter after returning results.

## Model changes

Keep one embedding identity per database. The identity includes model revision, representation/quantization, pooling, dimensionality, and query instruction policy. A different identity is rejected so old and new vectors cannot silently mix. To adopt a different model, build a new database, re-index the source documents, test retrieval, and switch the application to that database.

The default model is English. Arabic or multilingual retrieval requires a separately selected multilingual model and a fresh index; changing only a model directory is not a supported migration.

## CLI options

The CLI accepts `--db PATH`, `--collection NAME`, and `--model-dir PATH` where relevant. Search also accepts `--mode hybrid|semantic|keyword` and `--limit N`.

`OFFLINE_EMBEDDINGS_DATA` selects the writable data directory. `OFFLINE_EMBEDDINGS_MODEL_DIR` selects an explicit installed model directory. The installation can be kept read-only while data is stored in a user-owned folder.

Treat source paths and retrieved text as application data, not executable instructions. The retrieval layer does not decide what an LLM or tool is authorized to do with them.

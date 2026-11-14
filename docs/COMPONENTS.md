# Component inventory

The release ZIP is the runtime deliverable. The repository's automatically generated source archives do not contain downloaded models or installed dependencies.

| Component | Pinned version / identity | Purpose | Upstream license |
|---|---|---|---|
| Application source | Release Git tag/commit | Ingestion, CLI, retrieval and verification | [MIT](../LICENSE) |
| Node.js | 24.18.0, per-target official distribution | JavaScript runtime and built-in SQLite binding | [Node license and bundled notices](https://github.com/nodejs/node/blob/v24.18.0/LICENSE) |
| Transformers.js | 4.3.2 | Model/tokenizer orchestration | [Apache-2.0](https://github.com/huggingface/transformers.js) |
| ONNX Runtime Node | 1.30.0, resolved through the lockfile | Native CPU inference | [MIT and third-party notices](https://github.com/microsoft/onnxruntime) |
| sqlite-vec | 0.1.9 | SQLite vector storage/search | [MIT or Apache-2.0](https://github.com/asg017/sqlite-vec) |
| BGE-small-en-v1.5 | `Xenova/bge-small-en-v1.5` at `ea104dacec62c0de699686887e3f920caeb4f3e3` | English 384-dimensional embeddings | [MIT model license](https://huggingface.co/BAAI/bge-small-en-v1.5) |
| Visual Studio x64 CRT (Windows only) | Actual file versions and SHA-256 recorded in each archive | App-local native runtime dependency | Microsoft redistribution terms |

The model's quantized ONNX file has SHA-256:

```text
6c9c6101a956d62dfb5e7190c538226c0c5bb9cb27b651234b6df063ee7dbfe4
```

It is 34,014,426 bytes. That is the weight file's size, not the complete package size or runtime memory requirement. Tokenizer/config assets and the native runtime are also included. The model manifest records source revision and hashes for the actual shipped files.

`package-lock.json` records the full JavaScript dependency closure and integrity identifiers. Dependency packages retain their own license files and notices in `node_modules`. Node's own license contains its bundled third-party notices. The per-archive manifest identifies the actual runtime and files included for that platform.

Windows CRT files come from the official Visual Studio redistribution directory on the Windows build runner and are placed next to the bundled executable. [Microsoft documents application-local redistribution](https://learn.microsoft.com/en-us/cpp/windows/redistributing-visual-cpp-files) subject to the Visual Studio license terms. Their license is not replaced by this project's MIT license. The package must be rebuilt when these app-local DLLs need servicing.

For traceability, use all three together: the tagged source, the platform archive's checksum, and the corresponding verification report. A later rebuilt archive with different bytes needs its own hash and verification evidence.

Primary component references:

- [Official Node distributions](https://nodejs.org/dist/v24.18.0/)
- [Transformers.js release source](https://github.com/huggingface/transformers.js)
- [ONNX Runtime Node platform support](https://onnxruntime.ai/docs/get-started/with-javascript/node.html)
- [sqlite-vec documentation](https://alexgarcia.xyz/sqlite-vec/)
- [Original BGE model and usage](https://huggingface.co/BAAI/bge-small-en-v1.5)
- [Pinned ONNX model conversion](https://huggingface.co/Xenova/bge-small-en-v1.5/tree/ea104dacec62c0de699686887e3f920caeb4f3e3)

# Offline deployment

## Preparation and transfer

1. Download the complete ZIP for the destination OS/CPU from the release assets. Also download its `.sha256` file and target verification report.
2. Verify the ZIP's SHA-256 before transfer and again on the destination using an approved checksum tool.
3. Extract every file into one folder. Keep the model, runtime, source and `node_modules` layout together.
4. Transfer the extracted folder or intact ZIP by your organization's approved method. No npm install or Hugging Face login is required on the destination.
5. Run `rag.cmd doctor` / `./rag.sh doctor`, then `demo` on the destination. Choose a writable data location before indexing real documents.

The two archives are different because native Node, ONNX Runtime and SQLite extension files are platform-specific. Windows x64 is not Windows ARM64; macOS Apple Silicon is not Intel macOS.

## Files that must remain available

- `runtime/node.exe` on Windows or `runtime/node` on macOS.
- The installed production `node_modules` tree, including native runtime and SQLite libraries.
- The model's quantized ONNX weights, tokenizer, vocabulary and configuration files in `models/`.
- Model provenance/checksum manifests and package-integrity metadata.
- `src/`, launchers, licenses and notices.

Do not copy only the JavaScript source, only the ONNX file, or only the Node executable and expect a complete installation. Do not run package-manager updates inside the released folder; that invalidates the verified dependency set.

## Network and data

The runtime uses local model files and disables remote model loading. The model-fetch and bundle scripts are preparation tools for an internet-connected build computer. Do not invoke those scripts during normal offline use.

The extracted-package acceptance test applies OS-level network denial to the bundled executable and separately proves a network probe fails. Application configuration alone is not treated as proof that a machine is offline.

Document text, vectors and metadata are stored in a local SQLite database. Vectors can reveal information about source data and should receive the same access, backup and retention controls as the documents. Local processing does not replace organizational security policy.

## Permissions and prerequisites

Normal operation writes to a user-owned data directory, not the installation directory. A Node or Python installation, a GPU driver, Docker, and a database service are not needed. Corporate application allowlisting may need to approve the bundled native executables/libraries.

The Windows package includes the official Visual Studio x64 redistributable CRT DLLs alongside `runtime/node.exe` and in the ONNX/Sharp native-addon library directories, using Microsoft's documented [application-local deployment](https://learn.microsoft.com/en-us/cpp/windows/redistributing-visual-cpp-files). Native addons may resolve libraries from their own directory rather than the Node executable's directory. The archive manifest records every deployed copy and its hash. The extracted-package verifier checks the paths and hashes of the CRT DLLs actually loaded and rejects reliance on a preinstalled System32 copy. This avoids requiring a system-wide redistributable installation for those DLLs. Windows itself still provides operating-system components such as the Universal CRT; the package targets a supported modern Windows x64 system, not every historic Windows version.

App-local Microsoft runtime DLLs are governed by Microsoft's redistribution terms and are serviced by updating this package; Windows Update does not independently update the copies in the application folder. See [Microsoft's deployment-method guidance](https://learn.microsoft.com/en-us/cpp/windows/choosing-a-deployment-method). Never substitute arbitrary DLLs downloaded from third-party websites.

This package does not disable endpoint protection, change firewall policy during normal use, or request administrator rights. The release acceptance test may use administrator privileges on an isolated CI runner to enforce a temporary outbound-deny rule; that rule is test infrastructure, not a deployment step.

## Troubleshooting

| Symptom | Action |
|---|---|
| Missing or changed model file | Re-extract the matching verified ZIP. Do not enable remote fallback. |
| Wrong architecture or native module load error | Check that the archive matches the destination OS/CPU and read its prerequisite report. |
| Cannot write database | Set `OFFLINE_EMBEDDINGS_DATA` or pass `--db` to a user-owned location. |
| Embedding identity mismatch | Use the original matching package or rebuild a new index with the chosen model. |
| Poor retrieval | Check extraction, source labels, language, and corpus-specific questions. Compare keyword/semantic/hybrid modes. |
| High CPU usage | Reduce ingestion concurrency and configured inference threads; reuse the existing model worker. |

`doctor`, `demo`, and the verification report are the starting evidence for diagnosis. Avoid sharing private document text or database files when reporting an issue.

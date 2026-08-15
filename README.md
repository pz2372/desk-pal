# Desk Pal

A Tauri 2 prototype that turns full-body character images into animated 3D desktop companions using Tripo, then gives them private local chat and emotions. Users can create multiple pets; every visible pet gets its own transparent roaming desktop window, while the settings sidebar selects which pet to edit.

## Development

Requirements: Node 22+, Rust stable, and the platform prerequisites from the Tauri documentation.

```bash
npm install
npm run test
npm run tauri dev
```

The desktop app never asks for or stores a Tripo key. Start the generation server described in [server/README.md](server/README.md); only that server receives `TRIPO_API_KEY`.

## Local AI runtime

The app downloads the official Apache-2.0 Qwen3 0.6B Q8 GGUF on demand and verifies its SHA-256. To enable model inference, package a `llama-server` binary for each release target as a Tauri sidecar named `llama-server`. Until a sidecar is present, chat safely uses the built-in scripted response engine.

The creation image is sent to the configured Desk Pal generation server, which forwards it to Tripo. Pet assets, settings, and conversations are stored in the application data directory.

# Desk Pal

A Tauri 2 prototype that turns full-body character images into animated 3D desktop companions using Tripo, then gives them private local chat and emotions. Users can keep multiple pets in their library and choose one active pet from the settings sidebar to roam the desktop.

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

## Guided Blender rigging

Tripo remains the first automatic rigging attempt. If it cannot rig a humanoid
or quadruped, Desk Pal opens a guided 3D landmark screen. The generation server
then uses Blender to fit a canonical skeleton, calculate automatic skin weights,
validate the result, and export starter idle, walk, turn, jump, and reaction
clips. Tail and wing bones can be added to either supported family. Bird-specific
and serpentine templates are intentionally deferred.

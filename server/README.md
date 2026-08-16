# Desk Pal generation server

This service is the only component that receives the Tripo and OpenAI API keys. The desktop app never asks for or stores them.

For local development:

```bash
cd /Users/peter/Desktop/DesktopScreen
cp server/.env.example server/.env
```

Open `server/.env` and replace the example value with your real server-side key:

```dotenv
TRIPO_API_KEY=tsk_your_real_key
OPENAI_API_KEY=sk_your_real_key
OPENAI_VISION_MODEL=gpt-5.6-sol
HOST=127.0.0.1
PORT=8787
BLENDER_BIN=blender
```

Then start the service:

```bash
npm run server
```

The pipeline uses three independent, retryable artifacts. Tripo first creates and
the desktop saves `base.glb` in the user's Tauri application-data directory. A separate Blender rig job renders six neutral model
views, lets GPT refine the image-first anatomy profile, projects landmarks onto
the mesh, optimizes overly dense geometry, and saves `rigged.glb`. Only uncertain
landmarks enter the guided correction screen. A final independent Blender job
applies the reusable `idle`, `walk`, `turn`, `jump`, and `react` library and saves
`pet.glb`. A rig or animation retry therefore reuses the last successful local
artifact and never repeats paid Tripo model generation.

During an active creation session, each new job references the previous Render
job's temporary GLB by its protected job ID and token. The base model therefore
moves into rigging, and the rigged model into animation, without being uploaded
again. If that temporary copy has already expired, the desktop falls back to a
raw `model/gltf-binary` artifact upload from its local copy; GLBs are never
base64-encoded into large JSON requests.

Render is temporary compute, not the pet database. It keeps a processing copy only
while a job is running and long enough for the desktop to download the result.
Downloaded and terminal artifacts expire after one hour, with a 24-hour maximum
for abandoned work. When private R2
storage is configured, `base.glb`, `rigged.glb`, and `animated.glb` are also stored
under one opaque artifact ID so an expired Render job can resume without another
desktop upload. The desktop stores the artifact ID and a server-signed receipt; it
never receives R2 credentials or a public bucket URL.

Create a private R2 bucket and a bucket-scoped Object Read & Write API token, then
add these Render environment variables:

```dotenv
R2_ACCOUNT_ID=your_cloudflare_account_id
R2_ACCESS_KEY_ID=your_r2_access_key_id
R2_SECRET_ACCESS_KEY=your_r2_secret_access_key
R2_BUCKET=desk-pal-artifacts
ARTIFACT_SIGNING_SECRET=a_random_64_character_hex_secret
```

Set an R2 lifecycle rule for the `user-artifacts/` prefix. A 30-day expiration is
a reasonable prototype default: local pet files remain permanent on the user's
computer, while R2 exists only to support later rig/animation retries. Company-owned
rig templates and animation libraries should use a different prefix without this
short expiration rule.

For Render, deploy the repository root as a **Docker Web Service**. The included
[`Dockerfile`](../Dockerfile) installs Node and Blender. Configure:

```text
Health Check Path: /health
```

Add `TRIPO_API_KEY` and `OPENAI_API_KEY` in Render's Environment settings. The
optional `OPENAI_VISION_MODEL` setting defaults to `gpt-5.6-sol`. Before a paid
Tripo job starts, the server sends the selected character views to the OpenAI
Responses API with storage disabled and returns actionable image-quality issues.
The Docker image sets the
Blender path and start command; Render supplies `PORT` automatically. Blender is
memory intensive, so a service with at least 2 GB RAM is recommended for real
generation jobs.

The desktop app defaults to the deployed Blender-enabled Desk Pal service at
`https://desk-pal-blender.onrender.com` in both development and packaged release builds.
To point a development run at this local server instead, use:

```bash
DESK_PAL_SERVER_URL=http://127.0.0.1:8787 npm run tauri dev
```

For distribution, host this service behind HTTPS and bake its public address into the app—the end user does not configure either the URL or Tripo credentials:

```bash
DESK_PAL_SERVER_URL=https://your-generation-service.example npm run tauri build
```

`DESK_PAL_SERVER_URL` remains available as an override for staging or a future
custom domain.

The prototype server limits each IP to five creation jobs per hour. Production
deployment should replace its in-memory job registry with a background queue and
authenticated user quotas. R2 stores retry artifacts, but Blender process isolation
and a single-concurrency worker queue should still be added before public use.

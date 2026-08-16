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

Render is temporary compute, not the pet database. It keeps a processing copy only
while a job is running and long enough for the desktop to download the result.
Downloaded artifacts are queued for deletion after 15 minutes; other terminal jobs
expire after one hour, with a 24-hour maximum for abandoned work. Reference images,
pet models, rigged models, and final animated pets are not copied into company object
storage. A private company bucket may later hold only Desk Pal-owned rig templates,
animation clips, and version manifests shared by all users.

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
authenticated user quotas. Object storage is needed only for company-owned reusable
rig/animation library assets, not for user pets. Blender process isolation should
also be tightened before public use.

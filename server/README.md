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

The smart rigging path requires Blender 3.4 or newer to be installed. Verify it with
`blender --version`. After Tripo creates the unrigged model, Blender renders six
neutral views of the completed GLB. GPT compares those renders with
the original upload, classifies the body, and returns strict normalized landmark
coordinates. Blender ray-projects confident points onto the actual mesh, creates
the armature, applies automatic skin weights, validates it, and exports starter
`idle`, `walk`, `turn`, `jump`, and `react` actions. Only low-confidence or
unprojectable points are sent to the existing guided correction screen. When
`OPENAI_API_KEY` is configured this replaces paid Tripo rigging/retargeting; the
older Tripo animation path is retained only as a no-GPT fallback.

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

The prototype server limits each IP to five creation jobs per hour and removes completed job data after 24 hours. Production deployment should replace its in-memory job registry with durable storage, a background job queue, object storage, authenticated user quotas, and stricter Blender process isolation.

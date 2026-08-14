# Desk Pal generation server

This service is the only component that receives the Tripo API key. The desktop app never asks for or stores it.

For local development:

```bash
cd /Users/peter/Desktop/DesktopScreen
cp server/.env.example server/.env
```

Open `server/.env` and replace the example value with your real server-side key:

```dotenv
TRIPO_API_KEY=tsk_your_real_key
HOST=127.0.0.1
PORT=8787
```

Then start the service:

```bash
npm run server
```

For Render, deploy the repository root as a **Web Service** with:

```text
Build Command: npm install
Start Command: npm start
Health Check Path: /health
```

Add `TRIPO_API_KEY` in Render's Environment settings. Render supplies `PORT`
automatically, and the server binds to `0.0.0.0` when running there.

Then run the desktop app in a second terminal. The client defaults to `http://127.0.0.1:8787`.

For distribution, host this service behind HTTPS and bake its public address into the app—the end user does not configure either the URL or Tripo credentials:

```bash
DESK_PAL_SERVER_URL=https://your-generation-service.example npm run tauri build
```

The prototype server limits each IP to five creation jobs per hour and removes completed job data after 24 hours. Production deployment should replace its in-memory job registry with durable storage and authenticated user quotas.

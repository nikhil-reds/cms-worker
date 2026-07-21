# CMS Worker

A headless NestJS background worker fleet for the CMS platform. One codebase, multiple worker roles selected via `WORKER_ROLE`:

| Role | Status | Purpose |
|---|---|---|
| `media-sync` | ✅ **Working** | Sync S3 media to the Player and auto-play it |
| `playlist-render` | ✅ **Working** | Render CMS playlists into a single MP4 with ffmpeg and auto-play it in the Player |
| `notification` | 🚧 Skeleton | Emails, webhooks, push, internal alerts (device offline, sync failures, …) |
| `analytics` | 🚧 Skeleton | Telemetry ingestion: heartbeats, proof-of-play, batch inserts, rollups |
| `sensor` | 🚧 Skeleton | Sensor events (motion, proximity, …) → rule engine → playback/notify actions |
| `scheduler` | 🚧 Skeleton | Cron work: calendar/playlist time windows, offline-device detection, cleanup |
| `all` | — | Run every worker in one process (dev / small deployments) |

```bash
WORKER_ROLE=media-sync node dist/main.js    # one role per process (production)
WORKER_ROLE=all        node dist/main.js    # everything in one process (dev)
```

At scale, deploy separate replicas per role so heavy analytics ingestion never blocks notifications or scheduling.

---

# Playlist Render Worker

Watches the CMS `playlists` / `playlist_items` / `media` tables (polling, 30 s), pulls the playlist JSON the CMS writes to S3 (`AWS_BUCKET_PLAYLIST`, key `playlists/{id}.json`), renders the whole playlist into **one MP4** with ffmpeg, and installs it into the Player so it plays automatically.

```
CMS saves playlist ──► Postgres + S3 playlists/{id}.json
                                │
        worker detects a changed content fingerprint (worker-owned
        player_playlist_render table — CMS schema never modified)
                                │
   1. fetch playlists/{id}.json (falls back to DB if missing/invalid)
   2. resolve media: reuse files media-sync already downloaded,
      else stream from S3 by s3Key (never the private cdnUrl)
   3. normalize every item to a uniform H.264/AAC segment
      (images shown durationSec, videos trimmed, silent audio injected;
      segments cached — editing 1 item re-encodes only that item)
   4. concat segments (stream copy) → playlist-{id}.mp4, ffprobe-validated
   5. upload to s3://AWS_BUCKET_MEDIA_PROCESSED/playlists/{id}.mp4
   6. atomic install into player/media/videos/ + config.json entry
```

- Re-renders automatically when items/order/durations change; deleting the playlist in the CMS removes the MP4 and its player entry.
- Failed renders retry up to 3 times, then dead-letter until the playlist changes again.
- `PLAYLIST_RENDER_MODE=append` (default) adds the rendered video alongside existing player entries; `exclusive` makes it the only playlist entry.
- Verify the ffmpeg pipeline without DB/S3: `npm run smoke:render`.

---

# Media Sync Worker

The fully implemented worker. It **listens to the CMS database (Neon PostgreSQL)**, downloads newly uploaded media from **AWS S3**, saves it into the **Player application's media folder**, and updates the player's playlist so the new media **starts playing automatically** — no restart needed.

```
CMS uploads media → Neon PostgreSQL (media table, status = READY)
                          │
                          │  worker polls every 30s
                          ▼
                  ┌───────────────────┐
                  │    cms-worker     │
                  │  1. detect new    │
                  │  2. download S3   │
                  │  3. save to disk  │
                  │  4. update config │
                  └───────────────────┘
                          │
                          ▼
        /Users/nikhil/Desktop/player/media/{videos|images|audio}/
        /Users/nikhil/Desktop/player/config.json  (playlist updated)
                          │
                          │  player re-reads config every 15s
                          ▼
                Electron player auto-plays the new media
```

---

## How It Works

### 1. Listening to the database

The worker polls Neon every 30 seconds (configurable) for media that is ready but not yet synced:

```sql
SELECT m.id, m.tenant_id, m.filename, m.s3_key, m.size_bytes, mt.name AS media_type
FROM media m
LEFT JOIN media_types mt        ON mt.id = m.media_type_id
LEFT JOIN player_media_sync s   ON s.media_id = m.id
WHERE m.status = 'READY'
  AND m.s3_key IS NOT NULL
  AND (s.media_id IS NULL OR (s.sync_status = 'failed' AND s.sync_attempts < 3))
ORDER BY m.created_at ASC
```

**The CMS schema (Prisma-managed) is never modified.** Sync state lives in one worker-owned table, `player_media_sync`, which the worker creates automatically on startup:

| Column | Meaning |
|---|---|
| `media_id` | references `media.id` |
| `local_path` | where the file was saved in the player |
| `sync_status` | `pending` \| `syncing` \| `completed` \| `failed` |
| `sync_error` | last error message |
| `sync_attempts` | failed 3+ times = dead-lettered (skipped, needs manual reset) |
| `synced_at` | completion timestamp |

"New media" simply means: a `READY` row in `media` with no completed record in `player_media_sync`. Upload something in the CMS → the worker picks it up on the next poll.

### 2. Downloading from S3

- Bucket comes from `.env` (`S3_BUCKET`, e.g. `redsxp-assets`); the object key comes from `media.s3_key` (e.g. `uploads/1783763456361-photo.jpg`).
- Files are **streamed** to disk (a 1 GB video never sits in RAM).
- Up to 5 files download in parallel (configurable).
- Failures retry automatically on later polls (max 3 attempts, then dead-lettered).

### 3. Saving into the Player

Files are sorted into the player's folder layout by type (detected from `media_types.name` with a file-extension fallback):

```
player/media/videos/   ← .mp4 .mov .webm .mkv ...
player/media/images/   ← .jpg .png .gif .webp ...
player/media/audio/    ← .mp3 .wav .aac .m4a ...
```

### 4. Auto-playing in the Player

After each successful sync the worker appends an entry to the player's `config.json` playlist (atomic write — temp file + rename — so the player never reads a half-written config):

```json
{
  "id": "102f437e-46c2-4d71-8a64-1d36a3718166",
  "type": "image",
  "src": "media/images/71GGdoIkCeL.jpg",
  "muted": true,
  "durationMs": 8000
}
```

- Entries are **deduped by `src`** (re-syncs update in place, no duplicates).
- **Non-playable uploads** (`.txt`, `.zip`, `.pdf`, …) are synced to disk but kept **out** of the playlist.
- The player (`app.js`) re-reads `config.json` every 15 seconds and starts playing new items automatically: videos play to the end, images display for `durationMs` (default 8 s), broken files are skipped.

---

## Setup

### Prerequisites

- Node.js 18+
- Access to the Neon PostgreSQL database
- AWS credentials with read access to the media bucket
- The Player app on the same machine (default: `/Users/nikhil/Desktop/player`)

### 1. Install

```bash
npm install
```

### 2. Configure `.env`

```env
NODE_ENV=development
LOG_LEVEL=info
WORKER_ROLE=media-sync   # all | media-sync | notification | analytics | sensor | scheduler

# Neon PostgreSQL (CMS database)
DATABASE_URL="postgresql://user:password@host/neondb?sslmode=require"

# AWS S3
S3_BUCKET=redsxp-assets
AWS_REGION=ap-south-1
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...

# Player application
PLAYER_ROOT_PATH=/Users/nikhil/Desktop/player
PLAYER_MEDIA_ROOT_PATH=/Users/nikhil/Desktop/player/media

# Optional: control a player on another laptop on the same Wi-Fi.
# Use the player laptop's Wi-Fi IP address.
PLAYER_API_URL=http://192.168.1.25:3030
PLAYER_API_TOKEN=change-me

# Production-style pull sync: publish the active playlist manifest to S3.
PLAYER_DEVICE_ID=SL-PLAYER-001
PLAYER_MANIFEST_BUCKET=redsxp-media-processed
PLAYER_MANIFEST_KEY=manifests/SL-PLAYER-001.json
PLAYER_CDN_URL=https://d111111abcdef8.cloudfront.net
NEXT_PUBLIC_CDN_URL=https://d111111abcdef8.cloudfront.net
PLAYER_MANIFEST_PUBLIC_BASE_URL=https://d111111abcdef8.cloudfront.net

# Sync behaviour
MEDIA_SYNC_INTERVAL_MS=30000        # poll every 30s
MEDIA_SYNC_CONCURRENCY=5            # parallel downloads
MEDIA_ENABLE_CHECKSUM_VALIDATION=true
MEDIA_MAX_DISK_USAGE_PERCENT=80     # auto-delete oldest files above this
```

> ⚠️ `.env` contains live credentials — never commit it. Rotate the keys if it ever leaks.

### 3. Run

```bash
# development (watch mode)
npm run start:dev

# production
npm run build
node dist/main.js
```

No manual database migration is needed — the worker creates `player_media_sync` on first startup.

### 4. Run the Player

```bash
cd /Users/nikhil/Desktop/player
npm start
```

For a player on another laptop, start the player there and point this worker at
that laptop:

```bash
# player laptop
PLAYER_LAN_PORT=3030 PLAYER_LAN_TOKEN=change-me npm start
```

```env
# worker laptop .env
PLAYER_API_URL=http://<player-wifi-ip>:3030
PLAYER_API_TOKEN=change-me
```

If no token is set on the player, omit `PLAYER_API_TOKEN`. Make sure both
laptops are on the same Wi-Fi and the player laptop firewall allows port `3030`.

For BrightSign-style pull sync, let the scheduler publish a manifest and start
the player with that manifest URL:

```env
# worker .env
WORKER_ROLE=scheduler
PLAYER_DEVICE_ID=SL-PLAYER-001
PLAYER_MANIFEST_BUCKET=redsxp-media-processed
PLAYER_MANIFEST_KEY=manifests/SL-PLAYER-001.json
PLAYER_CDN_URL=https://d111111abcdef8.cloudfront.net
NEXT_PUBLIC_CDN_URL=https://d111111abcdef8.cloudfront.net
PLAYER_MANIFEST_PUBLIC_BASE_URL=https://d111111abcdef8.cloudfront.net
```

```bash
# player laptop/device
PLAYER_MANIFEST_URL=https://d111111abcdef8.cloudfront.net/manifests/SL-PLAYER-001.json \
PLAYER_CDN_URL=https://d111111abcdef8.cloudfront.net \
PLAYER_SYNC_INTERVAL_MS=30000 \
npm start
```

When `PLAYER_MANIFEST_BUCKET` is configured, the scheduler publishes the active
playlist manifest to S3. The player then pulls the manifest, downloads the
rendered MP4 locally, and switches playback only after the file is cached.

Healthy startup logs look like:

```
DbListenerService: Database connection successful
DbListenerService: player_media_sync tracking table ready
MediaSyncService: Starting polling loop (interval: 30000ms)
MediaSyncService: Found 10 media items to sync
MediaSyncService: ✓ Synced 102f437e-… in 732ms and added to player playlist
MediaSyncProcessor: 📊 Stats: Pending=0 | Syncing=0 | Completed=10 | Failed=0 | DLQ=0 | Disk=2%
```

---

## Project Structure

```
src/
├── main.ts                              Headless NestJS bootstrap + graceful shutdown
├── app.module.ts                        Root module: loads worker modules based on WORKER_ROLE
├── config/config.ts                     Zod schema for all environment variables
├── common/logger.ts                     Pino structured logging
├── database/migrations/
│   └── 001_create_player_media_sync.sql Reference DDL (worker auto-creates this table)
└── processors/
    ├── media-sync/                      ✅ WORKING — S3 → Player sync + auto-play
    │   ├── media-sync.module.ts         Wiring / dependency injection
    │   ├── media-sync.processor.ts      Starts the worker on bootstrap, logs stats every minute
    │   ├── media-sync.service.ts        Orchestrator: polling loop, concurrency, disk checks
    │   ├── db-listener.service.ts       Neon queries: poll, mark syncing/completed/failed, stats
    │   ├── s3-client.service.ts         Streaming S3 downloads with progress
    │   ├── file-system.service.ts       Type-folder routing, SHA-256 checks, disk cleanup
    │   ├── player-config.service.ts     Atomic playlist updates in the player's config.json
    │   └── media-sync.types.ts          Shared TypeScript interfaces
    │
    ├── notification/                    🚧 SKELETON — alert delivery pipeline
    │   ├── notification.module.ts
    │   ├── notification.processor.ts    Bootstrap
    │   ├── notification.service.ts      TODO: channels (email/webhook/push), dedupe, retries
    │   └── notification.types.ts        NotificationEvent, delivery results, severities
    │
    ├── analytics/                       🚧 SKELETON — telemetry ingestion
    │   ├── analytics.module.ts
    │   ├── analytics.processor.ts       Bootstrap
    │   ├── analytics.service.ts         TODO: validate, dedupe, batch-insert, rollups
    │   └── analytics.types.ts           AnalyticsEvent (heartbeat, proof-of-play, ...)
    │
    ├── sensor/                          🚧 SKELETON — sensor events → actions
    │   ├── sensor.module.ts
    │   ├── sensor.processor.ts          Bootstrap
    │   ├── sensor.service.ts            TODO: rule engine (play media / switch playlist / notify)
    │   └── sensor.types.ts              SensorEvent, SensorRule, trigger types
    │
    └── scheduler/                       🚧 SKELETON — time-based work
        ├── scheduler.module.ts
        ├── scheduler.processor.ts       Bootstrap
        ├── scheduler.service.ts         TODO: calendar windows, offline detection, cleanup, rollups
        └── scheduler.types.ts           ScheduledJob, job types, run results
```

Every worker follows the same four-file pattern — `module` (wiring) → `processor` (bootstrap) → `service` (logic) → `types` (contracts) — so implementing a new worker means filling in the `TODO`s in its service, and adding a role means copying the folder and registering it in `app.module.ts`.

### Player-side changes (in `/Users/nikhil/Desktop/player`)

- **`app.js`** — plays the full playlist in a loop (was: one hardcoded video), re-reads `config.json` every 15 s, skips broken files.
- **`electron/main.cjs`** — added `allow-file-access-from-files` so the renderer can re-read `config.json` from disk.
- **`config.json`** — `refreshIntervalMs: 15000`; playlist is maintained by the worker.

---

## Operations

### Check sync status

```sql
-- Overview
SELECT sync_status, COUNT(*) FROM player_media_sync GROUP BY sync_status;

-- Failures with reasons
SELECT media_id, sync_error, sync_attempts
FROM player_media_sync
WHERE sync_status = 'failed';

-- What hasn't been picked up yet
SELECT m.id, m.filename FROM media m
LEFT JOIN player_media_sync s ON s.media_id = m.id
WHERE m.status = 'READY' AND s.media_id IS NULL;
```

### Re-sync a file

```sql
-- Force a retry (worker picks it up on the next poll)
UPDATE player_media_sync
SET sync_status = 'failed', sync_attempts = 0
WHERE media_id = '<id>';

-- Or fully re-download
DELETE FROM player_media_sync WHERE media_id = '<id>';
```

### Troubleshooting

| Symptom | Check |
|---|---|
| Worker won't start | `.env` present? `DATABASE_URL` reachable? Run with `LOG_LEVEL=debug` |
| Nothing syncs | Is the media row `status = 'READY'` with a non-null `s3_key`? |
| S3 download fails | Bucket/region/credentials in `.env`; object key exists in the bucket |
| Synced but not playing | Playable extension? (`.txt`/`.zip` are deliberately excluded) Player running with the updated `app.js`? |
| Stuck in `syncing` | Worker crashed mid-download — reset the row (see *Re-sync a file*) |
| Disk filling up | Worker auto-deletes oldest media above `MEDIA_MAX_DISK_USAGE_PERCENT` (default 80%) |

---

## Design Notes

- **Why polling instead of LISTEN/NOTIFY?** Simpler, survives connection drops, and works with Neon's pooled connections. At a 30 s interval the load is one indexed query per poll. Can be upgraded later without changing the processor boundaries.
- **Why a separate `player_media_sync` table?** The CMS schema is Prisma-managed; adding columns to `media` would fight its migrations. A side-table keeps the worker fully decoupled — dropping it removes every trace of the worker.
- **Idempotency:** the poll query only returns unsynced/retryable rows, an in-process map prevents duplicate concurrent syncs of the same file, and playlist entries are deduped by `src`. Restarting the worker at any point is safe.
- **Atomic config writes:** `config.json` is written to a temp file then renamed, so the player can never observe a truncated JSON file.

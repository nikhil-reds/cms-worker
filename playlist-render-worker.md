# Playlist Render Worker — How It Works

The `playlist-render` worker turns a CMS playlist (a list of images and videos with durations) into **one single MP4 video**, uploads it to S3 (`redsxp-media-processed`), and puts it inside the Player app so it starts playing automatically.

```
CMS (save playlist) ──► Postgres + S3 (playlists/{id}.json)
                                 │
                                 ▼   worker polls every 30 s
                     ┌───────────────────────────┐
                     │   playlist-render worker   │
                     └───────────────────────────┘
                                 │
                 ┌───────────────┴────────────────┐
                 ▼                                ▼
  s3://redsxp-media-processed/          player/media/videos/playlist-{id}.mp4
       playlists/{id}.mp4               player/config.json  (entry added)
                                                  │
                                                  ▼
                                     Player picks it up and plays it
```

---

## The Files (what each one does)

All code lives in `src/workers/playlist-render/`.

### 1. `playlist-render.types.ts` — the shapes of the data

No logic, just definitions:

- **`PlaylistJsonSchema`** — a zod validator describing the JSON the CMS uploads to S3 (`playlists/{id}.json`). When we download that JSON we run it through this schema, so bad/old JSON never crashes the worker.
- **`PendingPlaylist`** — a playlist the poll query says needs rendering.
- **`ResolvedItem`** — one playlist item after we located its media file on disk (`mediaId`, `position`, `durationSec`, `kind` = video/image/audio, `localPath`).
- **`PlaylistRenderConfig`** — all settings (buckets, resolution, fps, paths, ffmpeg binaries).

### 2. `playlist-db.service.ts` — talks to the database ("the ears")

This is how the worker "listens to the tables". The CMS has no triggers or notifications, so we poll:

- **`pollForChanges()`** — one SQL query that computes a **fingerprint** (an `md5` hash) per playlist from: the playlist's `updated_at` + every item's `media_id : position : duration_sec : media.updated_at`. If the fingerprint is different from the last render (or the playlist was never rendered), it needs rendering. Change anything in the playlist → hash changes → re-render.
- **`player_playlist_render` table** — created automatically on startup. This is the worker's own memory: which playlist was rendered, with which fingerprint, where the MP4 is, how many times it failed. **The CMS tables are never modified.**
- **`getLocalMediaPaths()`** — asks the media-sync worker's table (`player_media_sync`) "did you already download these files?" so we don't download from S3 again.
- **`loadPlaylistFromDb()`** — backup plan: builds the playlist JSON straight from the database if the S3 JSON is missing or broken.
- **`markAsRendering / markAsCompleted / markAsFailed`** — status bookkeeping. 3 failures in a row = dead-lettered (skipped until the playlist changes again).
- **`findDeletedPlaylists()`** — finds tracked playlists that no longer exist in the CMS, so we can clean up their MP4s.

### 3. `playlist-s3.service.ts` — talks to S3 ("the hands")

Two jobs only:

- **`fetchPlaylistJson(bucket, playlistId)`** — downloads `playlists/{id}.json` from the playlist bucket (`redsxp-playlist`) and validates it. Returns `null` if missing/invalid (then the DB fallback kicks in).
- **`downloadFile(bucket, s3Key, localPath)`** — streams a media file from the media bucket (`redsxp-assets`) to disk. Streaming means a 1 GB video never sits in RAM.
- **`uploadFile(bucket, s3Key, localPath, contentType)`** — uploads the finished MP4 to the processed bucket (`redsxp-media-processed`) as a streamed multipart upload, and returns the object URL.
- **`deleteObject(bucket, s3Key)`** — removes the uploaded MP4 when its playlist is deleted in the CMS.

> ⚠️ Important: the `cdnUrl` inside the playlist JSON points at a **private** bucket and would give a 403. That's why we always download using `s3Key` + AWS credentials, never the URL.

### 4. `ffmpeg-render.service.ts` — makes the video ("the factory")

Turns the resolved items into one MP4, in two steps:

**Step A — normalize each item into a "segment"**
Every item becomes a small `.ts` video file with identical properties (1920×1080, 30 fps, H.264 video + AAC audio):

| Item type | What happens |
|---|---|
| Image | Shown as a still frame for its `durationSec`, silent audio added |
| Video | Scaled/padded to fit, trimmed to `durationSec`; silent audio added if it has none |
| Audio | Played over a black screen |

Segments are **cached** by `mediaId + duration + profile`. Edit one item in a 50-item playlist → only that one item is re-encoded.

**Step B — concat**
All segments are glued together with ffmpeg's concat demuxer using **stream copy** (no re-encoding — that's why it's fast). The result is checked with `ffprobe` (has video? sane duration?) before it's accepted.

ffmpeg/ffprobe binaries come bundled from the `ffmpeg-static` / `ffprobe-static` npm packages — nothing to install on the machine.

### 5. `playlist-render.service.ts` — the conductor ("the brain")

Ties everything together. Every 30 seconds it runs this loop:

1. **Cleanup** — any playlist deleted in the CMS? Remove its MP4, its `config.json` entry, and its tracking row.
2. **Detect** — ask `playlist-db.service` which playlists changed.
3. For each changed playlist (one at a time — ffmpeg is heavy):
   - **Fetch** the playlist JSON from S3 (fall back to DB if needed).
   - **Resolve** every item's media file: reuse media-sync's local copy if it exists, otherwise download from S3. Items that aren't `READY` or aren't a playable type are skipped with a warning — one bad item doesn't kill the render.
   - **Render** via `ffmpeg-render.service`.
   - **Upload** the finished MP4 to `s3://redsxp-media-processed/playlists/{id}.mp4` (done *before* the local install, so a failed upload retries cleanly without ever touching the player).
   - **Install** the MP4 into `player/media/videos/playlist-{id}.mp4` (written to a temp name then renamed = atomic, the player can never read a half-written file).
   - **Update** the player's `config.json` so it plays (append mode adds it; exclusive mode makes it the only entry).
   - **Mark** completed (or failed) in the tracking table, including the S3 key and URL of the uploaded copy.

### 6. `playlist-render.processor.ts` — the starter

Runs when the app boots: starts the service and prints a stats line every minute (`Pending / Rendering / Completed / Failed / DLQ`).

### 7. `playlist-render.module.ts` — the wiring

NestJS module: reads all env vars (`AWS_BUCKET_PLAYLIST`, `PLAYLIST_RENDER_*`, `FFMPEG_PATH`, …), builds the config object, and connects the services together. This is where the worker gets registered under `WORKER_ROLE=playlist-render` (see `src/app.module.ts`).

### Supporting files (outside the folder)

- `src/workers/media-sync/player-config.service.ts` — reused from the media-sync worker; safely reads/writes the player's `config.json` (gained a `replacePlaylist()` method for exclusive mode).
- `src/config/config.ts` — env validation; `playlist-render` added to the role list.
- `scripts/render-smoke-test.ts` — standalone test for the ffmpeg pipeline (see Testing below).

---

## The Flow (end to end)

```
1. You save/edit a playlist in the CMS
      → CMS updates playlists + playlist_items in Postgres
      → CMS uploads playlists/{id}.json to s3://redsxp-playlist

2. Within 30 s the worker polls Postgres
      → computes the fingerprint → sees it changed → queues a render

3. Worker fetches playlists/{id}.json from S3
      → (missing/broken? builds the same data from Postgres instead)

4. Worker locates each media file
      → already on disk thanks to media-sync?  use it
      → not on disk?  stream-download from s3://redsxp-assets by s3Key

5. ffmpeg: each item → uniform segment (cached) → concat → playlist-{id}.mp4
      → ffprobe validates the result

6. The MP4 is uploaded to s3://redsxp-media-processed/playlists/{id}.mp4

7. The MP4 is atomically installed into player/media/videos/
      → player config.json gets/updates the entry
      → player re-reads config.json (every 15 s) and starts playing

8. Tracking table updated (incl. s3_key + s3_url)
      → next poll sees "nothing changed" → idle
```

**Re-render:** change items/order/durations in the CMS → fingerprint changes → steps 2–8 repeat (fast, thanks to the segment cache); the S3 object is overwritten at the same key.
**Delete:** delete the playlist in the CMS → next poll removes the local MP4, the S3 copy in `redsxp-media-processed`, and the config entry.
**Failure:** a render error is retried up to 3 times, then parked (DLQ) until the playlist is edited again.

---

## How to Test It

### Test 1 — ffmpeg pipeline only (no DB, no S3, no AWS keys needed)

```bash
npm run smoke:render
```

Generates a test image + two test videos, renders them as a 3-item playlist, checks duration and streams, and re-renders to prove the segment cache works. Expected ending:

```
RENDER OK: { outputPath: '...', durationSec: 10 }
OUTPUT PROBE: { durationSec: 10.06, hasAudio: true, hasVideo: true }
RE-RENDER (cached segments) took ~70ms
SMOKE TEST PASSED
```

### Test 2 — the full worker against the real CMS

Make sure `.env` has `DATABASE_URL`, AWS credentials, `AWS_BUCKET_MEDIA`, `AWS_BUCKET_PLAYLIST`, and `PLAYER_ROOT_PATH`. Then:

```bash
WORKER_ROLE=playlist-render npm run start:dev
```

Watch the logs. On the first run you should see something like:

```
player_playlist_render tracking table ready
Found 5 playlist(s) to render
Rendering playlist "nikhil" (deb41aba-..., 3 items)
Encoding segment: video ... (10s)
Concatenating 3 segment(s) → ...
Uploading ... → s3://redsxp-media-processed/playlists/deb41aba-....mp4
✓ Uploaded to https://redsxp-media-processed.s3.ap-south-1.amazonaws.com/playlists/deb41aba-....mp4
✓ Rendered "nikhil" → media/videos/playlist-deb41aba-....mp4 + s3://redsxp-media-processed/... (30s, 3985ms)
📊 Stats: Pending=0 | Rendering=0 | Completed=5 | Failed=0 | DLQ=0
```

Then verify each behavior:

| What to test | How | What should happen |
|---|---|---|
| Initial render | Just start the worker | Every playlist with items gets a `playlist-{id}.mp4` in `player/media/videos/`, an entry in `player/config.json`, and a copy at `s3://redsxp-media-processed/playlists/{id}.mp4` |
| Video plays | Open the Player app | The rendered playlist video plays (player re-reads config every 15 s) |
| Re-render on change | Edit a playlist in the CMS (reorder items, change a duration, add/remove media) | Within 30 s the worker logs `Found 1 playlist(s) to render` and replaces the MP4 |
| No useless work | Let it idle | After everything is rendered, polls find nothing; stats stay flat |
| S3 upload | Check the bucket (console or `aws s3 ls s3://redsxp-media-processed/playlists/`) | One MP4 per rendered playlist; `s3_url` in the tracking table points at it |
| Delete cleanup | Delete a playlist in the CMS | Within 30 s the MP4 is removed from the player and the processed bucket, and its config entry disappears |
| Failure handling | Add a media item whose file was deleted from S3 | Item is skipped (or render fails), `Failed` count rises, retries 3× then goes to `DLQ`; editing the playlist resets the counter |

### Test 3 — inspect the state directly

The worker's memory is one table in the CMS database:

```sql
SELECT playlist_id, render_status, render_attempts, output_path,
       s3_key, s3_url, duration_sec, rendered_at, render_error
FROM player_playlist_render
ORDER BY updated_at DESC;
```

- `completed` — rendered fine, `output_path` tells you where.
- `failed` + `render_error` — why it failed.
- Want to force a re-render of one playlist? Delete its row: `DELETE FROM player_playlist_render WHERE playlist_id = '...';` — next poll re-renders it.

### Useful settings while testing (`.env`)

```env
LOG_LEVEL=debug                    # see poll cycles and cache hits
PLAYLIST_RENDER_INTERVAL_MS=10000  # poll every 10 s instead of 30 s
PLAYLIST_RENDER_RESOLUTION=1280x720  # faster encodes on a laptop
PLAYLIST_RENDER_MODE=exclusive     # rendered video becomes the ONLY player entry
```

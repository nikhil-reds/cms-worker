# Playlist Render Worker — Implementation Plan

A new worker role (`playlist-render`) that watches the CMS `playlists` tables, pulls the
playlist JSON from S3 (`redsxp-playlist` bucket), renders the whole playlist into a
**single MP4 video** with ffmpeg, and drops it into the Player so it starts playing
automatically.

```
CMS saves playlist ──► Postgres (playlists / playlist_items)
        │
        └──► S3: redsxp-playlist / playlists/{id}.json   (written by CMS API on POST/PUT)
                                  │
              worker polls DB ────┤
                                  ▼
                    ┌──────────────────────────────┐
                    │   playlist-render worker      │
                    │ 1. detect changed playlists   │
                    │ 2. fetch playlists/{id}.json  │
                    │ 3. resolve media (local/S3)   │
                    │ 4. ffmpeg render → one MP4    │
                    │ 5. save into Player + config  │
                    └──────────────────────────────┘
                                  │
                                  ▼
            player/media/videos/playlist-{id}.mp4
            player/config.json  (entry added/updated, atomic write)
```

---

## Ground truth from the two codebases (verified)

| Fact | Where |
|---|---|
| Playlist JSON is uploaded to S3 key `playlists/{playlist.id}.json` | CMS `app/api/playlist/route.ts:122` (POST), `app/api/playlist/[id]/route.ts:123` (PUT) |
| Bucket = `process.env.AWS_BUCKET_PLAYLIST \|\| "redsxp-playlist"`, region fallback `ap-south-1` | both playlist routes |
| JSON is deleted from S3 when the playlist is deleted | `app/api/playlist/[id]/route.ts:153` (DELETE) |
| JSON shape: full playlist row + `playlistItems[]` (ordered by `position`), each with nested `media` (`s3Key`, `cdnUrl`, `durationSec`, `sizeBytes` as string, `status`) | `serializePlaylist()` in both routes |
| `media.cdnUrl` in the JSON is the **raw private-bucket URL** — NOT presigned. It is not directly downloadable. | presigning happens only in media GET routes |
| Media binaries live in a different bucket (`AWS_BUCKET`, keys `uploads/...`) | `app/api/media/presigned/route.ts` |
| No Postgres NOTIFY/triggers, no device-facing API, no sync flags — change detection must be polling | migrations + full API tree checked |
| Schedules (`calendars`) and device assignment do **not** rewrite the S3 JSON | `app/api/schedules/*` has no S3 calls |
| Existing worker pattern: poll every 30 s, worker-owned tracking table, streamed S3 downloads, atomic `config.json` writes | `src/workers/media-sync/*` |

---

## 1. Change detection — "listen to tables"

No triggers exist, so we poll (same strategy as `media-sync`). A playlist needs
(re-)rendering when its **content fingerprint** changes.

**Fingerprint** (computed in SQL, no CMS schema changes):

```sql
SELECT
  p.id,
  p.tenant_id,
  p.name,
  p.updated_at,
  md5(
    p.updated_at::text || '|' ||
    COALESCE(string_agg(
      pi.media_id || ':' || pi.position || ':' || pi.duration_sec || ':' || m.updated_at::text,
      ',' ORDER BY pi.position
    ), '')
  ) AS source_hash,
  COUNT(pi.id) AS item_count
FROM playlists p
LEFT JOIN playlist_items pi ON pi.playlist_id = p.id
LEFT JOIN media m           ON m.id = pi.media_id AND m.status = 'READY'
GROUP BY p.id
```

A playlist is queued for render when:
- no row exists in the worker's tracking table, **or**
- `source_hash` differs from the last rendered hash, **or**
- last render `failed` with `attempts < 3`.

Why hash the items too and not just `playlists.updated_at`: it also catches media
re-processing and protects against any future path that edits items without touching
the parent row.

**Worker-owned state table** (auto-created on startup, CMS schema untouched — same
convention as `player_media_sync`):

```sql
CREATE TABLE IF NOT EXISTS player_playlist_render (
  playlist_id     TEXT PRIMARY KEY,
  source_hash     TEXT,
  render_status   VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending|rendering|completed|failed
  render_error    TEXT,
  render_attempts INT NOT NULL DEFAULT 0,
  output_path     TEXT,              -- e.g. media/videos/playlist-<id>.mp4
  duration_sec    INT,               -- duration of the rendered video
  rendered_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Poll interval: `PLAYLIST_RENDER_INTERVAL_MS` (default 30 000), aligned with media-sync.

**Deletions:** each poll also diffs tracking rows against live `playlists` rows; a
tracked playlist that no longer exists → delete rendered MP4, remove the
`config.json` entry, drop the tracking row.

## 2. Fetch the playlist JSON from S3

- `GET s3://${S3_BUCKET_PLAYLIST}/playlists/{id}.json` via `@aws-sdk/client-s3`
  (reuse/extend the existing `S3ClientService`).
- Parse and validate with a zod schema (`playlistItems[]` present, each item has
  `media.s3Key`, `durationSec`, media `status === 'READY'`).
- The DB is the change signal; the S3 JSON is the render input — if the JSON is
  missing or stale (CMS write failed), fall back to building the same structure
  directly from the DB query so a render is never blocked by a missed upload.

## 3. Resolve media files (cheap before expensive)

For each `playlistItems[].media`, in order:

1. **Local reuse:** check `player_media_sync.local_path` — if media-sync already
   downloaded the file and it exists on disk, use it. Zero download.
2. **S3 fallback:** stream-download `media.s3Key` from the **media** bucket
   (`S3_BUCKET`, not the playlist bucket) into a scratch dir.
   Never use `cdnUrl` from the JSON — the bucket is private and that URL 403s.
3. Item media not `READY` or download dead-lettered → **skip the item** (log it),
   render the rest. An empty resolvable list → mark render failed.

## 4. Render one video with ffmpeg

**Approach: per-item normalization → concat demuxer.** Robust against mixed
codecs/resolutions/framerates, and failed items are isolated.

**Stage A — normalize each item to a uniform segment** (`.ts` intermediates in scratch):

- Common profile: `1920x1080`, 30 fps, H.264 (`-profile:v high -pix_fmt yuv420p`),
  AAC 48 kHz stereo. Configurable via env.
- **Image** → `-loop 1 -t {durationSec} -i img` + `scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2` + silent audio track (`anullsrc`) so concat audio streams line up.
- **Video** → same scale/pad/fps normalization; trim to `durationSec`
  (`-t {durationSec}`); if the source is shorter, `PLAYLIST_RENDER_SHORT_VIDEO`
  decides `natural` (keep shorter, default) vs `loop` to fill.
- **Audio-only** → black (or tenant `primaryColor`) background + the audio track.
- Segments cached by `{mediaId}:{durationSec}:{profileHash}` so re-renders after a
  one-item edit only re-encode what changed.

**Stage B — concat:**

```
ffmpeg -f concat -safe 0 -i list.txt -c copy -movflags +faststart out.mp4
```

Stream-copy concat of identical-profile TS segments — the expensive encode happens
once per item, not once per playlist.

**Stage C — atomic install:** render fully in scratch, then move into
`player/media/videos/playlist-{id}.mp4` (tmp name + rename). Probe the result with
`ffprobe` (duration within ±2 s of expected) before installing.

Concurrency: **1 render at a time** by default (`PLAYLIST_RENDER_CONCURRENCY=1`) —
ffmpeg saturates the box; per-item segment encodes inside a render may parallelize
lightly (2–3).

Binary: `fluent-ffmpeg` + `ffmpeg-static`/`ffprobe-static` npm packages (no system
install needed), overridable via `FFMPEG_PATH` / `FFPROBE_PATH`.

## 5. Save into the Player

Reuse `PlayerConfigService` (atomic tmp+rename writes, dedupe by `src`):

```json
{
  "id": "<playlistId>",
  "type": "video",
  "src": "media/videos/playlist-<playlistId>.mp4",
  "loop": true,
  "muted": false
}
```

- Same `src` on re-render → entry updated in place; the player's 15 s config re-read
  picks it up. The file is replaced by rename, so the player never reads a torn file.
- `PLAYLIST_RENDER_MODE=append|exclusive` (default `append`): `exclusive` replaces the
  whole player playlist with just the rendered video — useful once devices should play
  exactly one playlist; `append` coexists with media-sync's per-file entries.
- On success: `markCompleted(playlistId, hash, outputPath, durationSec)`.
- On failure: increment `render_attempts`; ≥3 → dead-letter (skip until hash changes,
  which resets attempts).

## 6. Code layout

```
src/workers/playlist-render/
  playlist-render.module.ts       # wires providers, exposes module (mirror media-sync.module.ts)
  playlist-render.processor.ts    # setInterval poll loop + graceful shutdown
  playlist-render.service.ts      # orchestrator: detect → fetch → resolve → render → install
  playlist-db.service.ts          # fingerprint query + player_playlist_render state (mirror db-listener.service.ts)
  playlist-s3.service.ts          # fetch playlists/{id}.json + media downloads (extend s3-client.service.ts)
  ffmpeg-render.service.ts        # segment normalization, concat, ffprobe validation, segment cache
  playlist-render.types.ts        # zod schema for the S3 JSON + internal types
```

Wiring changes:
- `src/config/config.ts` — add `playlist-render` to the `WORKER_ROLE` enum + new env vars.
- `src/app.module.ts` — register `PlaylistRenderModule` in the role map.
- `README.md` — new role row + section.

New env (`.env.example`):

```env
S3_BUCKET_PLAYLIST=redsxp-playlist
PLAYLIST_RENDER_INTERVAL_MS=30000
PLAYLIST_RENDER_CONCURRENCY=1
PLAYLIST_RENDER_RESOLUTION=1920x1080
PLAYLIST_RENDER_FPS=30
PLAYLIST_RENDER_MODE=append          # append | exclusive
PLAYLIST_RENDER_SHORT_VIDEO=natural  # natural | loop
PLAYLIST_RENDER_SCRATCH_DIR=/tmp/cms-worker/renders
# FFMPEG_PATH / FFPROBE_PATH optional overrides (defaults: ffmpeg-static)
```

## 7. Edge cases & risks

| Case | Handling |
|---|---|
| Playlist JSON missing in S3 (CMS upload failed) | Fall back to building input from DB; log a warning |
| `media.cdnUrl` unusable (private bucket) | Always download by `s3Key` via SDK; prefer media-sync's local copy |
| Playlist edited mid-render | Hash re-checked after render; if changed, immediately re-queue (last write wins) |
| Item media `PROCESSING`/`FAILED` | Skip item, note in log; hash includes `m.updated_at` so it re-renders when READY |
| Empty playlist / all items skipped | Mark failed with clear error, remove any previous MP4? No — keep last good render, log |
| Huge playlists (hour-long output) | Segment cache + stream-copy concat keeps re-render cost ∝ changed items; disk guard reuses `MEDIA_MAX_DISK_USAGE_PERCENT` |
| Worker crash mid-render | Scratch dir cleaned on startup; `rendering` rows older than a timeout reset to `pending` |
| Playlist deleted in CMS | Poll diff → remove MP4 + config entry + tracking row |
| BigInt `sizeBytes` as string in JSON | zod `coerce` in the schema |

## 8. Build order (phases)

1. **Scaffold + detection** — module/processor/config wiring, tracking table,
   fingerprint poll, logs which playlists *would* render. Verify by editing a playlist
   in the CMS and watching it get detected.
2. **Fetch + resolve** — S3 JSON fetch w/ zod validation, DB fallback, media
   resolution (local-first, S3 fallback). Verify all inputs land in scratch.
3. **Render** — ffmpeg segment pipeline + concat + ffprobe validation, for
   image-only, video-only, then mixed playlists.
4. **Install + lifecycle** — atomic move into the player, `config.json` update,
   re-render replacement, deletion cleanup, dead-lettering, crash recovery.
5. **Hardening** — segment cache, disk guard, `exclusive` mode, README + `.env.example`.

Out of scope for v1 (future): honoring `calendars` time windows (that's the
`scheduler` role's job — it can point the player at different rendered MP4s per
window), per-device playlists, transitions/crossfades between items, GPU encoding.

# Scheduler Worker Scalability Plan

Step-wise plan to evolve the current scheduler worker from an MVP polling worker into a horizontally scalable scheduling system for 5 to 10 million users/devices.

## 0. Implementation Status

Last reviewed: 2026-07-21.

This section reflects the current state across:

- `/Users/nikhil/Desktop/rubenious-cms`
- `/Users/nikhil/Desktop/cms-worker`
- `/Users/nikhil/Desktop/player`

### Done

```text
✅ CMS schedule write path
├─ ✅ POST /api/schedules
│  ├─ ✅ writes schedule to PostgreSQL
│  ├─ ✅ emits schedule.updated to Redpanda
│  └─ ✅ enqueues scheduler.evaluate.now to RabbitMQ
└─ ✅ PUT /api/schedules/{id}
   ├─ ✅ updates schedule in PostgreSQL
   ├─ ✅ emits schedule.updated to Redpanda
   └─ ✅ enqueues scheduler.evaluate.now to RabbitMQ
```

CMS changes completed:

- ✅ Added `kafkajs`.
- ✅ Added `amqplib`.
- ✅ Added CMS Redpanda producer helper: `/Users/nikhil/Desktop/rubenious-cms/lib/redpanda.ts`.
- ✅ Added CMS RabbitMQ publisher helper: `/Users/nikhil/Desktop/rubenious-cms/lib/rabbitmq.ts`.
- ✅ Added Redpanda env values in CMS `.env`.
- ✅ Added RabbitMQ env values in CMS `.env`.
- ✅ Added `export const runtime = "nodejs"` to schedule routes so Kafka/RabbitMQ clients run in the Node runtime.

Local infrastructure completed:

```text
✅ Redpanda
├─ ✅ topic: schedule.updated
├─ ✅ partitions: 3
└─ ✅ host broker: localhost:29092

✅ RabbitMQ
├─ ✅ queue: scheduler.evaluate.now
├─ ✅ durable: true
└─ ✅ host broker: amqp://guest:guest@localhost:5672
```

Redpanda Docker listener fix completed in `/Users/nikhil/Desktop/cms-worker/docker-compose.yaml`:

```text
✅ internal listener: redpanda:9092
✅ external listener: localhost:29092
```

Player capabilities already present:

```text
✅ Player
├─ ✅ manifest pull mode
│  ├─ ✅ reads manifestUrl from config/env
│  ├─ ✅ polls every syncIntervalMs
│  ├─ ✅ downloads manifest media
│  ├─ ✅ selects active schedule locally
│  └─ ✅ writes selected playlist to config.json
├─ ✅ LAN API
│  ├─ ✅ POST /api/media/:folder/:fileName
│  ├─ ✅ POST /api/playlist/add
│  ├─ ✅ POST /api/playlist/replace
│  └─ ✅ POST /api/playlist/remove
└─ ✅ renderer playback
   ├─ ✅ reads config.json on startup
   └─ ✅ re-reads every refreshIntervalMs
```

Verification completed:

- ✅ CMS type-check passes with `npx tsc --noEmit --incremental false`.
- ✅ Redpanda broker connectivity from CMS works after the advertised-listener fix.
- ✅ RabbitMQ queue declaration from CMS works.
- ✅ Worker build passes with `npm run build`.
- ✅ Worker RabbitMQ consumer is registered on `scheduler.evaluate.now`.
- ✅ Redpanda topic `scheduler.evaluation.completed` exists.

Worker scheduler path completed:

```text
✅ Scheduler-worker path
├─ ✅ consume scheduler.evaluate.now from RabbitMQ
├─ ✅ parse job payload
├─ ✅ acquire Redis lock per schedule/device/site key
├─ ✅ read latest schedule state from PostgreSQL
├─ ✅ evaluate active playlist
├─ ✅ publish manifest or call Player API
├─ ✅ acknowledge RabbitMQ job after successful processing
└─ ✅ emit scheduler.evaluation.completed to Redpanda
```

Backup tick safety completed:

```text
✅ 60s backup tick remains enabled as reconciliation
├─ ✅ uses the same manifest hash shape as realtime jobs
├─ ✅ compares manifest hash before publishing
├─ ✅ uses Redis manifest revision/hash cache
├─ ✅ publishes only when content changed
├─ ✅ sends WebSocket notification only after a new manifest revision
└─ ✅ logs/events include source=realtime_job or source=backup_tick
```

### Left

The current implementation now has the core event/job loop, retry/DLQ handling, Redis state caching, and Redpanda result events. Player push/apply is still incomplete.

Remaining Redis work:

```text
⚠️ Redis
├─ ✅ add distributed locks
├─ ✅ add idempotency keys
├─ ✅ cache active schedule state
├─ ✅ cache manifest hash/revision
└─ ✅ cache player update revision
```

Remaining RabbitMQ work:

```text
⚠️ RabbitMQ
├─ ✅ implement scheduler consumer in cms-worker
├─ ✅ add retry queue
├─ ✅ add dead-letter queue
├─ ✅ add prefetch/concurrency limits
├─ ✅ add message acknowledgement rules
└─ ✅ add queue lag metrics
```

Remaining Redpanda work:

```text
⚠️ Redpanda
├─ ✅ emit scheduler.evaluation.completed
├─ ✅ emit player.manifest.published
├─ ✅ emit player.update.failed
├─ ✅ add event schema/versioning
└─ ✅ add optional debug/analytics consumer
```

Remaining player work for sub-1-second latency:

```text
⚠️ Player low-latency gap
├─ ⚠️ LAN playlist API currently writes config.json
├─ ✅ renderer can now receive immediate playlist.updated IPC
│  └─ current config: 15000ms
├─ ✅ manifest.updated WebSocket push fetches manifest immediately
│  └─ current config: 30000ms
└─ ✅ main process notifies renderer immediately
```

The WebSocket + immediate apply path is now implemented:

```text
✅ WebSocket manifest push
├─ ✅ scheduler/control plane sends manifest.updated
├─ ✅ player fetches manifest only if revision changed
├─ ✅ Electron main applies playlist immediately
└─ ✅ renderer reloads without waiting 15s

⚠️ Polling fallback
├─ ✅ manifest polling exists
├─ ✅ config polling exists
└─ ❌ not enough for sub-1-second latency
```

Remaining CMS work:

- ❌ Add an outbox table if schedule writes and event/job publishing must be transactionally reliable.
- ❌ Add request tracing IDs to the Redpanda event and RabbitMQ job.
- ❌ Add UI/admin visibility for publish/enqueue failures.

### Current Reality

The architecture has moved from:

```text
CMS writes PostgreSQL only
```

to:

```text
CMS writes PostgreSQL
├─ ✅ emits schedule.updated to Redpanda
└─ ✅ enqueues scheduler.evaluate.now to RabbitMQ
```

But the full realtime system is not complete until:

```text
RabbitMQ job
└─ ✅ scheduler worker consumes it
   └─ ❌ player receives/applies the update quickly
```

## 1. Current State

The current scheduler is simple and useful for MVP scale:

```text
Scheduler worker
├─ starts with WORKER_ROLE=scheduler
├─ wakes every 60 seconds
├─ queries PostgreSQL for active calendars
├─ checks playlist render output
└─ updates player config or publishes a manifest to S3
```

Current limits:

```text
Scaling problems
├─ every replica runs the same minute tick
├─ every replica can query the same calendar rows
├─ every replica can write the same manifest/config
├─ no distributed locking
├─ no queue ownership
├─ no device partitioning
├─ no backpressure
└─ no durable event stream for replay/debugging
```

This is acceptable for one worker or a small number of schedules, but it is not enough for millions of users/devices.

## 2. Target Architecture

Use each infrastructure component for one clear responsibility:

```text
PostgreSQL = source of truth
Redis      = cache, locks, fast state, rate limits
RabbitMQ   = job queue for work distribution and retries
Redpanda   = durable event stream and audit/replay log
S3/CDN      = manifest and media delivery
Workers    = stateless compute that can scale horizontally
```

Target flow:

```text
CMS / API
├─ writes schedule data to PostgreSQL
├─ publishes command jobs to RabbitMQ
└─ emits domain events to Redpanda

Scheduler workers
├─ consume jobs from RabbitMQ
├─ acquire Redis locks per device/site/tenant
├─ read final truth from PostgreSQL
├─ write manifests to S3/CDN
├─ update Redis cache with current active schedule
└─ emit result events to Redpanda

Players
├─ pull manifests from CDN/S3
├─ report heartbeats/events
└─ optionally consume near-real-time config notifications later
```

## 3. Scale Assumptions

For 5 to 10 million users/devices, do not design around one global scheduler tick.

Plan around:

```text
High-scale requirements
├─ millions of schedules
├─ millions of devices
├─ high fan-out when a shared playlist changes
├─ uneven tenant sizes
├─ timezone-specific schedule windows
├─ retries without duplicate side effects
├─ burst handling
├─ auditability
└─ regional deployment
```

The main goal is to avoid this pattern:

```text
Bad pattern
└─ every minute, scan everything, decide everything, write everything
```

Move toward this pattern:

```text
Good pattern
└─ only evaluate affected devices/schedules at the time they need evaluation
```

## 4. Step 1 - Make Current Polling Safe

Add Redis distributed locking around the scheduler tick.

```text
Scheduler tick
├─ try Redis lock: scheduler:global:tick
├─ if lock acquired
│  ├─ run current DB query
│  ├─ publish/apply playlist
│  └─ release/expire lock
└─ if lock not acquired
   └─ skip this tick
```

Implementation notes:

- Use `SET key value NX PX <ttl>` for the lock.
- Use a random lock token so a worker only releases its own lock.
- Set TTL slightly longer than worst-case tick time.
- Add metrics for lock acquired, skipped, expired, and tick duration.

This allows multiple replicas, but only one active scheduler tick.

This step does not make the system 10M-ready. It only prevents duplicate work while moving to the next steps.

## 5. Step 2 - Partition Work By Device, Site, Or Tenant

Stop treating the scheduler as one global process.

Choose a partition key:

```text
Partition options
├─ device_id
│  └─ best when each device can have a unique schedule
├─ site_id
│  └─ best when many devices share one location schedule
└─ tenant_id
   └─ best for early scaling, but large tenants can become hot partitions
```

Recommended:

```text
Primary partition = device_id or site_id
Secondary grouping = tenant_id
```

Add worker ownership:

```text
Worker replica
├─ consumes jobs for many partitions
├─ locks one partition at a time in Redis
└─ processes only that partition's schedules
```

Redis lock examples:

```text
schedule:lock:device:{deviceId}
schedule:lock:site:{siteId}
schedule:lock:tenant:{tenantId}
```

## 6. Step 3 - Introduce RabbitMQ For Work Distribution

Use RabbitMQ for executable work.

Queues:

```text
RabbitMQ
├─ scheduler.evaluate.now
│  └─ evaluate one device/site immediately
├─ scheduler.evaluate.due
│  └─ evaluate a device/site when a time window boundary is reached
├─ scheduler.manifest.publish
│  └─ publish one manifest
├─ scheduler.retry
│  └─ retry transient failures
└─ scheduler.dead_letter
   └─ store permanently failed jobs for investigation
```

Example job:

```json
{
  "jobId": "uuid",
  "type": "scheduler.evaluate",
  "tenantId": "tenant_123",
  "siteId": "site_456",
  "deviceId": "device_789",
  "reason": "schedule.updated",
  "requestedAt": "2026-07-21T10:00:00.000Z",
  "idempotencyKey": "schedule-evaluate:device_789:revision_42"
}
```

Worker flow:

```text
Scheduler worker
├─ consumes RabbitMQ job
├─ checks idempotency key in Redis/PostgreSQL
├─ acquires Redis partition lock
├─ reads current schedule from PostgreSQL
├─ computes active playlist
├─ publishes manifest if changed
├─ stores result
├─ acknowledges job
└─ emits event to Redpanda
```

RabbitMQ gives:

- Horizontal worker scaling.
- Backpressure when schedule changes spike.
- Retries with delay.
- Dead-letter queues.
- One job processed by one consumer.

## 7. Step 4 - Use Redpanda For Events And Replay

Use Redpanda for facts that happened, not direct work commands.

Topics:

```text
Redpanda topics
├─ schedule.created
├─ schedule.updated
├─ schedule.deleted
├─ schedule.window.opened
├─ schedule.window.closed
├─ playlist.render.completed
├─ scheduler.evaluation.completed
├─ player.manifest.published
├─ player.heartbeat.received
└─ player.offline.detected
```

Event example:

```json
{
  "eventId": "uuid",
  "eventType": "scheduler.evaluation.completed",
  "tenantId": "tenant_123",
  "siteId": "site_456",
  "deviceId": "device_789",
  "activeScheduleId": "schedule_111",
  "activePlaylistId": "playlist_222",
  "manifestRevision": "2026-07-21T10:00:00.000Z",
  "occurredAt": "2026-07-21T10:00:00.000Z"
}
```

Redpanda gives:

- Durable history.
- Replay for rebuilding projections/cache.
- Analytics input.
- Debugging and audit trails.
- Decoupled consumers.

## 8. Step 5 - Replace Global Polling With Due-Time Scheduling

Instead of scanning every schedule every minute, calculate the next time a schedule must be evaluated.

When a schedule is created or updated:

```text
Schedule write
├─ save to PostgreSQL
├─ calculate next boundary
│  ├─ start time
│  ├─ end time
│  ├─ next matching day
│  └─ timezone-aware boundary
├─ store next_evaluate_at
└─ enqueue delayed/due job
```

Evaluation flow:

```text
At next_evaluate_at
├─ RabbitMQ delivers scheduler.evaluate.due
├─ worker evaluates only affected partition
├─ manifest changes only if active playlist changed
└─ worker schedules the next evaluation boundary
```

This changes scheduler cost from:

```text
O(all schedules every minute)
```

to:

```text
O(schedules that changed or reached a boundary)
```

## 9. Step 6 - Add Idempotency Everywhere

At 10M scale, duplicate delivery will happen. Design for it.

Idempotency keys:

```text
schedule evaluation
└─ evaluate:{deviceId}:{scheduleRevision}:{timeBucket}

manifest publish
└─ manifest:{deviceId}:{activePlaylistId}:{scheduleRevision}

render completion handling
└─ render-completed:{playlistId}:{renderRevision}
```

Store processed keys in Redis for short-term dedupe and PostgreSQL for important durable operations.

Rules:

- Re-running the same job should produce the same result.
- Publishing the same manifest revision twice should be harmless.
- A failed job should be retryable.
- A late job should check current PostgreSQL state before writing anything.

## 10. Step 7 - Build Manifest Versioning

Do not overwrite blindly without knowing whether content changed.

Manifest model:

```text
manifest
├─ deviceId/siteId
├─ activeScheduleId
├─ activePlaylistId
├─ scheduleRevision
├─ playlistRenderRevision
├─ manifestRevision
├─ contentHash
└─ publishedAt
```

Flow:

```text
Worker computes desired manifest
├─ hash desired manifest payload
├─ compare with last hash in Redis/PostgreSQL
├─ if hash unchanged
│  └─ skip S3 write
└─ if hash changed
   ├─ write manifest to S3
   ├─ update current manifest pointer
   └─ emit player.manifest.published
```

This reduces write amplification during large schedule scans or retries.

## 11. Step 8 - Add Read Models And Caches

PostgreSQL remains the source of truth, but workers should not repeatedly compute the same active schedule from raw tables.

Useful projections:

```text
Read models
├─ device_schedule_assignment
│  └─ device -> schedule group
├─ schedule_next_boundary
│  └─ schedule -> next evaluation time
├─ active_schedule_cache
│  └─ device/site -> current schedule + expiry
└─ manifest_state
   └─ device/site -> last published manifest hash/revision
```

Redis cache:

```text
Redis
├─ active:device:{deviceId}
├─ active:site:{siteId}
├─ manifest-hash:device:{deviceId}
├─ heartbeat:device:{deviceId}
└─ lock:scheduler:{partitionId}
```

Keep cache entries rebuildable from PostgreSQL and Redpanda.

## 12. Step 9 - Scale PostgreSQL Access

At millions of users, PostgreSQL must be protected from fan-out reads.

Database changes:

- Index `calendars(status, start_time, end_time)`.
- Index `calendars(tenant_id, status)`.
- Index schedule assignment tables by `device_id`, `site_id`, and `tenant_id`.
- Store `next_evaluate_at` and index it.
- Use read replicas for scheduler reads if acceptable.
- Avoid `NOW()` scans over large unpartitioned calendar tables.
- Partition large tables by tenant, region, or time where needed.

Recommended query shape:

```text
Good query
└─ get schedules for one device/site/tenant partition

Avoid
└─ find active calendar across the entire database every minute
```

## 13. Step 10 - Regionalize The System

For 5 to 10 million users, use regional deployment.

```text
Global platform
├─ region: ap-south-1
│  ├─ scheduler workers
│  ├─ Redis
│  ├─ RabbitMQ
│  ├─ Redpanda brokers
│  └─ regional S3/CDN manifests
├─ region: us-east-1
│  └─ same stack
└─ region: eu-west-1
   └─ same stack
```

Rules:

- Route devices to their nearest/home region.
- Keep schedule evaluation close to the device region.
- Keep manifests in regional buckets/CDN paths.
- Use tenant/device region as part of partitioning.

## 14. Step 11 - Add Observability

Required metrics:

```text
Scheduler metrics
├─ jobs consumed per second
├─ job lag
├─ queue depth
├─ evaluation duration
├─ DB query duration
├─ Redis lock failures
├─ duplicate job count
├─ manifest publish duration
├─ manifest skipped because hash unchanged
├─ S3 publish failures
├─ active schedule changes per minute
└─ dead-letter count
```

Required logs:

- `tenantId`
- `siteId`
- `deviceId`
- `scheduleId`
- `playlistId`
- `jobId`
- `idempotencyKey`
- `manifestRevision`

Required alerts:

- RabbitMQ queue lag too high.
- Dead-letter queue growing.
- Redis lock error rate high.
- PostgreSQL query latency high.
- Manifest publish failures.
- Device heartbeat/offline spikes.

## 15. Step 12 - Load Test In Phases

Do not jump directly to 10 million.

```text
Load test phases
├─ 10k devices
├─ 100k devices
├─ 500k devices
├─ 1M devices
├─ 5M devices
└─ 10M devices
```

Test scenarios:

- Normal schedule boundary changes.
- One tenant updates a playlist used by many devices.
- Many tenants update schedules at once.
- RabbitMQ outage and recovery.
- Redis outage and recovery.
- S3 slow writes.
- Redpanda replay.
- PostgreSQL read replica lag.
- Worker rolling deployment.

Success criteria:

- Schedule activation within target SLA.
- No duplicate harmful writes.
- Queue lag drains after bursts.
- PostgreSQL stays below safe CPU/IO limits.
- Dead-letter rate remains low.
- System recovers cleanly after dependency failures.

## 16. Step 13 - Reduce Player Update Latency To 1-2 Seconds

Current observed latency is around 20 to 40 seconds because multiple polling loops are stacked together.

```text
Current latency path
├─ CMS content/schedule changes
├─ worker waits for poll
│  ├─ media sync poll: 30s
│  ├─ playlist render poll: 30s
│  └─ scheduler tick: 60s
├─ worker writes player config or manifest
└─ player waits for config refresh
   └─ config.json refresh: 15s
```

Worst-case latency can become:

```text
worker poll delay + render/sync time + player refresh delay
```

For a 1 to 2 second target, polling must be removed from the hot path.

Target low-latency flow:

```text
CMS change
├─ write PostgreSQL
├─ immediately enqueue RabbitMQ job
├─ scheduler/media worker consumes job within milliseconds
├─ worker reads latest PostgreSQL state
├─ worker updates manifest or calls Player API
├─ player receives push/update immediately
└─ playback reloads the changed playlist within 1-2 seconds
```

### 16.1 Use Player API As The Fast Path

The existing `PlayerConfigService` already supports a remote player API through `PLAYER_API_URL`.

Use this for production:

```text
Fast player update path
├─ worker calls /api/playlist/add
├─ worker calls /api/playlist/replace
├─ worker calls /api/playlist/remove
└─ player applies change immediately in memory
```

Keep `config.json` polling as fallback only:

```text
Fallback path
└─ local config.json write + player refresh interval
```

Required player changes:

- Apply playlist API updates immediately without waiting for the next config poll.
- Return success only after the in-memory playlist is updated.
- Optionally persist the latest config to disk after updating memory.
- Add `revision` to reject stale updates.
- Add a websocket/SSE channel if workers need to notify browser/player clients instantly.

### 16.2 Replace Polling With Events

Do not wait 30 seconds for workers to discover changes.

```text
CMS write path
├─ save content/schedule to PostgreSQL
├─ publish Redpanda event
│  └─ schedule.updated / playlist.updated / media.ready
└─ enqueue RabbitMQ command
   └─ scheduler.evaluate.now / media.sync.now / playlist.render.now
```

Expected timing:

```text
CMS commit                         0ms
RabbitMQ job published             10-50ms
worker receives job                10-200ms
DB read + decision                 20-200ms
Player API call / manifest write   50-800ms
player applies update              50-300ms
```

Target total:

```text
normal case: 300ms - 1500ms
safe target: 1s - 2s
```

### 16.3 Separate Fast Schedule Switching From Heavy Rendering

Playlist rendering with ffmpeg cannot always fit inside 1 to 2 seconds. Separate the fast control plane from heavy media processing.

```text
Fast path
├─ switch between already-rendered playlists
├─ publish/call player with existing MP4 URL/src
└─ target: 1-2 seconds

Slow path
├─ render a newly edited playlist
├─ upload MP4 to S3
├─ emit playlist.render.completed
└─ then trigger fast schedule/player update
```

Important rule:

```text
1-2 second latency is realistic only when the target media/render already exists.
```

For newly uploaded large files or newly rendered videos, the total time includes download, transcode, upload, and CDN availability.

### 16.4 Use RabbitMQ Priority And Dedicated Queues

Create separate queues so urgent player updates are not blocked behind heavy work.

```text
RabbitMQ queues by latency
├─ player.update.realtime
│  ├─ priority: highest
│  └─ target: < 1s queue lag
├─ scheduler.evaluate.now
│  ├─ priority: high
│  └─ target: < 1s queue lag
├─ media.sync.now
│  ├─ priority: medium
│  └─ target: seconds to minutes depending on file size
└─ playlist.render.now
   ├─ priority: lower
   └─ target: depends on ffmpeg duration
```

Worker pools:

```text
Worker deployment
├─ realtime-player-update workers
│  └─ small, fast, high replica count
├─ scheduler workers
│  └─ CPU-light, DB/Redis/RabbitMQ focused
├─ media-sync workers
│  └─ network/disk heavy
└─ playlist-render workers
   └─ CPU/GPU heavy, isolated from realtime queues
```

### 16.5 Use Redis For Fast State And Dedupe

Redis should keep the current active state so most realtime jobs do not perform expensive recomputation.

```text
Redis low-latency keys
├─ active:device:{deviceId}
├─ active:site:{siteId}
├─ manifest-hash:device:{deviceId}
├─ player-revision:device:{deviceId}
├─ lock:player-update:{deviceId}
└─ idempotency:{jobId}
```

Realtime update flow:

```text
Player update job
├─ acquire lock:player-update:{deviceId}
├─ check current revision in Redis
├─ skip if job is stale
├─ call Player API
├─ update Redis revision/state
└─ acknowledge job
```

### 16.6 Use CDN/S3 Manifest Only For Pull Mode

Manifest pull mode is scalable, but not always 1-2 seconds unless the player polls very frequently or gets a push notification.

For 1-2 seconds:

```text
Recommended
├─ publish manifest to S3/CDN
├─ send player a push notification with new revision
└─ player immediately fetches the new manifest
```

Avoid relying on this alone:

```text
Slow pull-only path
└─ player checks manifest every 15-60 seconds
```

Player-side options:

- WebSocket from player to control plane.
- Server-sent events.
- MQTT for device fleets.
- Short-poll only as fallback.

### 16.7 Latency Rollout Plan

```text
Latency Phase 1: Quick win
├─ set PLAYER_API_URL in worker
├─ make player apply API playlist updates immediately
├─ reduce config polling to fallback only
└─ target: remove 15s player refresh delay

Latency Phase 2: Event-triggered workers
├─ enqueue RabbitMQ job on CMS write
├─ keep DB polling only as reconciliation fallback
├─ add player.update.realtime queue
└─ target: remove 30s worker poll delay

Latency Phase 3: Push player notification
├─ add WebSocket/SSE/MQTT player channel
├─ push manifest revision or playlist update
├─ player fetches/applies immediately
└─ target: 1-2 seconds for already-rendered content

Latency Phase 4: Full realtime control plane
├─ Redis active-state cache
├─ idempotent player revisions
├─ dedicated realtime worker pool
├─ regional queues
└─ target: consistent 1-2 seconds at high scale
```

### 16.8 Latency Success Metrics

Track end-to-end latency with timestamps.

```text
Latency timestamps
├─ cms_saved_at
├─ rabbitmq_published_at
├─ worker_started_at
├─ player_update_sent_at
├─ player_applied_at
└─ playback_changed_at
```

Required SLO:

```text
Already-rendered content/schedule switch
├─ p50: < 500ms
├─ p95: < 2s
└─ p99: < 5s

Newly-rendered content
├─ measured separately
└─ depends on media duration, file size, ffmpeg speed, and upload time
```

## 17. Target Sub-Second Player Update Architecture

Use this architecture for less than 1 second updates when the target media/render already exists.

```text
                 Next.js CMS
                      │
               PostgreSQL
                      │
                RabbitMQ
                      │
             Scheduler Worker
                      │
            Update manifest in S3
                      │
          Notify via WebSocket
                      │
        ─────────────────────────
       │            │            │
    Player A     Player B     Player C
       │            │            │
 Fetch manifest if revision changed
       │
 Reload renderer
```

### 17.1 Target Flow

```text
Schedule changed in CMS
├─ CMS writes schedule to PostgreSQL
├─ CMS enqueues scheduler.evaluate.now to RabbitMQ
├─ scheduler worker consumes the job
├─ scheduler computes active playlist
├─ scheduler compares manifest hash in Redis
├─ scheduler writes new manifest to S3 only if changed
├─ scheduler stores manifest revision/hash in Redis
├─ scheduler sends WebSocket notification to target players
│  ├─ deviceId
│  ├─ manifestUrl
│  ├─ manifestRevision
│  └─ contentHash
└─ player receives notification
   ├─ compares revision/hash with local cache
   ├─ fetches manifest only if revision changed
   ├─ downloads missing media only if needed
   ├─ applies playlist in memory
   └─ reloads renderer immediately
```

### 17.2 Latency Budget

```text
CMS DB write                         20-100ms
RabbitMQ publish                     5-30ms
RabbitMQ delivery to scheduler       5-50ms
Scheduler DB read + evaluation       20-150ms
Redis hash/revision check            1-10ms
S3 manifest write                    50-300ms
WebSocket notify                     5-50ms
Player manifest fetch                30-200ms
Renderer in-memory apply             5-50ms
```

Target:

```text
p50: 300-600ms
p95: < 1000ms
p99: < 2000ms
```

Important condition:

```text
Sub-second update is realistic only when media is already rendered, uploaded, and CDN-accessible.
```

### 17.3 Components To Implement

```text
Scheduler Worker
├─ ✅ consume scheduler.evaluate.now
├─ ✅ use Redis locks/idempotency
├─ ✅ publish manifest only when hash changed
├─ ✅ cache manifest revision/hash
├─ ✅ send WebSocket notification after manifest publish
└─ ✅ target affected device connection by deviceId

WebSocket Gateway
├─ ✅ accept persistent player connections
├─ ✅ authenticate player by device token
├─ ✅ keep deviceId -> socket connection map
├─ ✅ support fan-out by site/group/tenant
├─ ✅ publish notification from scheduler to players
├─ ✅ track connected/disconnected devices
└─ ✅ expose basic connected-player metrics

Player
├─ ✅ connect to WebSocket gateway on startup
├─ ✅ authenticate with deviceId/device token
├─ ✅ receive manifest.updated notification
├─ ✅ compare manifestRevision/contentHash
├─ ✅ fetch manifest immediately if changed
├─ ✅ apply playlist in memory
├─ ✅ notify renderer immediately
└─ ✅ keep polling as fallback
```

### 17.4 WebSocket Message Contract

Notification sent from scheduler/control plane to players:

```json
{
  "schemaVersion": 1,
  "type": "manifest.updated",
  "eventId": "uuid",
  "deviceId": "SL-PLAYER-001",
  "manifestUrl": "https://cdn.example.com/manifests/SL-PLAYER-001.json",
  "manifestRevision": "2026-07-21T10:30:00.000Z",
  "contentHash": "sha256...",
  "publishedAt": "2026-07-21T10:30:00.000Z"
}
```

Player acknowledgement:

```json
{
  "schemaVersion": 1,
  "type": "manifest.applied",
  "eventId": "uuid",
  "deviceId": "SL-PLAYER-001",
  "manifestRevision": "2026-07-21T10:30:00.000Z",
  "contentHash": "sha256...",
  "appliedAt": "2026-07-21T10:30:00.420Z"
}
```

Failure acknowledgement:

```json
{
  "schemaVersion": 1,
  "type": "manifest.apply_failed",
  "eventId": "uuid",
  "deviceId": "SL-PLAYER-001",
  "manifestRevision": "2026-07-21T10:30:00.000Z",
  "error": "Download failed with HTTP 403",
  "failedAt": "2026-07-21T10:30:00.900Z"
}
```

### 17.5 Step-Wise Implementation Plan

Step 1: Add WebSocket gateway service.

```text
WebSocket Gateway
├─ create standalone gateway or add to CMS API
├─ endpoint: /ws/player
├─ authenticate using device token
├─ register connection by deviceId
├─ heartbeat ping/pong every 20-30s
└─ expose sendToDevice(deviceId, payload)
```

Step 2: Add scheduler notification publisher.

```text
Scheduler Worker
├─ after manifest publish succeeds
├─ send manifest.updated to WebSocket gateway
├─ include manifestRevision and contentHash
├─ if player is offline, skip push
└─ player will catch up via fallback polling
```

Step 3: Add player WebSocket client.

```text
Player main process
├─ connect to WebSocket gateway
├─ send device auth message
├─ listen for manifest.updated
├─ ignore stale revisions
├─ fetch manifest immediately
├─ download missing media
├─ write manifest-cache.json / sync-state.json
├─ apply playlist immediately
└─ notify renderer via Electron IPC
```

Step 4: Make renderer apply playlist without polling.

```text
Electron main process
├─ sends playlist.updated IPC event
└─ renderer receives event
   ├─ updates in-memory playlist
   ├─ restarts current playback if changed
   └─ does not wait for refreshIntervalMs
```

Step 5: Keep polling as fallback.

```text
Fallback mode
├─ manifest sync polling remains enabled
├─ config.json refresh remains fallback only
├─ poll intervals can be relaxed
└─ disconnected players eventually catch up
```

### 17.6 Required New Env

Scheduler worker:

```env
PLAYER_NOTIFY_ENABLED=true
PLAYER_NOTIFY_GATEWAY_URL=http://localhost:3001
PLAYER_NOTIFY_TIMEOUT_MS=1000
```

WebSocket gateway:

```env
PLAYER_WS_PORT=3001
PLAYER_WS_PATH=/ws/player
PLAYER_WS_TOKEN_SECRET=change-me
```

Player:

```env
PLAYER_DEVICE_ID=SL-PLAYER-001
PLAYER_DEVICE_TOKEN=change-me
PLAYER_WS_URL=ws://localhost:3001/ws/player
PLAYER_MANIFEST_URL=https://d1zue4w6hf1jx0.cloudfront.net/manifests/SL-PLAYER-001.json
```

### 17.7 Metrics

Track these timestamps:

```text
cms_saved_at
rabbitmq_published_at
scheduler_job_started_at
manifest_published_at
websocket_notified_at
player_notification_received_at
manifest_fetch_started_at
manifest_fetch_completed_at
renderer_reloaded_at
```

Required metrics:

```text
WebSocket
├─ connected players
├─ notify success count
├─ notify failure count
├─ notify latency p50/p95/p99
└─ offline device count

Player
├─ notification receive latency
├─ manifest fetch latency
├─ manifest skipped because hash unchanged
├─ renderer reload latency
└─ apply failures
```

### 17.8 Failure Behavior

```text
WebSocket notify fails
├─ log player.notify.failed
├─ emit Redpanda event
└─ rely on player manifest polling fallback

Manifest fetch fails on player
├─ keep current playlist
├─ send manifest.apply_failed ack
└─ retry on next push or fallback poll

Player offline
├─ scheduler still publishes manifest
├─ no push delivered
└─ player fetches latest manifest after reconnect/startup
```

## 18. Capacity Calculator And Bottleneck Model

This calculator estimates how many players/devices the architecture can handle and where it will break first.

The terms below use `devices` because the player is the scaling unit. If one business user manages many displays, user count can be much higher than device count without increasing WebSocket load.

### 18.1 Inputs

```text
D  = connected devices / players
U  = schedule updates per second from CMS
F  = average fan-out devices per schedule update
M  = average manifest size in KB
P  = player fallback manifest poll interval in seconds
W  = WebSocket connections per gateway instance
R  = scheduler jobs processed per worker per second
S  = S3/CDN manifest fetch requests per second
```

Recommended starting assumptions:

```text
M = 20 KB manifest
P = 300s fallback poll after WebSocket is implemented
W = 25,000 to 50,000 connected players per gateway instance
R = 50 to 200 scheduler jobs/sec per worker
```

### 18.2 Core Formulas

RabbitMQ job rate:

```text
scheduler_jobs_per_second = U
```

WebSocket notification rate:

```text
websocket_notifications_per_second = U × F
```

Fallback manifest fetch rate:

```text
fallback_manifest_fetch_rps = D / P
```

Push-triggered manifest fetch rate:

```text
push_manifest_fetch_rps = U × F
```

Total manifest fetch rate:

```text
S = fallback_manifest_fetch_rps + push_manifest_fetch_rps
```

WebSocket gateway instances:

```text
gateway_instances = ceil(D / W)
```

Scheduler worker instances:

```text
scheduler_workers = ceil(U / R)
```

Approx manifest bandwidth:

```text
manifest_bandwidth_MBps = (S × M) / 1024
```

### 18.3 Example Capacity Table

Assumptions:

```text
P = 300s
W = 40,000 connections per gateway
R = 100 jobs/sec per scheduler worker
M = 20 KB
```

```text
Devices       Gateway instances    Fallback fetch RPS    Manifest bandwidth
10,000        1                    34                    0.7 MB/s
100,000       3                    334                   6.5 MB/s
1,000,000     25                   3,334                 65 MB/s
5,000,000     125                  16,667                326 MB/s
10,000,000    250                  33,334                651 MB/s
```

Important reading:

```text
With WebSocket push, fallback polling can be slow, e.g. 300s.
Without WebSocket push, a 1s poll interval at 10M devices would create 10M requests/sec, which is not acceptable.
```

### 18.4 Burst Calculator

If one schedule update affects many devices:

```text
U = 1 update/sec
F = 50,000 devices affected
push_manifest_fetch_rps = 50,000 RPS
```

If ten large tenants update at the same time:

```text
U = 10 updates/sec
F = 50,000 devices affected
push_manifest_fetch_rps = 500,000 RPS
```

That burst is too high for origin/S3 directly. It requires:

```text
Burst protection
├─ CDN in front of manifest
├─ per-device jitter before manifest fetch
├─ group-level manifests where possible
├─ rate-limited fan-out
└─ regional WebSocket gateways
```

Recommended player jitter:

```text
small update: fetch immediately
large fan-out: random delay 0-2000ms
emergency update: no jitter
```

### 18.5 Current System Capacity

Current implemented state:

```text
✅ CMS -> RabbitMQ job
✅ scheduler consumes job
✅ Redis lock/idempotency/cache
✅ manifest hash dedupe
✅ S3 manifest publish
❌ WebSocket notify
❌ player immediate apply
```

Current practical capacity:

```text
Small deployment
├─ 1 scheduler worker
├─ 1 RabbitMQ
├─ 1 Redis
├─ 1 Redpanda
└─ likely OK for thousands to low tens of thousands of devices
```

Main reason:

```text
The control plane can process jobs, but players still rely on 15s/30s polling.
Low latency does not scale until WebSocket push exists.
```

### 18.6 Target System Capacity

Target after WebSocket gateway + player immediate apply:

```text
100k devices
├─ 3 WebSocket gateway instances
├─ 2-3 scheduler workers
├─ RabbitMQ single cluster
├─ Redis single primary/replica or managed cache
└─ CDN-backed manifests

1M devices
├─ 25-40 WebSocket gateway instances
├─ 5-20 scheduler workers
├─ RabbitMQ cluster or partitioned queues
├─ Redis cluster/managed cache
├─ Redpanda 3+ brokers
└─ CDN mandatory

10M devices
├─ 250+ WebSocket gateway instances globally
├─ regional scheduler fleets
├─ partitioned RabbitMQ or multiple regional queues
├─ Redis cluster per region
├─ Redpanda regional clusters
├─ CDN mandatory
└─ group/site manifests to reduce fan-out
```

### 18.7 Main Issues And Bottlenecks

```text
Issue 1: Player polling
├─ current 15s config refresh and 30s manifest sync
└─ blocks sub-1-second latency

Issue 2: Fan-out bursts
├─ one schedule can affect thousands/millions of players
└─ must use WebSocket fan-out plus CDN/jitter

Issue 3: Per-device manifests
├─ simple but expensive at 10M devices
└─ use site/group manifests when many devices share schedules

Issue 4: S3 origin pressure
├─ many players fetching manifest at once can hit origin
└─ put CDN in front and cache by revision

Issue 5: RabbitMQ partitioning
├─ one queue can become hot
└─ partition by region/site/tenant at high scale

Issue 6: Redis hot keys
├─ very large tenants can hammer one tenant/site key
└─ use device/site partition keys and regional Redis

Issue 7: WebSocket connection state
├─ 10M connected players cannot sit on one gateway
└─ shard by region/deviceId and keep connection registry in Redis
```

### 18.8 Simple Decision Calculator

Use this before promising scale:

```text
If D <= 10k
├─ one region is fine
├─ one WebSocket gateway may be enough
└─ current RabbitMQ/Redis can work for pilot scale

If D <= 100k
├─ add 3+ WebSocket gateways
├─ use CDN manifests
├─ keep RabbitMQ prefetch/concurrency tuned
└─ add dashboard for queue lag and connected players

If D <= 1M
├─ split by region
├─ use multiple scheduler replicas
├─ shard WebSocket gateways
├─ use Redis cluster/managed cache
└─ use Redpanda/RabbitMQ clusters

If D > 1M
├─ regionalize everything
├─ avoid per-device fan-out where possible
├─ use group/site manifests
├─ add jitter for manifest fetches
└─ capacity test every dependency separately
```

### 18.9 What It Can Handle Today Vs After Next Step

```text
Today
├─ job pipeline: good for MVP/pilot
├─ update latency: still 15-30s because player polls
├─ likely device range: thousands to low tens of thousands
└─ blocker: no WebSocket push / immediate renderer apply

After WebSocket gateway + player immediate apply
├─ update latency: p95 under 1s for already-rendered content
├─ likely device range: 100k+ with horizontal gateways
├─ 1M possible with regional/sharded gateways and CDN
└─ 10M requires regional architecture and fan-out controls
```

## 19. Recommended Rollout Plan

```text
Phase 1: Safe MVP scaling
├─ add Redis lock around current tick
├─ add manifest hash dedupe
├─ add scheduler metrics
└─ run 2-3 replicas safely

Phase 2: Queue-based scheduling
├─ add RabbitMQ
├─ create scheduler.evaluate jobs
├─ process per device/site partition
├─ add retries and dead-letter queue
├─ add realtime player update queue
└─ keep polling only as a reconciliation fallback

Phase 3: Event-driven platform
├─ add Redpanda domain events
├─ emit schedule and manifest events
├─ build replayable read models
└─ add analytics/offline detection consumers

Phase 4: Due-time scheduling
├─ add next_evaluate_at
├─ enqueue boundary jobs
├─ remove global schedule scans
└─ evaluate only changed/due partitions

Phase 5: Multi-region scale
├─ partition devices by region
├─ deploy regional worker fleets
├─ use regional queues/caches/streams
└─ publish regional manifests through CDN
```

## 20. Final Target Flow

```text
Schedule changed
├─ CMS writes PostgreSQL
├─ CMS emits schedule.updated to Redpanda
├─ CMS enqueues scheduler.evaluate.now to RabbitMQ
└─ scheduler worker consumes job
   ├─ acquires Redis lock for device/site
   ├─ reads latest PostgreSQL state
   ├─ computes active schedule
   ├─ compares manifest hash
   ├─ publishes manifest or calls Player API only if changed
   ├─ stores active state in Redis
   ├─ schedules next boundary job
   ├─ acknowledges RabbitMQ job
   └─ emits scheduler.evaluation.completed to Redpanda
```

This architecture lets the scheduler scale by adding more workers, while RabbitMQ distributes executable work, Redis prevents duplicate writes, PostgreSQL stays the source of truth, and Redpanda keeps a durable event history for replay, analytics, and debugging.

# Scheduler Worker Scalability Plan

Step-wise plan to evolve the current scheduler worker from an MVP polling worker into a horizontally scalable scheduling system for 5 to 10 million users/devices.

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

## 17. Recommended Rollout Plan

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

## 18. Final Target Flow

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

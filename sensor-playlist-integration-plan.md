# Sensor-triggered playlist implementation plan

## Phase-wise delivery plan

The phases below are implementation order, not calendar estimates. Each phase has a testable exit gate. The first usable release is Phase 7; later transport types and remote-trigger actions are separate follow-up work.

| Phase | Main owner/repository | Deliverable | Exit gate |
| --- | --- | --- | --- |
| 0. Lock behavior and contract | All three | One written event/flow/manifest contract | Hardware, first transport, trigger action, multi-zone scope, cooldown and resume rules are agreed; sample JSON fixtures are reviewed |
| 1. Persist flow | CMS platform | Additive Prisma migration and transactional flow storage | Existing playlists still load; media item IDs remain stable on edit; nodes/edges survive save and reload |
| 2. Expose and validate APIs | CMS platform | Tenant-scoped playlist flow and device binding APIs | Invalid graphs, cross-tenant references, unsupported transports, and missing bindings fail with actionable errors |
| 3. Wire the editor | CMS platform | Controlled flow canvas, binding selection, save/dirty/publish states | Create, edit, reload, simulate, and publish show the same graph; no UI-only sensor data remains |
| 4. Publish v4 manifests | CMS worker | Device-specific binding publication and versioned flow | Flow-only edits change playlist revision; binding-only edits update device manifest; v3 devices keep sequential playback |
| 5. Build player runtime | Media player | One sensor adapter, local event evaluator, override/resume engine | Synthetic triggers work offline and obey cooldown, schedule boundaries, restart, and media failure rules |
| 6. Add observability and hardening | All three | Health, event outcomes, proof-of-play, rollback | Operators can identify unbound sensors and failed adapters; last good playlist survives bad config and failed publish |
| 7. Pilot and release | All three + target hardware | Feature-gated end-to-end rollout | Actual hardware triggers target content, resumes correctly, and repeats while disconnected; old players remain unaffected |

### Phase 0 — behavior and protocol freeze

- Choose the target player model/OS and **one** adapter (for example GPIO or MQTT). Record pin/topic format, units, sample rate, authentication, and supported player version. Disable the other transport options until implemented.
- Resolve the open decisions at the end of this document. Use this plan's default of temporary one-clip override only if product owners accept it. Decide zone-scoped versus full-screen interruption explicitly.
- Write versioned TypeScript/JSON fixtures for: empty flow, one sensor-to-media connection, matching and nonmatching events, device binding, invalid flow, and a v4 playlist/device manifest. Define maximum event latency and what happens without network access.
- **Gate:** CMS, worker, and player can consume the same fixtures without interpreting any field differently. No migration or runtime work starts with unresolved trigger semantics.

### Phase 1 — database foundation

- Add node/edge and device-binding tables, constraints, and indexes described below. Preserve `PlaylistItem.id` across updates; stop delete-and-recreate behavior for ordinary edits. Add a flow revision or reliably touch `Playlist.updatedAt` in the flow transaction.
- Write a migration/backfill path for existing playlists with no graph. Ensure deletes of a playlist or item cannot leave dangling edges. Keep the existing sequential schema and public behavior intact.
- **Gate:** migration up/down strategy is documented; API-level integration tests show stable IDs, cascade behavior, and existing playlist round-trip.

### Phase 2 — CMS API and publishing validation

- Add flow to playlist detail/create/update DTOs. Add device-binding endpoints and a player capability/readiness check. Validate graph shape, same-playlist IDs, tenant ownership, transport support, condition type/range, edge cardinality, and per-device bindings.
- Save media and flow in one transaction. Publish from a committed revision, and report per-device readiness. Include a clear status for missing bindings and unsupported player versions. S3 upload and queue failures must be retryable and visible.
- **Gate:** API contract tests cover create/edit/reorder/delete, invalid conditions, cross-tenant access, missing binding, and a flow-only edit that requests a new publish.

### Phase 3 — finish the playlist UI

- Move sensor nodes, positions, and wires from `FlowWorkspace` local state into `use-playlist-editor`. Map loaded API data to stable canvas IDs. Include flow in dirty tracking, save, discard, and publish. Keep simulation explicit and local to the editor.
- Add typed condition controls and device-binding feedback; replace generic `Port`/`Expected value` with fields for the selected adapter. Restrict connections to supported sensor-to-media edges and surface validation beside the affected node/edge.
- **Gate:** a user can add sensor → connect media → configure condition → save → reload → edit → publish without losing graph data. Preview and publish warnings match API validation.

### Phase 4 — worker and manifest delivery

- Extend scheduler queries to load flow and the target device's binding. Publish v4 playlist flow and a device-specific binding reference/config without secrets. Add flow to playlist content hashes and binding revision to device manifest hashes. Keep v3 manifest generation for players without v4 capability.
- Ensure trigger media is included in asset readiness and caching, even when it is not in the ordinary sequential loop. Publish assets/playlist revision first, then the device pointer; retain the previous pointer on failure.
- **Gate:** fixture tests prove flow-only and binding-only changes propagate, manifests contain no credentials, and older players still receive playable sequential content.

### Phase 5 — player behavior

- Add manifest v4 validation and one real adapter in Electron main. Normalize events, apply condition/debounce/cooldown/idempotency, and send a constrained IPC trigger to the renderer. Atomically swap adapters and graph with a new manifest.
- Add a playback override state machine in `app.js`; save the scheduled clip's state, play cached target content, then resume. Define handling for concurrent events, schedule changes, new manifests, target failure, and reboot. Keep event evaluation and playback local for offline operation.
- **Gate:** automated state-machine tests and an adapter simulator cover matching, bouncing, duplicate, stale, and concurrent events; a 24-hour local soak has no stuck override or lost scheduled loop.

### Phase 6 — operational checks

- Report sensor capability, binding status, adapter connectivity, last event, rejected event reason, active override, and flow revision. Add proof-of-play/event audit with bounded retention and no secret leakage.
- Add feature flag and version checks in CMS publishing, safe fallback to last good manifest, and a rollback path to sequential playback. Keep the sensor worker focused on asynchronous audit/analytics unless remote actions are separately specified.
- **Gate:** an operator can distinguish missing hardware, bad binding, unmatched condition, failed media, and stale player version from status/logs; rollback restores the normal loop.

### Phase 7 — pilot and staged release

- Upgrade a small test set of players first, then enable worker v4 publishing, then CMS publish, then the UI feature flag. Run a physical test with the selected sensor, including network loss and power cycle. Roll out by device group only after the pilot passes.
- **Gate:** create and publish a playlist with a sensor connection; target device downloads both normal and trigger media; real event plays the target within the agreed latency; scheduled playback resumes; offline event still works; v3 devices continue their previous playlist.

## What the current code actually does

- The playlist editor's `FlowWorkspace` draws media and sensor cards, wires, a connection inspector (name, connection type, port, expected value), and event markers. It labels itself a UI preview. Sensor cards, positions, and wires live only in component state. Save/publish in `use-playlist-editor.ts` serializes only media items and layout. Switching editor views does not persist the flow, and remounting loses it.
- `Playlist` and `PlaylistItem` in Prisma have no flow or sensor fields. The playlist API saves media items to PostgreSQL and `playlists/{id}.json` in S3, then optionally queues publishing. There is a separate Sensor Rules UI; it is currently demo state, not a persisted engine.
- The CMS worker's sensor service is a skeleton. Its scheduler builds versioned playlist manifests (`schemaVersion: 3`) with canvas, zones, and sequential media items. The playlist version is currently derived from content passed to `playlistVersionFor`; flow changes must enter that fingerprint.
- The Electron player resolves versioned manifests, downloads media, selects the active schedule, and passes a sequential playlist to `app.js`. Neither main process nor renderer has a sensor listener or branch/override playback state.

## Product contract to settle before coding

For the first release, treat a sensor card as a **local event source** and a sensor-to-media wire as **play this media clip immediately on a matching event, then resume the scheduled playlist at its interrupted position**. A sensor is configuration, never a `PlaylistItem` or fake HTML media. Keep the normal timeline as the fallback loop. Permit only sensor-to-media edges in the first release; the UI currently allows media-to-media wires, but their meaning is undefined. Disable those connections with an explanation until branching behavior is specified. One sensor may target several clips only if a priority/selection rule is defined; initially require exactly one target per sensor. Keep scheduled playlist selection authoritative: a schedule change cancels an active override and loads the new schedule. A trigger received when this playlist is inactive is ignored.

Define the event contract as `{eventId, sensorId, source, value, occurredAt}`. For numeric values, define an operator and unit; for strings/booleans, equality only. The existing free-text `Expected value` is insufficient for light/temperature thresholds. Specify source-specific address fields instead of one ambiguous `Port`: GPIO pin, serial device/baud/framing, MQTT topic/broker profile, HTTP local endpoint, or UDP bind port. **Do not enable all five transports at once.** Pilot one transport supported by the target player hardware; gate the others in the UI until implemented and tested. Define cooldown, debounce, override duration (normally target clip duration), repeat behavior, queue policy (initially ignore while override active), timeout, and priority. Never store broker credentials in a public manifest.

## Schema and migration (CMS)

1. Add `PlaylistFlowNode` (`id`, `playlistId`, `kind=SENSOR|MEDIA`, `playlistItemId?`, `name`, `x`, `y`, `createdAt`, `updatedAt`) and `PlaylistFlowEdge` (`id`, `playlistId`, `sourceNodeId`, `targetNodeId`, `conditionJson`, `cooldownMs`, `priority`, timestamps). Use stable IDs; media nodes reference **PlaylistItem.id**, not `Media.id`, because the same asset can occur more than once. Add indexes/uniques for playlist membership and node/edge lookup. Enforce same-playlist references in the API transaction (database constraints where practical).
2. Store a sensor's transport configuration in a typed `configJson` on the sensor node, validated at the API boundary. Keep device-specific binding separate: `DeviceSensorBinding` (`deviceId`, stable `sensorId`, transport/address, enabled, updatedAt) or a reusable device profile. This prevents a playlist from baking one physical GPIO pin into every assigned device. The UI can display a logical sensor name and select a device binding; publish must fail clearly for assigned devices without one.
3. Add `flowRevision` or use playlist `updatedAt` as a change marker. Update it in the same transaction as node/edge edits. Add an optional event/audit table later for diagnostics (`eventId` unique per device, observed value, matched edge, result, timestamp); do not put high-volume raw events in playlist tables.
4. Migration is additive: existing playlists have empty flow and retain sequential playback. Backfill stable media-node references only if needed by the editor. Never infer sensor nodes from zero-duration items. On media-item deletion/reorder, remove or reject dangling flow edges transactionally.

## CMS API and editor

1. Extend `GET /api/playlist/:id` and create/update payloads with `flow: {nodes, edges}`; keep the list endpoint summary light. Use one transaction to save media items and flow, preserving item IDs across edits. Current update replaces items, so change that before adding foreign-key links. Define an explicit DTO and schema validation with limits on node count, coordinate range, condition operators/value types, durations, and transport-specific fields. Reject unknown node kinds, missing references, cycles/unsupported edge directions, cross-tenant media, and bindings from other tenants.
2. Make `FlowWorkspace` controlled by `use-playlist-editor`: load, edit, dirty tracking, save, undo, and publish validation all use the same flow state. Give sensor nodes their own type. Persist positions only for editor layout; runtime uses IDs and conditions. Show which devices lack bindings and which transports are unsupported. Separate **simulate event in editor** from an actual device trigger and show the expected playback/resume result.
3. Expose a tenant-scoped device-sensor binding API and capability read endpoint. Use existing playlist permissions for flow edits and device permissions for device bindings. A device-ingest endpoint is only needed for telemetry/remote events; if added, authenticate with device token, rate limit, validate tenant/device ownership, and make event IDs idempotent.
4. Publish should create an immutable, validated revision. Return readiness/errors for flow, bound devices, and media rather than reporting success after only saving the database row. Ensure the S3 CMS JSON and the worker both read the same committed revision. A failed upload or queue step must be retryable without a misleading published state.

## Worker and manifest

1. Extend scheduler DB reads to include flow nodes/edges and binding information for the **specific device**. Add `flow` to the versioned playlist manifest or a device-specific flow reference. Because bindings may differ per device, prefer a reusable playlist flow with logical sensor IDs plus a device-manifest binding section. Use a new manifest schema version (4) and retain v3 output for players without sensor capability. Do not expose transport secrets in public S3 objects; distribute credentials via a protected device channel or provision locally.
2. Include flow and relevant binding revision in content hashes and publish triggers. The current scheduler playlist version hashes items; a flow-only edit would otherwise leave the version unchanged. Binding changes must republish the affected device manifest even if media is unchanged. Publish media assets before referencing the new flow revision; retain the last good manifest on failure.
3. The sensor worker's current `handleEvent` is a no-op. For local playback, use it for optional authenticated event ingest, audit, monitoring, and alerting, **not as the real-time playback dependency**. If remote-trigger delivery is required later, define ordered, authenticated device commands with acknowledgements and offline semantics as a separate phase. Avoid duplicating condition evaluation between worker and player.

## Player

1. In `electron/main.cjs`, validate schema v4 flow and capability, resolve logical sensor IDs to device bindings, start only supported adapters, and stop/restart them atomically when a new manifest is activated. Keep hardware/network listeners in the Electron main process, not the renderer. For each adapter, bound resource use, error recovery, reconnect, and clean shutdown are required. Reject unsafe bind addresses and untrusted executable content.
2. Normalize incoming events, reject stale/duplicate events, apply typed condition + debounce/cooldown, and send a narrow `sensor.triggered` IPC command to `app.js`. Do not use the player LAN playlist API as the internal trigger path. Log event ID, matching edge, manifest revision, and result without logging secrets.
3. Add a renderer override state machine: `scheduled loop -> sensor clip -> scheduled loop`. Preserve the interrupted item and remaining time, pause its timers/media, play cached target media for the configured duration, then resume. Handle trigger during override, target media failure, schedule boundary, manifest replacement, player restart, and offline mode deterministically. On missing target or invalid flow, continue the existing playlist. Emit proof-of-play for the trigger and resume.
4. Cache trigger target assets as part of manifest activation before accepting events. Keep the last good manifest and bindings across restarts. Report capability/health (adapter connected, last event, rejected flow) through the existing status path.

## Rollout and acceptance gates

1. **Contract gate:** agree on target hardware and first transport, event operators/units, override/resume behavior, binding ownership, and multi-zone behavior. For multi-zone playback, decide whether the override replaces only the target clip's zone (recommended) or the whole canvas; encode it explicitly.
2. **CMS gate:** migration and API tests for create/load/edit/reorder/delete, tenant isolation, invalid graph, binding mismatch, and flow-only publish. Existing playlists must round-trip unchanged.
3. **Worker gate:** fixture tests showing v3 unchanged, v4 flow publication, new version on flow-only edit, per-device binding update, and no publication of secrets. Verify failed publish keeps old revision available.
4. **Player gate:** adapter and state-machine tests with synthetic events: match/no match, duplicate, bounce, cooldown, two simultaneous events, missing media, offline reboot, schedule boundary, and manifest replacement. Run an end-to-end test on actual target hardware: create playlist and binding, publish, sync, trigger, observe target playback, resume, then disconnect network and trigger again.
5. Roll out behind `sensor_triggered_content` plus an explicit player capability check. Upgrade player first, then worker manifest support, then CMS publish, then expose editor controls. Old players continue with sequential playback; unsupported flow must never silently appear operational.

## Key open decisions

- Which device hardware and **first** connection type are in scope? The current UI lists GPIO, Serial, MQTT, HTTP, and UDP, while worker event types and Sensor Rules UI use different vocabularies.
- Does a trigger play one clip, start a subplaylist, or branch to a later position? This plan assumes one temporary clip override.
- For multiple zones, does the trigger interrupt one zone or the entire screen?
- Should sensor bindings be configured per device, per device group, or through a reusable hardware profile?
- What are the maximum trigger latency and offline requirements? This plan assumes local detection and playback for offline operation.

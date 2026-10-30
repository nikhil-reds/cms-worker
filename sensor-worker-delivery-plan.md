# Worker plan: deliver saved playlist sensors to the player

## Current contract and gaps

The CMS in `REDSXP-Digital-signage-platform` now saves GPIO sensor nodes and edges in `playlist_flow_nodes` and `playlist_flow_edges`. `serializeFlow` returns `flow: { sensors, connections }`; connections target a stable `PlaylistItem.id`. A sensor has `id`, `name`, `connectionType: "gpio"`, `port` (2–27), `operator: "equals"`, boolean `expectedValue`, `enabled`, `x`, and `y`. A connection has `id`, source sensor ID, target item ID, `cooldownMs`, `debounceMs`, and `enabled`. The CMS render-manifest endpoint already includes this flow. Its create/update routes currently return HTTP 422 `publishState: "unsupported"` when publishing a sensor playlist.

The worker scheduler reads `playlist_items` only and publishes schema v3 playlist and device manifests. `playlistVersionFor` hashes that item-only content, so a sensor-only edit cannot change the playlist version. The separate playlist-render poll currently excludes playlists with SENSOR nodes; keep that deliberate exclusion while the scheduler becomes the sensor publishing path. The sensor worker skeleton is not needed for local GPIO triggering.

## Target wire contract

Publish a versioned **playlist manifest v4** for a capable player. Keep existing canvas, zones, and `items`, and add `sensorTriggers` with the saved sensor name, position, enabled states, and runtime fields. The player may ignore editor coordinates. Use the persisted sensor and edge IDs, and target the exact `PlaylistItem.id` already present in `items`.

```json
{
  "schemaVersion": 4,
  "playlistId": "playlist-1",
  "playlistVersion": "content-hash",
  "items": [{ "id": "item-1", "type": "video", "src": "...", "url": "..." }],
  "sensorTriggers": [{
    "id": "edge-1",
    "sensorId": "sensor-1",
    "transport": "gpio",
    "port": "17",
    "operator": "equals",
    "value": true,
    "targetPlaylistItemId": "item-1",
    "cooldownMs": 2000,
    "debounceMs": 100,
    "enabled": true
  }]
}
```

Agree with the player repository on this JSON shape and its v4 activation rules before implementation. The player must cache all `items` before enabling listeners, ignore triggers for inactive playlists, play the target video once, and resume normal playback. If a trigger target is not in `items`, publication must fail for that playlist rather than emit a broken rule. GPIO port values are currently playlist-wide; per-device bindings are a later schema/API requirement if devices use different pins.

## Implementation sequence

1. **Read and type the persisted flow.** Extend `SchedulerDbService.getPlaylistPlaybackManifest` and its type with a second query for nodes and edges belonging to the same playlist. Join edge source to SENSOR node and edge target to MEDIA node, then target node to `playlist_items`. Select IDs, transport, port, operator, boolean JSON value, enabled flags, cooldown, debounce, and target item ID. Keep a strict same-playlist check in SQL and reject malformed rows. Return an empty trigger array for ordinary playlists. Prefer the database as the scheduler's source of truth; the CMS render-manifest endpoint is a useful contract fixture, not a new network dependency.

2. **Validate publish readiness.** Accept only `gpio`, ports 2–27, `equals`, boolean values, one enabled edge per sensor, and video targets present among the READY playback items. Check cooldown/debounce bounds against the CMS parser. Decide explicitly whether a disabled sensor or edge is omitted or included with `enabled: false`; apply one rule consistently. Fail with playlist/sensor/edge IDs in logs, never silently drop an invalid enabled rule. Ensure the playlist has at least one playable normal item.

3. **Extend manifest types and versioning.** Add a typed v4 playlist manifest in `manifest-publisher.service.ts`. Include ordered, normalized triggers in `playlistVersionFor` input alongside canvas, zones, and items. Sort rules by stable ID so query order cannot create false revisions. A port, value, target, enabled, cooldown, or debounce edit must produce a new playlist version and consequently a new device-manifest content hash. Keep `serverNow` and generated timestamps out of content hashes.

4. **Publish in dependency order.** In `SchedulerService.publishScheduleManifestForDevice`, build and upload the versioned playlist first, then publish the device pointer and notify through the existing WebSocket path. The existing item mapping already supplies target media URLs; validate that the selected target is READY and downloadable. If upload or validation fails, leave the previously published device pointer intact and let the scheduler queue retry. Do not overwrite a previously published immutable playlist key with different bytes.

5. **Handle player compatibility.** Add an explicit persisted or reported player capability/version lookup before sending v4. For sensor-free playlists, retain v3 output. For sensor playlists, publish v4 only to supported devices; record an actionable unsupported-device failure for other assigned devices. Do not claim a successful sensor publish when a device receives only the ordinary v3 timeline. If the product requires a v3 fallback for older devices, make that a visible partial publish state in CMS.

6. **Cover every scheduler entry path.** The schedule publishing path uses `getPlaylistPlaybackManifest`; the direct `publishOrApplyPlaylist` path still creates v3 from an item array. Keep direct mode sensor-free unless a flow-aware input is added. Check that CMS publish jobs enqueue `scheduler.evaluate.now` for a flow-only edit, and that backup evaluation finds the changed flow even without a playlist-render completion job. The render poll exclusion must not suppress scheduler publication.

7. **Complete the cross-repository handoff.** After worker and player v4 support are deployed, remove the CMS create/update `publishState: "unsupported"` gate and call the scheduler publish path. Keep API validation and player capability checks. Verify the CMS UI reports per-device failures instead of treating database save as completed publication.

## Verification gates

- Fixture from the current CMS `serializeFlow` shape maps to the intended rule with the same sensor ID, edge ID, GPIO port, boolean value, and exact target item ID.
- Ordinary playlist emits the same playable v3 content; a sensor playlist emits v4 with both normal items and rules.
- Changing only port, expected value, target, enabled state, cooldown, or debounce changes the playlist version and device pointer revision. Reordering database rows without semantic changes does not.
- Missing target, non-video target, unavailable media, wrong playlist membership, unsupported transport, or unsupported player fails visibly without replacing the previous device pointer.
- A device with a capable player downloads the target media, activates the GPIO rule, plays the connected video on a matching event, resumes, and repeats offline. Nonmatching events do nothing.

## Immediate dependencies

The worker can implement database reads, validation, v4 serialization, hashing, and tests now. Before enabling publication, the player must accept the agreed v4 contract and report capability; the CMS publish gate must then be removed. Confirm whether GPIO pins are identical across all devices assigned a playlist. If not, add per-device bindings in the CMS schema/API and resolve them in the device manifest before release.

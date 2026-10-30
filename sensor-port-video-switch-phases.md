# Sensor port → video switch: phase-wise implementation plan

## Confirmed end-to-end goal

An operator adds a sensor in the playlist editor, connects it to a video card, fills in the sensor's connection type, port, and trigger value, and saves. The CMS stores that configuration in PostgreSQL. Publishing makes the CMS worker include it in the configuration sent to each assigned player. The player listens to the configured port locally. When an event on that port matches the saved trigger, the player switches to the connected video.

```text
Playlist editor → CMS API → PostgreSQL → publish job → worker → versioned player config
                                                               ↓
Sensor hardware → player port listener → condition match → connected video plays
```

The existing [integration plan](sensor-playlist-integration-plan.md) contains broader architecture notes. This file is the delivery sequence for the specific port-to-video goal. It does not assume that the sensor worker processes real-time triggers: the player must react locally, including when offline.

## Phase 0 — freeze the exact playback and port contract

**Decide and document:** first supported sensor transport and target hardware/OS; how a port is named (GPIO pin, serial device, MQTT topic, etc.); event value type; equality/threshold operator; trigger debounce/cooldown; and what happens to the normal playlist after the connected video ends. Recommended first behavior: one sensor connects to one video; a matching event immediately plays that video once, then the normal playlist resumes. A new schedule takes priority over a sensor video. Ignore repeated triggers while that video is playing. If the product wants the sensor video to become permanent, change this contract before implementing the player state machine.

**Output:** sample saved flow JSON, sample player config JSON, and event examples for match, nonmatch, and repeat. The UI's GPIO, Serial, MQTT, HTTP, and UDP choices should be narrowed to the first transport actually supported by the player; the other choices remain disabled until their adapters exist.

**Exit gate:** CMS, worker, and player agree on the same fields and trigger/resume behavior.

## Phase 1 — database schema in REDSXP-Digital-signage-platform

Add persisted flow records linked to a playlist:

| Record | Essential fields |
| --- | --- |
| Sensor node | stable ID, playlist ID, display name, connection type, port/address, expected value, operator, enabled, canvas position |
| Media node | stable ID, playlist ID, **PlaylistItem ID**, canvas position |
| Connection | stable ID, playlist ID, sensor node ID, target media node ID, cooldown/debounce, enabled |

Use `PlaylistItem.id` for the target so two copies of the same media asset can be distinguished. Keep sensor configuration separate from `PlaylistItem`; it has no playback duration or media ID. If the same playlist is assigned to devices with different physical port names, add a per-device port binding table and publish the resolved binding for each device. If all assigned players use identical ports, the sensor node's port may be enough for the first release, but validate that deployment assumption.

Update playlist edit logic to preserve item IDs. The current replace-items approach would break connections to media nodes. Add foreign keys/indexes and a migration that leaves existing playlists with an empty flow.

**Exit gate:** save/reload and edit/reorder preserve the sensor-to-video link; deleting the target video cannot leave a dangling connection; existing playlists still play normally.

## Phase 2 — CMS API and validation

Extend playlist create, detail, and update APIs to accept/return `flow: { sensors, mediaNodes, connections }` in the same transaction as playlist items. Validate tenant ownership, unique IDs, known connection type, legal port format/range, typed expected value/operator, one target video per sensor for the first release, and target item belonging to this playlist. Reject unsupported video formats or media not ready for playback at publish time.

When publishing, return actionable errors such as “GPIO pin 17 is unavailable on screen X” or “Target video is not ready.” A save may succeed as a draft while publish fails validation. Use a revision/hash that changes on sensor setting or connection changes, even when media items are unchanged.

**Exit gate:** API tests cover create, load, update, delete, tenant isolation, invalid port, invalid value, missing target video, and a sensor-only change triggering publication.

## Phase 3 — finish the playlist editor

Move `FlowWorkspace`'s sensors, wires, and positions out of its local React state into `use-playlist-editor`. Load them from the API and include them in save, dirty tracking, and publish. Replace the current free-form sensor details with controls for the supported transport: port/address, typed match condition, and optional cooldown. Show connection and publish validation beside the relevant sensor. Restrict the first release to sensor → video connections; media → media wires currently have no defined runtime behavior.

Keep “Simulate trigger” as a preview only. It should show the video that would play, without claiming that actual hardware fired. Show an assigned player's capability/port mismatch before publish.

**Exit gate:** add sensor → choose port/value → connect video → save → close/reopen → publish retains all settings exactly. A changed sensor port or target video appears in the next published revision.

## Phase 4 — worker builds player configuration in cms-worker

Extend the existing scheduler/manifest publisher to read the saved flow. For each assigned device, produce a versioned playlist config containing the normal timeline plus sensor rules similar to:

```json
{
  "schemaVersion": 4,
  "playlistId": "playlist-id",
  "items": ["existing playable items"],
  "sensorTriggers": [
    {
      "id": "connection-id",
      "transport": "gpio",
      "port": "17",
      "operator": "equals",
      "value": true,
      "targetPlaylistItemId": "playlist-item-id",
      "cooldownMs": 2000
    }
  ]
}
```

The example port and values are illustrative, not a hardware choice. Resolve per-device bindings before publishing if needed. Include the target video's playable media URL, version, and hash through the existing media manifest path; the player must cache it before activating a trigger. Include sensor configuration in playlist versioning and device-manifest revision calculation. Publish the complete new playlist config before changing the device manifest pointer. Do not put MQTT credentials or other secrets in a public manifest.

**Exit gate:** a flow-only or port-only edit reaches the correct player; target video is downloadable; failed publication leaves the prior working config active; old players receive or safely ignore sensor-free v3 content.

## Phase 5 — local sensor listener and video switching in Signage-Media-Player

In Electron main process, validate schema v4 and start a listener for each configured port using the chosen transport adapter. Normalize events as `{port, value, timestamp}`; match only enabled rules for the active playlist and current revision. Apply type-safe comparison, debounce, cooldown, and duplicate suppression. Send a narrow internal IPC trigger containing the target `PlaylistItem.id` to the renderer. Stop old listeners and start new ones atomically when config changes; close them on shutdown.

In `app.js`, add explicit playback states: normal playlist, sensor video, and return to normal playlist. On a matching trigger, pause the current item, play the cached target video once, then resume the interrupted playlist position. On missing/corrupt target video, listener failure, config mismatch, or invalid event, keep normal playback running. A schedule change cancels the sensor video and activates the new scheduled playlist. Keep the last valid config available across offline restarts.

**Exit gate:** a simulated event on the configured port switches to the selected video; a different port/value does nothing; repeat events respect cooldown; the normal playlist resumes; offline triggers work.

## Phase 6 — diagnostics and real-hardware test

Expose player status for loaded flow revision, active ports/listeners, last trigger, match/reject reason, and current playback state. Record proof-of-play for the triggered video. Add a simple operator view for missing binding, unsupported player version, or disconnected sensor. Keep secrets out of logs.

Test on the intended device with a real sensor: publish the playlist, verify the player receives the config and caches the video, trigger the configured port, observe the exact video, observe normal playback resume, then repeat with the network disconnected and after a power cycle. Also verify a nonmatching port/value and a changed port after republish.

**Exit gate:** the complete physical flow passes repeatedly and can be diagnosed from player/CMS status without inspecting the database manually.

## Phase 7 — staged rollout

Upgrade players to support v4 first, deploy worker publication second, enable CMS save/publish third, and expose the editor feature last. Gate it by player capability and the existing sensor feature flag. Start with one screen and one sensor, then a small device group. Keep a rollback switch that publishes the previous sensor-free config while normal playlists remain playable.

**Exit gate:** the pilot works on every chosen device; existing playlists and older players continue sequential playback; rollback has been exercised once.

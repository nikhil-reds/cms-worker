# Step-by-step plan: optional sensors in playlist creation

## Goal

An operator can create a normal playlist or choose **Add sensor** while creating/editing a playlist. For a sensor playlist, they enter connection type, port, trigger condition/value, and connect the sensor to one video. Save writes media items and the sensor graph to PostgreSQL. Publish validates the graph so the worker can send it to the player. A playlist without sensors follows the existing behavior.

The schema work in `REDSXP-Digital-signage-platform/prisma/schema.prisma` introduced `PlaylistFlowNode` and `PlaylistFlowEdge`; this plan is for the API and frontend work that uses them. The current `FlowWorkspace` already shows an Add sensor button, but its nodes and wires are local React state and are not included in `use-playlist-editor.ts`'s save payload.

## Step 1 — define one request/response contract

Use the same `flow` shape in `POST /api/playlist`, `PUT /api/playlist/{id}`, and `GET /api/playlist/{id}`. Empty `sensors`/`connections` means a normal playlist. Do not send a sensor as a fake media item.

```json
{
  "name": "Lobby playlist",
  "items": [
    { "clientId": "video-card-1", "mediaId": "media-id", "position": 0, "durationSec": 15 }
  ],
  "flow": {
    "sensors": [
      {
        "clientId": "sensor-card-1",
        "name": "Door sensor",
        "connectionType": "gpio",
        "port": "17",
        "operator": "equals",
        "expectedValue": true,
        "enabled": true,
        "x": 100,
        "y": 80
      }
    ],
    "connections": [
      {
        "clientId": "wire-1",
        "sourceSensorClientId": "sensor-card-1",
        "targetItemClientId": "video-card-1",
        "cooldownMs": 2000,
        "debounceMs": 100,
        "enabled": true
      }
    ]
  }
}
```

For updates, accept stable database IDs for existing items/nodes/edges and client IDs for new ones. The API resolves client IDs to inserted `PlaylistItem.id` values inside one transaction, then returns the persisted IDs. Reject an update that references an ID from another playlist or tenant. Keep `flow` optional for backward compatibility on create; define update semantics explicitly: omitted `flow` preserves existing flow, while `flow: {sensors: [], connections: []}` clears it.

## Step 2 — add shared server validation

Create a shared playlist payload parser/validator used by both route handlers. Validate:

- playlist name and item count; every media ID belongs to the authenticated tenant and is playable;
- sensor name, supported connection type, port format/range for that connection type, operator/value type, finite canvas coordinates, and sane cooldown/debounce bounds;
- unique client IDs and stable IDs, one outgoing connection per sensor for the first release, source kind `SENSOR`, target kind `MEDIA`, and target media item belonging to this playlist;
- no duplicate sensor/port rule that would cause ambiguous target selection on the same player;
- assigned player capability and device-specific port binding at **publish**, if physical ports vary by device.

Return `400` with field-level errors for malformed payloads, `404` for inaccessible IDs, and `409` for stale revision conflicts. Never trust `tenantId` from the browser; use the authenticated session. Save can allow an unfinished sensor draft if the UI marks it incomplete, but publish must reject it with a clear reason. Prefer a single explicit `draft`/`publish` validation mode over silently dropping invalid sensors.

## Step 3 — implement `POST /api/playlist`

In `app/api/playlist/route.ts`, parse and validate the payload before writing. In one Prisma transaction: create `Playlist`, create media `PlaylistItem` rows, map each item's `clientId` to its database ID, create sensor and media `PlaylistFlowNode` rows, then create `PlaylistFlowEdge` rows. Return the full detail including IDs and flow. For a playlist without `flow`, create no flow rows.

Only after transaction commit, generate the S3 playlist JSON / enqueue publish from the committed database snapshot. If S3 or queueing fails, return a distinct publish state and preserve a retry path; do not report a successful publish merely because the database save succeeded.

**Check:** normal playlist creation remains unchanged; sensor playlist creation persists exact port/condition/target; malformed graph creates nothing.

## Step 4 — implement `GET /api/playlist/{id}`

Include ordered media items plus flow nodes and edges. Serialize `expectedValue` without coercing booleans/numbers to strings. Resolve each media flow node to its `PlaylistItem.id`. Keep `GET /api/playlist` lightweight with optional `sensorCount` / `hasSensors` summary, rather than returning every graph for the list page.

**Check:** creating then reloading returns the same sensor name, connection type, port, expected value, target video, and canvas positions.

## Step 5 — implement `PUT /api/playlist/{id}` safely

The current playlist update path needs stable `PlaylistItem.id` values before flow edges can target them. Update existing items by ID, create new items, and delete removed items in a transaction. In that same transaction, upsert/edit/delete sensor/media nodes and edges; reject or remove edges whose target item is deleted. Touch playlist revision/`updatedAt` even for a sensor-only edit. Use optimistic concurrency (`If-Match` or `updatedAt`/revision) so an older editor tab cannot silently overwrite a newer graph.

**Check:** changing port, trigger value, target video, positions, or item order survives reload; editing one playlist cannot alter another; deleting a video does not leave a dangling edge.

## Step 6 — make Add sensor an explicit option in the editor

In `create-playlist/page.tsx`, provide a clear **Add sensor** action in the playlist creation UI. Show normal media timeline by default; opening the flow workspace and adding a sensor is optional. Existing playlists with sensors should open with their flow visible. Keep the existing Add sensor affordance in `FlowWorkspace`, but move `sensors`, `wires`, and `positions` into `use-playlist-editor.ts` (or a reducer it owns). Include them in `SavePlaylistPayload`, dirty tracking, load, save, discard, and publish.

Replace the generic inspector input with transport-aware fields. For the first supported transport, show the exact port selector/validation and value type. Only allow sensor → video wiring until other edges have defined behavior. Show a validation badge on an incomplete sensor and prevent publish with a specific message; allow the user to remove a sensor without affecting ordinary media items.

**Check:** start a new playlist, add sensor, fill details, connect video, save, leave page, reopen, edit, and save again. Also create a normal playlist without ever opening the flow workspace.

## Step 7 — publish contract and worker handoff

Extend the CMS S3 playlist payload and the worker's playlist read path to include flow. A sensor-only edit must change the content fingerprint so the worker republishes. The worker resolves `targetPlaylistItemId` to a playable item and includes sensor rule and target in the player manifest/config. The target video must be cached before the player activates the rule. Publish fails visibly for an unsupported player or invalid port binding.

**Check:** after a port/value/target edit and publish, inspect the newly generated device manifest revision and verify it contains the new rule and correct target media; the previous good revision remains usable on failure.

## Step 8 — tests and readiness gate

Add focused API integration tests for: no-sensor playlist, create/read/update/delete sensor, duplicate/invalid port, wrong value type, cross-tenant ID, target deletion, stale revision, and save-versus-publish validation. Add editor interaction coverage for optional Add sensor, state persistence, validation display, and removal. Run a manual create → publish → player trigger smoke test only after worker/player support is in place.

**Done when:** both ordinary and sensor playlists can be created and edited; the saved flow round-trips through the API; a publish revision reaches the player with the intended port and target video; an invalid sensor cannot silently publish.

# Netcode v2 — a 128-player battlefield

This is the plan for taking the game from a 32-seat LAN room to a 128-player public battlefield.
Read [`AGENTS.md`](AGENTS.md) first — several of the decisions below deliberately overturn things
that document states as settled, and those reversals are recorded in §10.

Status: **P0–P5 are in.** Collision worlds build in Node. Binary `ps` is the position feed.
Interest management filters that feed per recipient (PVS + LOS + Nearby). `step()` is shared;
battlefield rooms run it at 30 Hz on the server and predict on the client. Snapshots are keyframes
filtered by AoI (not fieldMask deltas yet); the snapshot `tick` is the last applied *client* input
tick so a tab that starts sending late still reconciles. WebTransport is an optional listener
(`wt-listen.js`) behind the same `Net` send — one session, never beside a second WebSocket seat;
`node server.js` stays WebSocket-only when the native module or TLS is missing. P5 is explicitly
not a fleet: 128 players stay in one process. Do not add region shards.

The short version: keep the WebSocket path exactly as it is and add a QUIC datagram path beside it;
move authority off the host machine and into the server; replace the JSON broadcast with a
quantized, delta-encoded, per-client snapshot filtered by what that client can actually see. The
transport change is the cheap part. The authority change is most of the work, and the visibility
filter is what makes both 128 players and anti-cheat possible at the same time.

---

## 1. Where the current stack stops working

Four separate walls, each of which is hit well before 128 players.

**Bandwidth is quadratic.** Every client broadcasts `ps` at 20 Hz and the server relays it to
everyone else (`src/main.js`, `syncTick % 3`). A relayed `ps` frame measures 104 bytes, or 118 while
grappling. At 32 players that is 32 × 31 × 20 × 104 ≈ 2.1 MB/s of server egress, which a LAN absorbs
without complaint. At 128 it is 128 × 127 × 20 × 104 = **33.8 MB/s, or 270 Mbit/s**, with each
individual client pulling 258 KB/s down. There is no tuning that rescues this shape; the relay has to
stop being all-to-all.

**The host is a player's laptop.** Waves, enemy health, pickups and the match clock live on one
participant's machine (`net.isHost` throughout `main.js`). That machine's uplink, frame time and
round trip become everyone's. A 128-player battlefield has no host worth electing, and
`HOST_GRACE_MS` promotion — fine when it hands over a co-op wave — becomes a 3.5-second hole in a
match with a hundred people in it.

**Positions are self-reported.** `noteMove()` in `server.js` records what a client says its position
is and never checks it. The only kinematic gate is `combatMove()`, which compares `round` and `life`
and nothing else. Today that is an acceptable trade: the lobby is a LAN, and the thing worth
defending — damage between players — *is* judged, carefully, by `resolveHit()`. On a public
battlefield "the client says where it is" means teleport, speed and flight are all one line of
patched JavaScript away, and no amount of hit-side plausibility checking repairs it, because a
cheater who can place their capsule anywhere passes every check `resolveHit()` makes.

**Everyone is told everything.** Each client receives every other player's position continuously.
Wallhacks and ESP are therefore free and undetectable — the data is already in the tab, and the
renderer is the only thing choosing not to draw it. In a browser, where the client source is served
unminified by design, this is not a hard problem for an attacker; it is a five-line userscript.

TCP head-of-line blocking is a fifth problem, and it is the one players *feel* first on a bad link,
but it is listed last on purpose: it degrades an otherwise-working game, while the four above are
structural.

---

## 2. Transport: WebTransport datagrams, WebSocket kept as the fallback

**Decision.** The data plane moves to WebTransport over HTTP/3. Unreliable datagrams carry input and
snapshots; a reliable stream carries lobby, chat and match events. The existing WebSocket path stays
as a first-class fallback and remains the only path on a LAN install that has not been given
certificates.

**Why now, and not two years ago.** WebTransport reached Baseline in March 2026 when Safari 26.4
shipped it; before that, "no iOS" meant it could not be the only path to a public game. It now runs
in Chrome 97+, Edge 98+, Firefox 114+, Safari 26.4+ and Samsung Internet 18+.

**Why it beats the alternatives on the measurement that matters.** The NSDI 2025 study of
browser-based networking ran a 120 Hz tick loop over each browser transport under 0.0% and 0.1%
induced loss and measured input-to-response in ticks. WebTransport won both conditions — including
against a raw DTLS-over-UDP socket, which it beats because QUIC's BBRv1 congestion control behaves
better than a naive UDP sender. WebSocket was worst in both, and the gap widened with loss, which is
exactly the head-of-line blocking shape: one dropped segment stalls the position feed behind it.

Two secondary properties are worth as much as the latency:

- **Connection migration.** A QUIC connection is identified by a connection ID, not a 4-tuple, so a
  phone moving from Wi-Fi to 5G keeps its session. The `resume` seat-recovery machinery in
  `src/net.js` stays (it still covers process-level failures and the WebSocket path), but on QUIC
  the common case stops triggering it at all.
- **Two delivery modes on one connection.** Today `WSConn.send(str, droppable)` simulates
  unreliability by *dropping superseded state at the application layer* once 64 KB has piled up
  behind a stalled socket. That is a good workaround and it should be kept for the WebSocket path,
  but a datagram that is simply never retransmitted is strictly better: nothing piles up in the
  first place.

### 2.1 Channel assignment

| Channel | Carries | Loss behaviour |
| --- | --- | --- |
| Datagram | input packets, snapshot packets, `pings` | dropped and forgotten; next packet supersedes |
| Reliable stream `ctl` | join/leave, lobby, match start/end, score, chat, kick | retransmitted in order |
| Reliable stream `evt` | kill feed, objective state, spawn/despawn of long-lived entities | retransmitted in order |

The split is not "important vs unimportant"; it is **"does a newer packet make this one worthless."**
A position does. A kill feed line does not.

### 2.2 Fallback, and the one rule that keeps it sane

`WebTransport.reliability === 'reliable-only'` means the session fell back to HTTP/2 and datagrams
are unavailable. Corporate and campus networks block UDP often enough that this is a normal
condition, not an error. Rule: **the wire format is identical on both paths.** WebSocket and
`reliable-only` carry the same binary packets; they just cannot drop the stale ones, so they keep the
existing backlog-shedding behaviour instead. No second protocol, no second code path in the game
layer — only a different `send()` behind the same `Net` interface, which is the seam
[`src/net.js`](src/net.js) was already built around when it moved off WebRTC.

Selection order at connect: WebTransport with datagrams → WebTransport reliable-only → WebSocket.
Report which one is live in the HUD's connection readout, because "why is this player rubber-banding"
is the first question every bug report raises.

### 2.3 Server-side implementation

Node has no native WebTransport. `node:quic` landed as an experimental module (build-flagged,
Stability 1.0) and its documentation is explicit that **WebTransport is not implemented** and is not
on the near path. So there are two real options:

- **`@fails-components/webtransport`** — a C++ binding to Google's quiche, plus HTTP/2 and
  WebSocket-mapping transports and a browser ponyfill. Closest to "add a package and keep one
  process." Its own README calls the HTTP/3 package duct tape until Node ships native support, which
  is a fair description of the risk: a native binary dependency in a project that currently has
  none.
- **A separate data-plane gateway** in Rust (`wtransport`) or Go (`webtransport-go`), talking to
  `server.js` over a local socket. More moving parts, but it puts the native code in a process that
  can crash without taking the room registry with it, and it is the same shape a production
  deployment ends up with anyway once `quilkin` sits in front for DDoS absorption and entry-point
  redundancy.

**Recommendation: start with `@fails-components/webtransport` in-process** to get the protocol right,
and keep the transport behind an interface narrow enough that lifting it into a gateway later is a
deployment change rather than a rewrite. The interface is four methods: `onDatagram`, `sendDatagram`,
`onStream`, `sendStream`.

### 2.4 What was evaluated and rejected

| Option | Why not |
| --- | --- |
| **WebRTC DataChannel** (`geckos.io`) | The only pre-2026 way to get unreliable delivery in a browser, and `geckos.io` is a genuinely good wrapper (its `autoManageBuffering` solves the same problem `WSConn.send`'s `droppable` flag does). But it drags ICE/STUN/DTLS/SCTP along, and this project already *left* WebRTC because STUN and mDNS candidates fail on closed networks (see the header comment in `src/net.js`). Measured slower than WebTransport under loss. Going back would re-import the exact failure mode that was removed. |
| **Colyseus 0.18** | The strongest turnkey option and worth reading regardless: `setFixedTimestep()`, `defineInput()`, `predict.reconciler`, and `allowRewindState({maxRewindMs})` + `rewind.lastSeenBy(sessionId)` implement, as framework, precisely the rewind that `resolveHit()` implements by hand — including the `"snapshot"` vs `"reckon"` distinction for interpolated vs dead-reckoned targets. Rejected because adopting it means handing it the room model, the schema and the message loop, i.e. rewriting every network line in `main.js`, and because its room-shaped state sync still leaves per-client interest management as an exercise. If this were a greenfield project the answer would be different. |
| **Nakama / SpacetimeDB** | Backend platforms whose unit is a persisted record or a relayed match, not a 30 Hz authoritative tick with per-client visibility. SpacetimeDB in particular is a real FPS substrate (BitWars ships on it), but adopting it means the server is no longer `node server.js`. |
| **ENet / GameNetworkingSockets / netcode.io** | Not reachable from a browser without a gateway. Their *designs* are adopted below — sequence + ack bitfield, delta against last acked baseline, priority accumulators — which is the part that was actually needed. |
| **Mirror / Fish-Net** | Unity. Listed only because their published AoI bandwidth numbers (140 vs 70 Mbit/s for 100 players at 60 Hz) are a useful sanity check on §5.6: an engine-grade stack with interest management still spends ~0.7 Mbit/s per player, and the budget below targets a tenth of that by sending far less per entity. |

---

## 3. Authority: the server simulates

**Decision.** For 128-player modes, the server runs the simulation at a fixed 30 Hz. Clients send
input, not state. Client-side prediction and reconciliation keep local movement instant. Host
authority stays for solo, co-op and small private rooms, which is where `MOB_FULL` and the existing
wave logic live and where it works fine.

This is the expensive decision, so it is worth stating what it buys: it is simultaneously the fix for
the host bottleneck, the precondition for server-side visibility culling (§4 — you cannot cull what
you do not simulate), and the only defence against movement cheats that survives contact with an
open-source client.

### 3.1 The tick

- **Simulation: 30 Hz fixed.** Not 60: at 128 players the per-tick cost is what caps the process,
  and 30 Hz of authoritative movement under 100 ms of client prediction is not distinguishable in
  play. Sub-stepping the physics at 60 Hz inside one 30 Hz step is available if step-up or grapple
  integration proves unstable at 33 ms.
- **Input: 30 Hz, one input frame per simulation step.** One input drives exactly one step; that
  invariant is what makes client replay reproducible.
- **Snapshot: 20 Hz**, decoupled from the tick. This matches the rate remotes are already
  interpolated at and halves egress against a 30 Hz send. Raise per-mode if the budget allows.
- **Lag compensation**: the rewind rules in `resolveHit()` are correct and survive unchanged in
  spirit. `INTERP_MS = 80` must keep matching the 0.08 s interpolation delay in
  `RemotePlayer.update()`, `MAX_REWIND_MS = 500` still caps the depth, and the round trip still gets
  measured server-side rather than claimed. What changes is the target of the rewind: the server's
  own simulated history instead of a trail of client-reported positions, which means it becomes
  truth rather than plausibility.

### 3.2 The refactor this actually requires

The obstacle is not the network code. It is that the simulation currently cannot run outside a
browser tab:

- `src/physics.js` imports `three` but only for `Vector3` maths. **Runs in Node as-is** once `three`
  resolves there (see §10).
- `src/level.js` builds colliders and merged ink geometry in the same pass, and imports
  `render.js` (materials) and `enemies.js` (`buildHumanoid`). **Must be split**: each map builder
  gets a `collide(world)` half that only touches `World.addBox`, and a `decorate(scene)` half that
  the server never loads. This is the single largest piece of work in the plan and it should be done
  first, because it is independently valuable — it is also what lets a probe build a level without a
  WebGL context.
- `src/player.js` mixes movement with audio, view models, HUD and i18n. **Extract a pure
  `step(state, input, dt, world) → state`** that both sides import unchanged. Everything the
  difficulty and mobility ladders in `settings.js` feed into must be an argument to that function,
  not a module-level lookup, or the server and client will disagree the first time a lobby changes a
  setting. Note `MOB_FULL` is what solo and squad run on: the extraction must be a no-op there.
- `src/nav.js` already derives from the collision world, so bots move to the server for free once
  the collision world does.

### 3.3 Migration of authority, without two codebases

Keep one code path by making the *host* a role the server can also hold. `net.isHost` becomes
`net.authority`, which is `'local'` in solo, a peer id in co-op, and `'server'` in battlefield modes.
Everything currently written as `if (net.isHost)` becomes `if (net.owns(entity))`. The server-side
simulation is then the same module the host already runs, loaded in Node with a different owner.

---

## 4. Interest management and fog of war

One mechanism, two payoffs: it is the bandwidth fix *and* the wallhack fix. Valorant's Fog of War and
Krell's per-team visibility culling are the same idea — withhold the actor state until it is
legitimately visible — and the anti-cheat literature is unanimous that server-side culling is the
only real defence against ESP, because everything else is an argument about obfuscating data you
already handed over.

### 4.1 Three tiers, evaluated per client per snapshot

| Tier | Test | Sent at |
| --- | --- | --- |
| **Visible** | in PVS sector set, within 150 m, and passes a line-of-sight check | 20 Hz, full precision |
| **Nearby** | within 60 m but not visible (behind a wall, close enough to matter for audio and for the moment they step out) | 5 Hz, position quantized to 1 m, **no** aim/weapon/health fields |
| **Distant** | everything else | not sent at all |

The Nearby tier is the one that needs justification. A strict visible-only filter produces a visible
pop the instant someone rounds a corner, and it deletes footstep audio, which is load-bearing in a
shooter. A 1-metre, aim-less, health-less position is enough to place a footstep and to prime the
interpolator, and is worth very little to a cheater: it cannot be aimed with. Teammates are always at
least Nearby regardless of distance, because the scoreboard and the map need them.

### 4.2 How visibility gets computed 128 times per tick

A line-of-sight raycast per (viewer, candidate) pair is 128 × 127 = 16 k raycasts per snapshot — too
much at 20 Hz. Two-stage it:

1. **Baked sector PVS.** Partition each map into 16 m × 16 m × floor sectors at build time (a
   1 km² map gives ~4 k sectors) and bake a sector-to-sector visibility bitset. At 4 k sectors that
   is 4096² bits = 2 MB per map, computed once by a build script that reuses the collision world, and
   cached on disk next to the map. The lookup is then one bit test per pair.
2. **One raycast to refine**, only for pairs that pass PVS *and* are within the visible radius, and
   only when the pair's state changed sectors since the last evaluation. Cache the verdict with
   hysteresis: 250 ms of "still visible" after the ray fails, so a player strafing past a pillar does
   not strobe.

Budget check: after PVS, the typical candidate set in a battlefield map is 20–40 players, so
raycasts land in the low hundreds per tick, which the existing spatial hash handles.

### 4.3 Priority, not fairness

When the visible set exceeds the byte budget of one datagram (§5.6), do not round-robin. Give each
entity a priority accumulator that grows per tick by a weight — distance, whether it is shooting,
whether it is a threat to this viewer, whether it is an objective carrier — send the highest
accumulators that fit, and zero the ones sent. This is the Quake 3 / Fiedler arrangement and it
degrades in the right direction: the person shooting at you stays at full rate while a stationary
sniper 140 m away updates every third snapshot.

---

## 5. The wire format

Binary, quantized, delta-encoded against the last snapshot the client acknowledged. JSON is not a
tuning knob here — it is roughly 8× the size of the same data packed, and `JSON.parse` at
128 clients × 30 Hz is a measurable fraction of the tick.

Everything below is written with `DataView` on a preallocated `ArrayBuffer`. No schema library, no
codegen; the format lives in one file, `src/wire.js`, imported unchanged by both sides — the same
arrangement `shared/` has in Krell and `game-constants.json` has in BitWars, and the reason both of
them stay consistent.

### 5.1 Packet header (both directions, 8 bytes)

```
u16 seq          this packet's sequence number
u16 ack          highest sequence received from the peer
u32 ackBits      the 32 packets before `ack`; bit n set means ack-n-1 arrived
```

The ack bitfield is doing two jobs, and the second is the important one: every ack is transmitted 32
times over successive packets, so under loss the sender still learns what arrived. That is what makes
delta baselines safe on an unreliable channel, and it is where the RTT and loss estimates come from —
both currently measured by a separate 1 Hz ping loop that can then be deleted from the datagram path.

### 5.2 Input packet (client → server)

```
header (8)
u16 firstTick        tick of the first input frame in this packet
u8  count            number of input frames (1..10)
count × 6 bytes:
  u12 yaw            0..4095 over a full turn      (0.088°)
  u10 pitch          ±90° signed                   (0.18°)
  i6  moveX, moveZ   analog stick, -32..31         (3% of full deflection)
  u14 buttons        fire, aim, jump, crouch, slide, block, grapple, reload,
                     weapon slot (3 bits), interact
```

**Every packet repeats every input frame since the server's last acknowledged tick**, capped at 10.
This is the QuakeWorld sliding window, and it is the single highest-value weak-network technique
available: players hold keys rather than tapping them, so the repeated frames cost almost nothing
after delta, and a lost packet is repaired by the next one before the server ever notices a gap. At
30 Hz and typical 2–3 frame windows this is ~26 bytes per packet, 780 B/s up.

### 5.3 Snapshot packet (server → client)

```
header (8)
u16 tick             server tick this snapshot describes
u16 baseline         tick being delta'd against (0 = keyframe)
u8  count            entities in this packet
per entity:
  u12 id             seat id
  u4  tier           visible / nearby / event-only
  u16 fieldMask      which of the 16 fields follow
  ... only the changed fields, in mask order
```

Field table, with the quantization each field gets:

| Field | Bits | Notes |
| --- | --- | --- |
| x, z | 17 each | 1 cm over a 1310 m axis |
| y | 15 | 1 cm over 327 m |
| yaw | 12 | matches the input quantization exactly, so a replay cannot drift |
| pitch | 10 | |
| vx, vy, vz | 10 each | ±64 m/s at 0.125 m/s — only sent when the client extrapolates, i.e. for visible tier |
| flags | 12 | the existing bitfield from `encodeLocal()`, unchanged |
| hp | 7 | |
| weapon | 4 | |
| grapple hook x/y/z | 12 each | only while the grapple flag is set |

Nearby-tier entities send x/z at 1 m (10 bits each), y at 1 m, flags, and nothing else.

**Baselines.** The server keeps the last 32 snapshots per client and deltas against the newest one
that client has acked. If nothing has been acked for 32 snapshots (1.6 s of total loss), it sends a
keyframe and starts over. This is the Quake 3 arrangement and the reason it works on bad links is
that it never *blocks* — there is no retransmission, only a cheaper or more expensive next packet.

**Never fragment a snapshot.** Cap the packet at 1200 bytes so it fits under any real path MTU; the
priority accumulator (§4.3) decides what gets left out. A fragmented datagram is a datagram whose
loss probability is the union of its pieces'.

### 5.4 Reliable events

Length-prefixed frames on the `ctl` / `evt` streams, same header-less encoding, 1-byte type tag. This
is where `lobby`, `start`, `combatstate`, `score`, kill feed and chat go. Note that the five-place
lobby-field rule in `AGENTS.md` still applies verbatim — host owns the value, it rides in
`broadcastLobby()`, in the late-join `start`, in `hostStart()`, and clients read it in both
handlers — because that rule is about the *game* layer, which this change does not touch.

### 5.5 Budget arithmetic at 128 players

| | Current (JSON broadcast) | v2 (binary + AoI) |
| --- | --- | --- |
| Visible entities per client | 127 | ~24 typical, 40 peak |
| Bytes per entity update | 104 | ~7 delta, 13 keyframe |
| Snapshot rate | 20 Hz | 20 Hz |
| **Per-client downstream** | 258 KB/s | **3.5 KB/s typical, 10.6 KB/s peak** |
| **Server egress** | 33.8 MB/s | **~1.4 MB/s peak (11 Mbit/s)** |
| Per-client upstream | ~2.2 KB/s | ~0.8 KB/s |

The peak column is what to provision. A single Node process serving 11 Mbit/s of small datagrams is
comfortable; the constraint that will bind first is tick CPU, not egress, which is why §3.1 picks
30 Hz and §4.2 bakes the PVS instead of raycasting.

---

## 6. Weak networks

The weak-network story is mostly a consequence of decisions already made above; this section collects
them and adds the three that are not implied by anything else.

**Already covered:** unreliable datagrams (no head-of-line stall), redundant input windows (§5.2),
ack-bitfield redundancy (§5.1), delta baselines that degrade instead of blocking (§5.3), QUIC
connection migration (§2), and the existing seat-resume grace period in `server.js`, which stays.

**Server-side jitter buffer, and only server-side.** Buffer each client's input packets to absorb
jitter, sized per client from its measured variance, and drain at a steady rate. Do *not* add a
client-side jitter buffer for snapshots: the client only ever wants the newest state, and a read-side
buffer starts reading past the write pointer once latency exceeds it, which is a known and
unpleasant failure mode. Remotes are already interpolated 80 ms in the past
(`RemotePlayer.update()`), and that *is* the client's jitter absorption.

**Time dilation under input starvation.** When the server's buffer for a client runs dry, it would
otherwise duplicate the last input and guarantee a mispredict. Instead, tell the client, and have it
simulate at ~15.2 ms instead of 16.7 ms until the buffer refills, then dilate back. This is
Overwatch's technique and it converts a visible correction into an invisible one. It also has an
anti-cheat property: the buffer is the speed-hack throttle, since a client that runs ahead just fills
its own buffer and gains nothing.

**Extrapolation limits.** `RemotePlayer.update()` already extrapolates up to 350 ms along the last
velocity. Keep the cap, but on a snapshot gap longer than ~300 ms freeze the figure rather than
sliding it through a wall — server-authoritative movement means the correction is guaranteed to
arrive, and a figure that walks through geometry and snaps back reads worse than one that pauses.

**What degrades on the WebSocket path.** Datagram loss becomes retransmission, so the per-packet
redundancy in §5.1/§5.2 is wasted work and the backlog shedding in `WSConn.send` becomes the
mechanism again. Expect roughly the behaviour of today's build, which is acceptable, and is why the
fallback is a fallback rather than a failure.

---

## 7. Anti-cheat

No kernel driver, no obfuscation theatre. The client source is readable — that is a property of the
project, not a bug — so every defence has to be an authority decision.

| Cheat | Defence | Where |
| --- | --- | --- |
| Teleport, speed, fly, noclip | Server simulates movement from input; client position is never accepted | §3 |
| Wallhack, ESP, radar | Server-side visibility culling; the data is not sent | §4 |
| Aimbot | Not preventable. Server-side telemetry: flick-time distributions, snap-to-target angular velocity, headshot ratio by distance, time-to-acquire after a target becomes visible. Flag, review, ban. | — |
| Rate-of-fire, infinite ammo | Server owns ammo and cooldowns. The token buckets in `withinFireRate()` already do this and should stay as the second layer. | `server.js` |
| Damage inflation | Server computes damage. The `ARMS` `pvp` caps become the *source*, not a bound on a claim. | §3 |
| Packet forgery, malformed fields | Fixed-width binary fields cannot encode an out-of-range value; the few that can (entity ids, counts) get explicit bounds. Drop and log, never clamp-and-continue. | `src/wire.js` |
| Lag switch, fake ping | Round trip stays measured server-side, never claimed — `rttOf()` already takes the *floor* of recent samples for exactly this reason. Rewind stays capped at `MAX_REWIND_MS`. | `server.js` |
| Bot/scripted clients | Input plausibility: a human's `moveX/moveZ` is analog and noisy, and a perfectly quantized stick value held for 400 ticks is a signal. Telemetry, not a hard gate. |  — |

Two notes carried over from the current implementation, because they are already right: damage
between players is a *claim* that the server adjudicates rather than a message one client sends
another, and the grenade registration in `noteGrenade()` bounds a projectile by its launch envelope
rather than re-simulating it. Both survive the move to server authority; the second becomes cheaper,
because the server will own the throw.

The deployment warning in `AGENTS.md` — a room server has no authentication and must not be put on
the open internet — is **not** resolved by any of this. A public battlefield needs accounts, or at
minimum signed session tokens issued by something that is not the room server. That is out of scope
here and must be solved before a public deployment, not after.

---

## 8. Migration order

Each phase ends with a playable game. Nothing here is a big-bang cutover.

- **P0 — Split `level.js`.** `collide(world)` separated from `decorate(scene)`; a map builds its
  collision world with no WebGL context. Independently useful for probes. No network change.
- **P1 — Binary wire for `ps`.** Introduce `src/wire.js`, encode the existing position feed as bytes
  over the existing WebSocket. ~8× less bandwidth for one afternoon of work, and it proves the
  quantization before anything depends on it. Version the packet so old clients are refused cleanly.
- **P2 — Interest management, still host-authoritative.** Server-side AoI filter on relayed
  positions using the baked PVS. This is where the quadratic term dies and where ESP stops working,
  and it does not require the simulation to have moved yet.
- **P3 — Extract `step()` and run it in Node.** Server simulates movement, reconciles client
  prediction, owns hit resolution against its own history. This is the long phase; gate it behind a
  new mode so the existing modes keep the host path.
- **P4 — WebTransport.** Datagram data plane with WebSocket fallback, behind the same `Net`
  interface. Deliberately after P1–P3: without binary packets and AoI there is not much worth
  putting in a datagram, and with them the transport swap is small.
- **P5 — Scale-out.** Not built, and not needed at 128. Tick CPU binds before egress once AoI is
  on; one Node process is the answer. `quilkin` / `agones` wait until a load test fails. Region
  sharding is explicitly *not* planned — it introduces a boundary-handoff problem an order of
  magnitude harder than anything above.

  Determinism check (same input, two `step()` copies):

  ```
  node --input-type=module -e "import('./src/netsim.js').then(m => console.log(m.selfCheck()))"
  ```

---

## 9. Dependencies, and what this costs

This plan breaks the project's defining constraint, so the break should be explicit rather than
discovered later.

`AGENTS.md` says: no build step, no `package.json`, no dependencies, `node server.js` and reload the
tab. **P0–P3 preserve that entirely** — binary packing, AoI and server-side simulation are all plain
JavaScript, and the only new requirement is that `three` resolve in Node — verified: Node imports
`vendor/three.module.js` (r170) directly and its maths works, so no package manager is involved.

**P4 breaks it.** A WebTransport server needs a native QUIC stack, which means a `package.json`, a
`node_modules`, a native binary, and TLS certificates (WebTransport is HTTPS-only, and a LAN address
has no public certificate — expect `serverCertificateHashes` for self-signed, which caps validity at
14 days and needs a hash handed to the client at connect time).

The mitigation that keeps the LAN promise: **`node server.js` stays dependency-free and
WebSocket-only.** The WebTransport listener is an optional module the server loads if it is present
and silently skips if it is not. Somebody cloning the repo to play on a LAN sees no change; a
128-player deployment installs the extra piece. If that conditional load proves ugly in practice,
fall back to the separate-gateway option in §2.3, which keeps `server.js` literally untouched.

---

## 10. Verifying it

`AGENTS.md`'s three-step rule still applies — parse everything, drive the real page headlessly, then
play it — with two additions specific to this work:

- **A headless load harness.** N simulated clients in one Node process, running the real `step()` and
  the real wire format against a real server, with a network emulator in front (`tc netem` on Linux,
  `dnctl`/`pfctl` on macOS) applying loss, jitter and reordering. The numbers to watch are p99
  input-to-acknowledgement, snapshot bytes per client per second, and tick time. 128 simulated
  clients is the acceptance test, and it should be run under 2% loss and 40 ms jitter, not on a clean
  link.
- **A determinism check in CI-in-spirit.** Run the same input sequence through `step()` on the client
  and on the server and assert bit-identical output. The moment those diverge, prediction produces
  corrections that look exactly like lag, and there is no way to tell them apart from a bug report.

Feel still decides. A 128-player battlefield that measures perfectly and rubber-bands when three
people round a corner at once has failed, and only playing it says so.

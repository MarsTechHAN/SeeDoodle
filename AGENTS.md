# Working on this repo

A browser FPS drawn as pen-on-paper, plus the small Node server that hosts its rooms. It runs on a
LAN with no internet: no CDN, no signalling service, no telemetry.

Read this before changing anything. Most of it is not style advice — it is the set of decisions that
the rest of the code assumes have already been made, and undoing one by accident is how this project
breaks.

## The one rule: there is no build step

`index.html` loads `src/main.js` as a native ES module and resolves `three` through an
[import map](index.html). Nothing is transpiled, bundled, minified or installed. There is no
`package.json`, no `node_modules`, no lockfile, and adding one is a change to what the project *is*,
not a convenience — so do not add a dependency, a bundler, TypeScript, JSX, or a test runner without
being asked for it explicitly.

What that buys: you can edit a file and hit reload. Keep it that way.

Third-party code lives in `vendor/`, vendored deliberately, with its licences recorded in
[`vendor/NOTICE.md`](vendor/NOTICE.md). Do not swap a vendored file for a CDN URL.

## Running it

```
node server.js          # port 8080
node server.js 9000     # or pick your own
PORT=9000 node server.js
```

Plain Node, no flags, Node 20+. It serves the static files *and* the WebSocket rooms from the same
port, and binds `::` so it answers on IPv4 and IPv6 at once. Open the printed address; a second
browser on the same address is a second player.

Two query parameters exist for testing: `?touch=0` and `?touch=1` force the desktop or the phone
control scheme, and `?lang=en` / `?lang=zh` pins the language. Persistent state is a handful of
`doodle_*` keys in `localStorage` — clear those to get a first-run experience back.

## Layout

```
index.html      import map, one <canvas>, one <div id="hud">. That is the whole document.
server.js       static files + rooms + WebSocket + hit judging. Zero npm deps; WebTransport is optional.
style.css       the HUD and every screen. The game world is not styled here - it is drawn.
src/
  main.js       bootstrap, game loop, waves, lobbies, screens, pickups, scoring. The wiring.
  render.js     the look: scene -> (shade, inkId, normal) buffer -> a full-screen pen pass.
  level.js      map construction. Merged ink geometry + box colliders, one builder per map.
                `buildCollision(world, key)` builds the same boxes with no scene (Node-safe).
  ink.js        pen ids only. The server names surfaces without loading shaders.
  physics.js    axis-aligned box world, spatial hash, swept movement with step-up, raycasts.
  nav.js        navigation grid generated from the collision world, one node per walkable surface.
  player.js     you: camera feel, health, weapons. Movement is `step()` from move.js.
  move.js       pure `step(state, input, dt, world, rules)`. The server cannot load player.js.
  pvs.js        baked 16 m sector visibility for interest management.
  netsim.js     room-side AoI + the 30 Hz battlefield tick. The browser never loads this.
  weapons.js    view models and firing. One entry in GUNS per weapon, one class per behaviour.
  bullets.js    ballistic rounds, when the match is running drop and travel time.
  enemies.js    enemy types, AI, replication. One entry in TYPES per enemy.
  players.js    other people in the match: interpolation, and the target surface enemies expect.
  effects.js    ink particles, decals, gibs, tracers.
  audio.js      procedural WebAudio. There are no sound files in this repo.
  hud.js        the DOM heads-up display.
  touch.js      the phone control scheme.
  input.js      keyboard, mouse and gamepad folded into one state map.
  net.js        the client half of the transport. `authority` is `'server'` in battlefield.
  wire.js       binary `ps` / nearby / input / snapshot. Shared by the client and the room server.
  settings.js   every knob the config panel exposes, and the difficulty/mobility tables.
  i18n.js       language.
  util.js       shared maths.
wt-listen.js    optional native WebTransport listener; skipped when the module or TLS is missing.
vendor/         three.js, BufferGeometryUtils, the fonts.
```

## Conventions that are load-bearing

**Comments say why, not what.** The codebase is dense — long lines, a lot per file — and it is
readable because the non-obvious decisions are written down next to themselves, in prose, in
paragraphs above the code they explain. When you change a decision, change the paragraph. When you
add one, write one. Do not add comments that restate the line below them.

**The file is the unit.** A feature that touches movement goes in `player.js`, not in a new
`mobility.js`. Modules here are large on purpose; a new file needs a reason beyond size.

**English strings are the keys.** `t\`...\`` (tagged template) and `ts(str)` look the string up in
`DICT` in `src/i18n.js` and fall through to the string itself when there is no translation. So you
write the English at the call site and add a `zh` entry; you never invent a key like `hud.ammo.low`.
Anything user-visible you add needs its `zh` line in the same change.

**Settings defaults are the shipped feel.** `SETTINGS[k].def` in `src/settings.js` is the number the
game was tuned against, not a neutral middle — that is what makes RESET TO DEFAULTS mean something.
If you retune, move the default.

**EASY is "what the game already did".** Both ladders in `settings.js` are built so that the lowest
rung reproduces the old hardcoded behaviour exactly, and every rung above it only ever takes things
away. Keep them monotonic: a player must never find that a harder setting gave them something back.

## The server relays; battlefield is the exception

`server.js` still forwards host-auth rooms verbatim. It does not know the enemies or what a lobby
field means. Two consequences you will run into:

- **Adding a lobby setting does not touch `server.js`.** Follow the existing shape exactly — see
  `lobby.diff`, `lobby.mob` and `lobby.fall` in `main.js`: the host owns the value, it rides along in
  `broadcastLobby()`, in the late-join `start`, and in `hostStart()`'s `start`; clients read it in
  `net.on('lobby')` and `net.on('start')`. Miss one of those five places and it desyncs on join.
- **Adding an enemy type does not touch `server.js`** either — the type is a string in `espawn`.

It now *does* know the collision world: `buildCollision` + a baked PVS filter every relayed `ps`,
which is what stops the all-to-all feed and what withholds wallhack data. Damage between players is
still a claim the server rewinds. On host-auth modes the rewind is a trail of reported positions
(plausibility). On **battlefield** (`net.authority === 'server'`) the server steps `move.js` at 30 Hz
and the rewind is its own history.

If you change a weapon's damage or rate of fire, update its `pvp` triple in `GUNS` or legitimate hits
will start being refused.

Authority elsewhere is split: the host owns enemy health, waves and pickups; enemy *projectiles* are
replayed on every client so each applies its own hurt without waiting for a round trip. `net.isHost`
is still that job. `net.owns('sim')` is false in battlefield because the room process owns movement.

## Verifying a change

There is no test suite and adding one has not been asked for. What is expected instead:

**1. Parse everything.** There is no `package.json`, so Node reads `.js` as CommonJS and chokes on
`import`. Copy to `.mjs` first:

```sh
for f in src/*.js; do cp "$f" /tmp/c.mjs && node --check /tmp/c.mjs || echo "BAD $f"; done
node --check server.js
```

**2. Drive the real page headlessly.** For anything with numbers in it — movement, recoil, damage,
spawn placement — write a throwaway `_xxprobe.html` at the repo root that loads `./` in an iframe,
reaches into `window.__game`, drives the real objects, and prints assertions into a `<pre id="out">`.
`.gitignore` already excludes `_*probe.html`; **delete it once the change is verified** rather than
leaving a probe served at a public URL.

Four things about that harness cost real time to discover:

- **Chrome under `--virtual-time-budget` never fires a single animation frame** (measured: zero). A
  probe that waits on `requestAnimationFrame` measures a frozen game. Drive it yourself at a fixed
  step: `for (…) { input.update(1/60); player.update(1/60); }`.
- **Set `inp.pointerLocked = true` by hand**, or `src/input.js` discards every mouse movement.
- **Press buttons through `inp.touchKeys`.** `input.update` folds it into the same state map the
  keyboard writes, so one frame set is a `pressed()` and several frames is a `down()`.
- **`console.log` everything you also buffer.** If a section hangs, `--dump-dom` never happens and
  the buffer dies with the tab, but the console lines are already out on stderr.

A runner that works, including the watchdog — **macOS has no `timeout`**, which is the other thing
that costs time:

```sh
CH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
"$CH" --headless=new --disable-gpu --enable-unsafe-swiftshader --use-angle=swiftshader --no-sandbox \
  --user-data-dir=/tmp/probe-prof --window-size=1000,700 --virtual-time-budget=40000 \
  --enable-logging=stderr --v=0 --dump-dom "http://127.0.0.1:8123/_xxprobe.html" > /tmp/out.html 2>/tmp/err.log &
P=$!; for i in $(seq 1 90); do sleep 1; kill -0 $P 2>/dev/null || break; done; kill -9 $P 2>/dev/null
grep -a PROBE /tmp/err.log
```

A window larger than about 1000×700 makes swiftshader crawl.

**3. Play it.** Numbers passing is not the same as it feeling right, and most of what is interesting
here is feel. Say plainly which of the three you did.

## Things that will bite you

- **`window.__game`** exposes the live objects for probing. It is not an API — do not build features
  on it, and do not remove things from it either, since probes reach for them.
- **`net.send()` returns early when not connected**, so a probe can set `net.isHost = true` safely.
- **`MOB_FULL` is what solo and squad run on.** Anything gated on `player.mob` must be a no-op there,
  or you have changed single-player while editing a deathmatch rule.
- **`mapHTML()` renders nothing when fewer than two maps are eligible** (`src/main.js`). A map marked
  `pvpOnly` is invisible outside a versus lobby, which is why the map row is absent in solo.
- **Levels are merged geometry.** You cannot move a wall at runtime; rebuild the level.
- **The audio is synthesised.** Adding a sound means writing an oscillator, not adding a file.

## Deployment

Static files plus one Node process; anything that can run `node server.js` can host it. Note that a
room server has **no authentication of any kind** — anyone who can reach the port can join, host, and
be handed authority over enemies and the wave clock. That is fine on a LAN and is not fine on a
public address, so do not put one on the open internet.

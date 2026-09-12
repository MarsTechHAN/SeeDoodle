# Doodle District

A local mirror of [doodleshooter.vercel.app](https://doodleshooter.vercel.app), rebuilt to run entirely on
your own LAN: no CDN, no internet, no signalling service. Everything the page needs — three.js, the
font — is vendored into `vendor/`, and multiplayer runs over a small WebSocket server included here.

## Running it

```
node server.js          # port 8080
node server.js 9000     # or pick your own
PORT=9000 node server.js
```

No `npm install`, no dependencies — the server is plain Node (tested on Node 20+). It serves the
static files and the game's rooms from the same port, and listens on `::`, so it answers on IPv4 and
IPv6 at once.

On startup it prints every address the machine can be reached at. Anyone on the same network opens
one of them in a browser; `/lan/info` returns the same list as JSON along with the current room count.

## Playing together

Open the game, choose **ONLINE**. Everyone can host and everyone can join:

- **CREATE ROOM** hands you a four-character code. Share it.
- **JOIN** takes that code, or **QUICK PLAY** drops you into any room with space.
- The lobby list shows public rooms on the same server; a room can be public or invite-only.

Rooms hold up to 32 participants, including bots, with up to 16 on each team. A human joining a
full bot-filled room replaces a bot. If the host leaves, the server promotes whoever has been in
the room longest and the match carries on — nobody gets dropped.

A player who walks out of wifi range never gets to say goodbye, and their socket dies without a
close frame. Losing a match to that is the difference between a game and a demo, so a socket going
quiet is not treated as leaving: the room is told the player has stalled, their seat is held, and
the seat key they were handed at connect walks them back into the same id, score and team when they
reconnect — the client retries on its own, backing off from 200 ms to 4 s. Twelve seconds of silence
ends the seat for good. The host is the exception: it owns the enemies and the wave clock, so it is
handed on after 3.5 s rather than stalling everyone else's match while it is away.

During play, hold Tab for the tactical map and scores, including each player's server-measured round-trip time; release it to close. In menus, Tab navigates the controls normally. Phone MAP and controller Create toggle the map even when keyboard, mouse and controller input are mixed.
Team Deathmatch and Demolition also show a translucent, north-up minimap in the top-right corner on every map. The arrow follows you (or the teammate you spectate), and team-colored dots track living teammates, including bots. Demolition adds A/B site markers. The minimap hides while menus or the full tactical map are open.
While the panel is open, the mouse wheel scrolls the player list instead of changing weapons.
On touch screens, tap MAP to open it and tap again or fire to close; a controller's Create button
toggles the same panel. Solo play shows the map without a scoreboard. The map shows living teammates
and objective sites, never opponents. Only attackers see carried or dropped C4; everyone sees a
planted bomb. A small heading and area label helps with navigation while the map is closed.

### Connecting to someone else's machine

There is nothing to configure. The room server is whichever machine served the page, so opening
`http://192.168.1.42:8080/` puts you on that machine's rooms and everyone who opened the same link
is already in the same lobby list.

### Game modes

Picked by the host in the lobby, before the match starts:

- **VERSUS** — free-for-all deathmatch on a timer. Most kills wins.
- **SQUAD** — co-op against the waves. Harder than solo and it scales with the squad: bigger wave
  counts, a higher live-enemy ceiling, tougher hits and more pickups per wave. Downed teammates show
  struck through on the scoreboard, and the run ends when the whole squad is down at once.
- **TEAM DEATHMATCH** — two teams, opposite spawn bases, matching team uniforms and no friendly
  fire. First to 50 kills, or the higher score after eight minutes. Respawn takes three seconds;
  two seconds of protection ends early on attacking. A tied time limit is a draw.
- **DEMOLITION** — one life per round. Attackers carry one C4 to A or B and hold B for five
  seconds to plant; defenders hold B for seven seconds to defuse. N drops the carried bomb.
  Touch controls provide contextual buttons. The round lasts two minutes before planting and
  the fuse lasts 40 seconds. First to five wins; sides switch after round four. Dead players
  spectate teammates, and late arrivals enter the next round. Spectator views buffer movement and
  turning for smooth playback; left click, gamepad R2 or the touch NEXT button switches teammates.

The host can add bots individually, fill the room to 32, and arrange teams before starting either
team mode. Bots navigate the same
level, fight through the same damage checks, and can carry, plant and defuse C4. Weapon restrictions
are independent of the game mode; the knife rule allows unlimited grenades.
Falling out of a team map resolves one death through the normal life/respawn rules, including bots.
A lost C4 returns to a reachable surface, preferring its carrier's last stable ground. Bots preserve
an ongoing defuse and assign a replacement by walkable route if the current defuser dies.

### Maps

**DOODLE DISTRICT** is the original: streets, rooftops and fire escapes, and it is where the waves
come from. **THE UNDERCITY** is versus-only — it does not appear in the map list for a squad
run, because it has no sky for flyers and no long approach for a wave to walk down.

Every map in the selection supports both Team Deathmatch and Demolition: Doodle District,
The Undercity, Sunline Depot, Zijingang East, Times Square, Summer Palace, Old Summer Palace,
the Great Wall and Lombard Street. The host can switch between these modes while
keeping the selected map. Each has opposing team bases and A/B bomb sites. District and Undercity
use dedicated team layouts with grouped spawn slots and sheltered exits; switching back to
free-for-all restores their original layouts. Bots and the same weapon restrictions work on every
team map. The Undercity team layout includes longer, guarded stairs and underground navigation,
so bots can return from the service tunnels and recover a dropped C4 there.

The four landmark maps use reference photographs and recognizable site layouts, with routes and
distances adapted for multiplayer combat. They are architectural interpretations, not survey models.
All four also appear in solo, squad and free-for-all selection, and support the existing weapon rules.

- **SUMMER PALACE** follows the south-facing Longevity Hill axis: Kunming Lake, the Long Corridor,
  Paiyun courtyard, diamond-shaped stair and octagonal Tower of Buddhist Incense. Curved tiled eaves,
  vermilion columns, blue-green painted beams and lake scenery distinguish the 176 x 107 m playable
  block. Opposite garden bases connect through the shore, corridor and stepped courtyard.
- **OLD SUMMER PALACE** is a 140 x 128 m section of the surviving Western Mansions ruins. Dashuifa's
  broken arched screen and scroll-shaped wings, the higher Yuanyingguan columns, fountain basins and
  Guanshuifa stone panels keep their north-south order. Rubble, carved stone, garden paths and broken
  walls provide cover; the lost palaces are not rebuilt as intact buildings.
- **THE GREAT WALL** follows a Mutianyu-inspired ridge, with five accessible watchtowers, arched
  passages, crenellations, roof stairs and a lower mountain path. Both team bases and the A/B sites
  are reachable on foot. Terrain outside the planned paths catches accidental falls, while distant
  mountains and continuing walls establish the setting beyond the 240 x 142 m playable crop.
- **LOMBARD STREET** retains the eight hairpin turns between Hyde and Leavenworth, the red brick
  road, hydrangea beds, side stairs, bay-window houses and downhill view towards Coit Tower. The core
  falls 34 m over 126 m, close to the real hill's 27% grade; the 94 x 166 m crop adds sheltered
  cross-street bases and two flat residential gardens with separate stair entrances for A/B.

The new masonry, paving and grass materials share one local generated image download; each material
receives its own repeating texture and mip chain to avoid distant atlas seams. Glazed roof tiles,
lacquer and stucco use world-anchored procedural finishes. Textures retain lighting and shadows, and
missing images fall back to solid materials. The original paper/ink look remains available.

References include [UNESCO's Summer Palace entry](https://whc.unesco.org/en/list/880/),
[Old Summer Palace](https://en.wikipedia.org/wiki/Old_Summer_Palace),
[UNESCO's Great Wall entry](https://whc.unesco.org/en/list/438/),
and [Lombard Street](https://en.wikipedia.org/wiki/Lombard_Street_(San_Francisco)).
Reference photographs are not distributed with the game; generated material provenance is in
`assets/README.md`.

**TIMES SQUARE** is a 100 x 220 m interpretation of New York's Broadway/Seventh Avenue junction.
The avenues cross to form the two triangular pedestrian plazas: red TKTS steps and the Duffy
monument to the north, and a slender trapezoidal One Times Square tower to the south. Individual
landmarks include the Marriott Marquis slab wings and advertising podium, the recessed One Astor
glass tower, Paramount's stepped clock tower, and Nasdaq's cylindrical screen at 4 Times Square.
The narrower street canyon, theatre entrances, yellow taxis and shop passages provide distinct
routes. Opposite protected bases and two ground-level bomb sites support both team modes and bots.
Solo, squad survival and free-for-all are available too.

Both world skins work. Sunlit Toon uses a dusk sky and a locally served billboard atlas with
photographic advertising illustrations and clear lettering; signs stay steady without flashing.
Classic Ink converts the same artwork to luminance hatching. The shared 2048 x 2560 JPEG is under
1 MB, requires no external requests, and falls back to plain signs if unavailable. Asset generation
and composition provenance are documented in [assets/README.md](assets/README.md).

Layout and visual references include the [Times Square Alliance](https://www.timessquarenyc.org/),
the [Times Square overview](https://en.wikipedia.org/wiki/Times_Square),
[Duffy Square](https://en.wikipedia.org/wiki/Duffy_Square), and the Commons photographs
[southward street view](https://commons.wikimedia.org/wiki/File:New_york_times_square-terabass.jpg),
[street panorama](https://commons.wikimedia.org/wiki/File:Times_Square_Panorama.jpg),
[One Times Square](https://commons.wikimedia.org/wiki/File:1_times_square_night_2013.jpg), and
[TKTS steps](https://commons.wikimedia.org/wiki/File:Father_Duffy_statue_and_TKTS_booth_risers.jpg).
Landmark massing and position also follow the articles for
[One Times Square](https://en.wikipedia.org/wiki/One_Times_Square),
[Marriott Marquis](https://en.wikipedia.org/wiki/New_York_Marriott_Marquis),
[One Astor Plaza](https://en.wikipedia.org/wiki/One_Astor_Plaza),
[Paramount Building](https://en.wikipedia.org/wiki/1501_Broadway) and
[4 Times Square](https://en.wikipedia.org/wiki/4_Times_Square).
These are research references; their photographs are not shipped as textures. Street proportions,
bases, accessible interiors and cover are adapted for play rather than a 1:1 reconstruction.

The undercity is three floors stacked in a 90 m box: flooded tunnels at −11.5, shuttered shops at
ground level, and a gantry ring at +9.5, joined by six stairwells and a central hatch. The floor
plates are deliberately broken rather than solid, so a shaft is a sightline *and* a way through, and
every flight is walkable — you can get from the lowest tunnel to the top gantry without a grapple,
which matters because HARD does not give you one. Two players standing on random spots can see each
other about **19%** of the time, against **44%** on the district. That is the whole design brief: no
big open middle, no rooftop that overlooks everything, and a fight that is decided by which corner
you came around.

**SUNLINE DEPOT** is the compact 84 x 64 m team arena, with sheltered opposite bases and two bomb
sites. **ZIJINGANG EAST** is a 480 x 360 m district inspired by Zhejiang University's Zijingang campus:
East 1 to the north, East 2 to the southeast, the cultural corridor immediately west of East 2,
the low Yongman waterside lecture hall, and Qizhen Lake to the west. The expanded perimeter adds
the Basic Library, East 3, East 5, East 6 / East 7 and west-bank paths connected by a footbridge
and land crossings. The original East 1 / East 2 buildings retain their dimensions. Its rectangular
extent is 172,800 square metres, four times the earlier campus block, including water and buildings.
The campus is available in solo, squad, free-for-all and both team modes. The host selects the map
for the room; Classic Ink and Sunlit Toon are both supported.

This is a compressed game interpretation of the eastern district, not the whole campus or a 1:1 survey.
Courtyards, lakefront paths, the wooden bridge and upper walkways provide different routes.
Entrances, accessible floors, stairs, cover, bases and A/B positions are adapted for play.
Ground-floor rooms and selected walkways are accessible; upper teaching floors are scenery.
The teaching wings include eight enterable ground-floor rooms, window bays and covered entrances.
Yongman Hall has working entrances, an interior lecture space, a dais and seating. Display islands,
reading tables, corridor beams, lakeside paving and distinct tree forms help identify the routes.
Sunlit Toon adds cached static sunlight shadows and restrained stone, tile, wood, glass and water
finishes. The sun shadow is baked when the map changes rather than following the camera; Classic
Ink keeps its original rendering.

Layout references are the [official campus map](https://map.zju.edu.cn/index.html) and
[OpenStreetMap contributors](https://www.openstreetmap.org/copyright), whose data is available
under ODbL. The footprint sources include East 1 [way 161325315](https://www.openstreetmap.org/way/161325315),
East 2 [way 161325385](https://www.openstreetmap.org/way/161325385), the cultural corridor
[way 1122111924](https://www.openstreetmap.org/way/1122111924), and the waterside lecture hall
[way 161325273](https://www.openstreetmap.org/way/161325273). Official building photographs identify
the white-gray facade bands, dark glass stair towers, and Yongman's pale entrance and curved roof.
The university's [cultural corridor report](http://www.news.zju.edu.cn/2022/0530/c1043a2568048/page.htm)
provides column, glass railing and wood-platform details. Official and OSM floor counts for East 1
differ; the game does not claim measured floor accuracy. Reference photographs are not bundled as
textures: the map uses original procedural geometry and the game's locally served materials.

## Versus: movement, and supply

A wave of enemies needs a player who can wall-jump out of a corner and dash across a street. Another
player does not, and a duel decided by who was airborne is not the fight these maps were drawn for.
So a deathmatch runs on its own movement ladder — the host's pick in the lobby, alongside the mode,
the map and the difficulty — and every rung of it is slower than the campaign, EASY included.

| | sprint | jump | air control | kit |
|---|---|---|---|---|
| **EASY** | ×0.94 | ×0.97 | ×0.92 | everything, a little heavier |
| **MID** | ×0.88 | ×0.94 | ×0.78 | no second jump · grapple on a 2.2 s cooldown |
| **HARD** | ×0.82 | ×0.90 | ×0.62 | feet only: no grapple, no dash, no wall-jump |

The kit only ever shrinks — HARD ⊆ MID ⊆ EASY ⊆ solo — so there is nothing to learn on one rung that
is wrong on the next. Solo and squad play are not on the ladder at all: they run the full kit, and
none of this touches them. Every branch in the movement code reads the tier live, so the host can
change it between rounds and the next tick obeys; the match start banner names the tier, because a
dash that silently does nothing reads as a bug. Pressing the grapple on HARD says so out loud rather
than doing nothing, and the target ring is not drawn — a reticle that lights up on something you
cannot reach is worse than no reticle.

Supply is the other half. A deathmatch has no wave to drop crates, so the arena seeds its own:
**ammo every 7 s** up to ten crates on the floor, and — versus only — a **medkit every 13 s** up to
three. Squad survival is untouched; its waves already drop medkits, and a second source would quietly
rebalance a mode nobody asked for. Placement throws eight darts at the map's spawn spots and keeps
the one furthest from everyone alive, discarding any that would land on top of an existing crate
(3 m) or in a living player's lap (6 m). If nothing sensible is free this second it waits a moment
and looks again rather than burning the interval. So supply pulls people out of where they are
standing instead of rewarding whoever is already camped on the spawner.

## How the multiplayer fits together

The original used WebRTC peer-to-peer. That is the wrong shape for a LAN — it needs a STUN server to
discover addresses, Chrome hides local candidates behind mDNS, and plenty of home routers will not
hairpin a connection back to the network it came from. So peering is gone; the server relays instead,
which on a LAN is a millisecond either way and works with no internet at all.

One player in each room is the host, and the host is authoritative over enemies, waves and pickups.
Clients mirror what it tells them. Damage authority is split: the host owns enemy health and decides
who dies, while enemy *projectiles* are replayed on every client so each one applies its own hurt
locally and reacts without waiting for a round trip. Melee and blast damage stay with the host and
arrive as a message.

Damage between *players* is not the host's to give, and it is not the shooter's either. A client that
thinks it hit someone sends a claim — the weapon, the damage, and the ray it fired — and the server
decides. Because a claim describes something the shooter saw a round trip and an interpolation buffer
ago, the server rewinds: it keeps 1.5 s of everyone's positions from the movement feed it is already
relaying, times each client's round trip itself (never asking, since a bigger number would buy a
deeper rewind), and tests the shot against where the target stood `rtt + 80 ms` ago, capped at half a
second. It then checks the damage against what that gun can do, the origin against where the shooter
was, and the rate against what the gun can fire. It has no copy of the level and no skeleton, so it
cannot know a wall was in the way and it tests a capsule rather than animated limbs — but the shot
now has to be plausible, and the latency is out of the way when it is judged.

### Bullet drop and travel time

Off by default; on, it is a settings checkbox when you are alone and the host's call in the lobby, so
everybody in a match is shooting the same physics. A round then leaves the muzzle at 200–450 m/s
depending on the gun and falls at 9.8 m/s² the whole way. Inside 60 m the drop is under 10 cm — less
than the crosshair covers — so close quarters feel exactly as they did; a shot across the map needs a
lead and a hold, which is the point.

It changes what a claim can say. A hitscan claim describes a ray, and a curved path cannot be handed
over as one, so a ballistic claim names the point the round landed on and how long it was in the air,
and the server checks that point against the capsule where the rewind puts the victim. The rewind
itself does not change: a claim is sent when the round lands rather than when it is fired, so the
shooter's screen was already exactly `rtt + 80 ms` behind whatever it was aiming at. That is also why
flight time is not worth lying about — it never enters the rewind, so a bigger number buys nothing.

## Difficulty

Four tiers, and they only ever touch two things: how you heal and how long you can run. Enemy health,
damage and counts are left alone — the wave modifiers already scale those, and stacking a second
multiplier on top of them makes a run hard in a way nobody can read.

| | starts healing after | heals at | sprint |
|---|---|---|---|
| **EASY** | 4.5 s | 11 hp/s | unlimited |
| **MEDIUM** | 4.5 s | 6.5 hp/s | 5.2 s, then a meter |
| **HARD** | 7.5 s | 4 hp/s | 3.8 s |
| **EXTREME** | never | — | 3.2 s |

EASY is not really a setting, it is a name for what the game has always done: its two numbers are the
old hardcoded ones, and with unlimited sprint the stamina meter is not drawn at all, so a player who
never opens the menu sees no change. Everything above it takes something away and nothing back, so
the ladder is monotonic — HARD makes you wait *longer* before healing starts, not shorter. On EXTREME
the only health in the game is a dropped medkit.

Online, the host picks it in the lobby the way they pick the mode and the map, and it rides along in
the same message; a squad match keeps its long-standing edge over solo as a ratio on top of whichever
tier is set, which lands on exactly the old numbers at EASY and still never heals on EXTREME.

## Recoil

The gun used to shake the camera and put it back. That is a screen effect, not a weapon: the shots
still went where the crosshair was, so holding the trigger cost nothing and tapping bought nothing.
Recoil now moves the aim for real, the way a battlefield shooter does it, and the whole design is in
what happens to the displacement afterwards.

Each round pushes the view up and to one side, and that push is *remembered*. Stop firing, wait a
third of a second — long enough that it does not feel like elastic — and the view walks back down to
exactly where it was pointing before the burst. Fight the climb by pulling down yourself and you
**spend** the memory instead of banking it, so a hand-corrected burst is not yanked below the target
the moment you let go. That single rule is what makes recoil learnable rather than merely annoying.

The climb tapers as it accumulates: the first rounds move the muzzle hard, later ones move it much
less, so a full 35-round magazine tops out around **9°** instead of ending up pointed at the sky. A
1.2 s burst is about 3.6°. The sideways wander is mostly a repeatable figure with a little noise on
top — enough that a spray can be learned and countered, not so much that it feels like a machine.

A burst is a burst: let go for a third of a second and the gun is settled, and the next round is a
first round again, kicking about a fifth of what the sixth round of a held trigger does. Slow
weapons never accumulate a streak at all, so the shotgun and the sniper are untouched. And coming out
of a sprint the gun has to come up first — 0.2 s before the first round leaves — so a deathmatch is
not decided by who sprinted around the corner with the trigger already down.

## Armour, and the answer to it

Two heavy types turn up from wave 8: **WARDEN**, which closes to 3 m and stomps for 42 in a 4.6 m
ring after a visible 0.7 s wind-up, and **SIEGE**, which holds 14–24 m out and lobs shells on a real
ballistic arc. Both are slow, and both wear plate that takes **8%** from bullets.

That is deliberately not immunity. Two places take full damage: the visor, and the orange power pack
on the back — which is a hit sphere sitting behind the torso, so putting the crosshair on the body
only reaches it from behind. No facing check does this; the ray simply meets the plate first from any
other angle. (From directly abeam you can still reach the pack by aiming a little *behind* the body,
which is a shot you have to know about rather than one you fall into.) A sniper round into the pack
is 3.5× and brings a warden down in two. Explosives ignore the plate entirely.

So the rocket launcher is an *answer* to armour rather than a *prerequisite* for it, which matters,
because it only drops from armoured kills — the first one always drops a tube, and after that it is
40% rocket, 35% ammo, 25% health. One round in the tube, a two-second reload, 50 m/s so a moving
target can walk out of it, and no direct-hit damage at all: the blast is the whole weapon. It lands
in slot 5 and does not exist until you find one — no slot on the HUD, and the scroll wheel walks
past it.

## Layout

```
index.html      importmap points at vendor/, no external <script>
server.js       static files + rooms + WebSocket, zero dependencies
src/            game source
  net.js        client transport
  nav.js        navigation grid and A*
  enemies.js    enemy AI, spawning, replication
  main.js       game loop, lobby and HUD wiring
vendor/         three.js, BufferGeometryUtils, the font
```

There is no build step: `index.html` loads `src/main.js` as a native ES module and resolves `three`
through an import map. Edit a file, hit reload. [`AGENTS.md`](AGENTS.md) is the guide for anyone —
person or agent — making changes, and covers the conventions that the rest of the code assumes.

## A word on running it in public

A room server has **no authentication of any kind**. Anyone who can reach the port can join, host,
and be handed authority over the enemies and the wave clock. That is exactly right on a LAN, which
is what it was built for, and it is not right on a public address.

## Credits and licence

The game this grew out of is [doodleshooter.vercel.app](https://doodleshooter.vercel.app); the look,
the premise and the original of a good deal of this belong to its author. What is here is a rebuild
around a LAN: the peer-to-peer transport replaced with a relay server, server-side hit judging with
latency rewound out, phone controls, localisation, difficulty and mobility ladders, a second map, and
a lot of feel work on top.

The project is licensed under [GPL-3.0](LICENSE). Everything under `vendor/` is third-party and keeps
its own licence — see [`vendor/NOTICE.md`](vendor/NOTICE.md).

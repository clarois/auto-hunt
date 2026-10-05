# Auto-Hunt v4.3 (skill-preset + auto-teleport edition)

Auto-Hunt [v4.1](https://github.com/Flux159/ragnarokoffline.app) — on-screen button, `,` to toggle,
auto-heal `.`, warp avoidance, stuck recovery — **plus per-player skill presets**, so the character
fights with *its* skills instead of physical swings only — **plus auto-teleport**, so an empty corner
of the map no longer ends your AFK session.

> **Migrating from `auto-hunt-v4.2`?** This registry release renames the mod id to **`auto-hunt`**
> (folder name = mod name, as the registry requires). It installs as a *new* mod: re-enable it in
> Settings → Mods, re-pick your preset in the dropdown, and re-check the Settings values. Your hotbar
> assignments persist per character server-side, and your old `presets.json` can be copied over.

No server rebuild. The mod is client-side: it uses the app's official plugin actions
(`shortcut:assign` + `shortcut`) — exactly the native callbacks a manual hotbar drag/keypress goes
through, and rAthena still enforces cooldowns, SP costs, levels, range and targeting.

## What this version adds over v4.1

| | behavior |
|---|---|
| Preset dropdown (in the on-screen panel) | pick one of your characters' skill lists from `client/presets.json` |
| Auto-assignment | the chosen character's first 9 skills are placed onto hotbar slots **27–35** (`ASDFGHJKL`) server-side — they persist for that character like any real hotbar setup you'd drag yourself |
| Combat loop | each scan tick (default 800 ms): press attack skills on their cadence (default every 1.5 s) *while a monster has focus*, interleaved with the continuous physical `attackNearest()`; support skills (heals/buffs recognized by name) refresh on a long cycle (default 30 s), even without a target in front |
| Targeted-skill auto-casting | while a preset hunt runs, the mod turns ON the client's built-in **touch-targeting mode** so every pressed *enemy/offensive*-target skill completes directly against the monster that has focus — no aim cursor, no manual click. It restores your previous setting when you stop hunting or drop the preset (see Troubleshooting for what this does to ground/place and party/friend-target spells) |
| SP guard | no skill presses when SP is below 25 % — server would reject them anyway |
| Auto-Teleport (opt-in) | when *nothing* has been in range for `teleport_idle_ms` (default 6 s) while hunting, the mod presses one hotbar slot you nominated — a **Fly Wing** or the **Teleport** skill — so the character jumps to a fresh spot instead of circling an empty map. Toggle with `;` or the panel button; off by default |
| Physical-only mode | leave the dropdown on **No skill preset** → identical to v4.1 |

## Building YOUR presets (copy-paste workflow)

`presets.json` ships **empty** on purpose — each player makes their own loadout:

1. Open `client/skill-list.json`. It contains *every* learnable skill on this server, grouped by
   job tree (Base, Job 1…Job 4, plus the custom classes), with `{name, id, type, desc}`.
2. Find your class and pick the skills you want.
3. Paste their lines into `client/presets.json`, **as-is, whole entry included** — extra fields
   (`type`, `desc`) are ignored, only `name` and `id` are read. Put them under an entry named
   **exactly like your character**:

   ```json
   {
     "mara": [
       { "name": "AB_CANTO", "id": 2042, "type": "Magic", "desc": "Canto Candidus" },
       { "name": "CD_REPARATIO", "id": 5268, "type": "Magic", "desc": "Reparatio" }
     ]
   }
   ```

   `client/presets.example.json` shows the exact shape.
4. **Order = hotbar slot.** Entry 1 → slot 27 (`A`), entry 9 → slot 35 (`L`). Put buffs/heals first,
   damage skills last. Only the first 9 are armed; anything your character hasn't learned is skipped
   silently by the server (extra lines do no harm).
5. Restart the app. Your character appears in the dropdown top-left.

If you keep offlineslaveclone-style per-player `.txt` whitelists, `tools/make_presets.py` can convert
them straight to `presets.json`:

```
python tools\make_presets.py "<offlineslaveclone skills folder>" "<server db/re/skill_db.yml>"
```

…and if your server's skill DB ever changes, regenerate the reference list:

```
python tools\make_skill_list.py "<server db/re/skill_db.yml>" client/skill-list.json
```

## Auto-teleport (AFK quality of life)

An empty patch of map is the worst case for AFK farming: the hunt keeps wandering and you earn
nothing. Auto-teleport turns that into "jump somewhere with monsters":

1. Put a **Fly Wing** (or the **Teleport** skill) on a hotbar slot — e.g. `Q`, which is slot `18`.
2. Set `teleport_slot_index` to that slot in Settings → Mods (default `18`), and turn
   `auto_teleport_enabled` on — or simply press `;` / click **Auto-Teleport** in the panel.
3. Play as usual. While a hunt runs and nothing has been in range for `teleport_idle_ms`, the slot is
   pressed, the character jumps, and the exploration memory resets so the new area is searched fresh.

Worth knowing:

- The mod only *presses the slot* — the **server** decides whether the wing/skill fires (item count,
  SP, cast delay). An empty slot is a harmless no-op, which is exactly why it ships **off**: check
  what's on that slot first.
- One attempt per `teleport_cooldown_ms`, so landing in another empty area costs a single extra wing,
  not a burst of them.
- Use Fly Wing or Teleport **level 1** (random spot, same map). Teleport level 2 sends you to your
  save point — that's a map change, and the mod stops the hunt on a map change by design.
- If a jump happens to land you on a warp and you end up on another map, the hunt stops (same safety
  rule as walking into a warp); it never keeps hunting somewhere you didn't start it.

## Install / update

1. Settings → Mods: turn **off** `auto-hunt-v4.1` / `auto-hunt-v4.2` if present, turn **on** `auto-hunt`.
2. Apply / restart the app — the whole *app* must restart for `client/` changes, not just the server.
3. Log in as the character whose preset you want and pick it from the dropdown (persists per browser).
   You'll see `Arming preset <name>…`, then `Preset <name>: N skill(s) armed`.
4. `,` or the Auto-Hunt button — watch it swing *and* cast on its hotbar row while you're out of range
   of keyboard reach. `.` toggles Auto-Heal, `;` toggles Auto-Teleport (see the section above).

**Re-arm behavior:** assignments are applied once per character session; if something ever clears them,
the mod detects an empty bookkeeping and re-arms within a couple of ticks.

## Layout collision warning

The 9 auto-assigned slots are **ASDFGHJKL** — if you use that row for your own shortcuts on the same
character, they get overwritten slot by slot (preset entry order = slot order). Put your manual skills /
heal items on a different row; the Auto-Heal hotbar slot default is `9` and the Auto-Teleport default
is `Q` (slot 18) — both safe.

## Tuning (Settings → Mods)

| setting | meaning |
|---|---|
| `skill_cast_interval_ms` | attack-skill press cadence (default 1500 ms; the server's real cooldowns still gate what actually fires) |
| `buff_refresh_ms` | support/buff press cadence (default 30000 ms) |
| `teleport_slot_index` | hotbar slot the auto-teleport presses — Fly Wing / Teleport (default 18 = `Q`) |
| `teleport_idle_ms` | how long with nothing in range before teleporting (default 6000 ms) |
| `teleport_cooldown_ms` | minimum gap between auto-teleports (default 6000 ms) |
| `teleport_toggle_key_code` | Auto-Teleport toggle key (default `Semicolon` = `;`) |

## Troubleshooting

- **Dropdown only shows "No skill preset"** → your `presets.json` is empty or failed to load — check
  browser console for `[auto-hunt] presets loaded…`.
- **"no resolvable skills"** → every entry in that character's list has `"id": null` (skill names don't
  exist on this server). Check spellings against `client/skill-list.json`; the server is what counts,
  not classic/pre-re numbering.
- **A skill never fires in game** → it's on cooldown / out of SP / not learned at a usable level, or needs
  a target selection the focused-monster cast can't satisfy. Server is authoritative; the mod only
  *offers* presses. Console shows armed-vs-skipped counts per preset arm.
- **Ground/place-target spells** (fire wall/floor, ice rod floors, anything you'd normally aim at the ground)
  cannot auto-cast unattended: if pressed they enter aim mode and the mod cancels it a moment later, so
  nothing fires. Leave them out of presets or cast them by hand. Enemy-target skills (cold bolt, soul storm,
  …) **do** auto-fire on the focused monster since v4.2 — that was the mage-test "aim cursor stuck" fix: while
  a preset hunt runs the mod turns on the client's built-in touch-targeting mode and restores it afterwards.
- **Party/friend-target support spells** (heals or buffs you'd normally cast on an *ally*): touch-targeting makes
  any non-ground targeted press complete at whatever has focus — which during a hunt is your monster, not your
  party member. The server then rejects the miss, so it costs nothing harmful but also does nothing for your ally:
  they won't auto-refresh while botting. Keep self-buffs (Energy Coat, Canto, …) in presets; cast multi-party heals
  and buffs by hand. The built-in auto-heal (`.`) is unaffected — its heal casts on *you* instantly.
- **Auto-teleport never fires** → it's **off by default**: check the panel button reads ON and that
  `teleport_slot_index` really holds a Fly Wing / Teleport skill. It only acts while Auto-Hunt is
  running *and* nothing has been in range for `teleport_idle_ms`. Console line to look for:
  `[auto-hunt] auto-teleport: pressed hotbar slot N after Ns with nothing in range`.
- **Character name shown with `%s`?** — cosmetic only; unrelated to this mod (it comes from your
  `DB.getMessage(1361)` translation file).

## Files

```
auto-hunt/
├── client/index.js            v4.1 core + skill-preset engine
├── client/presets.json        { character: [{ name, id }, ...] } — ships EMPTY; you fill it in
├── client/presets.example.json  shape reference with sample entries
├── client/skill-list.json     every skill on the server, grouped by job (copy from here)
├── client/warps.json          unchanged from v4.1
├── mod.json
└── tools/
    ├── make_presets.py        offlineslaveclone .txt whitelists → presets.json
    └── make_skill_list.py     server skill_db.yml → the reference skill-list.json
```

## Credits

- **Auto-Hunt v4.1** (hunting core: wander, warp avoidance, stuck recovery, auto-heal) by **Thomas**,
  bundled with [Flux159/ragnarokoffline.app](https://github.com/Flux159/ragnarokoffline.app).
- **Skill presets (v4.2), targeted-skill auto-casting, auto-teleport (v4.3), skill-list tooling** by
  **clarois**.
- Server remains authoritative for cooldowns, SP, range and targeting (rAthena).

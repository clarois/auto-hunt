// Auto-Hunt v4.2: attacks the nearest monster on a loop and walks around to find
// one when nothing's nearby, so a character can farm unattended. Built on
// the app's own client plugin API -- the same functions wasd-movement uses
// for its spacebar attack and WASD movement, just called on a timer instead
// of a keypress. No server changes.
//
// --- v4.2 addition: per-player skill presets ("mixed" auto-hunt) ---
//
// The hunting core is unchanged from v4.1 (see that file's header for the full
// movement/warp/stuck-recovery design). On top of it, each character can get a
// personal combat loadout: an ordered list of Aegis skill NAMES taken from the
// same per-player whitelists your @offlineslaveclone GM command uses
// (one .txt per character), pre-resolved to numeric SKIDs against YOUR server's
// renewal db/re/skill_db.yml into presets.json, which ships with this mod.
//
// How it works at runtime:
//   1. You pick a preset from the small dropdown in this mod's on-screen panel
//      (persisted per-browser via api.preferences).
//   2. The mod assigns that character's first N skills to hotbar slots on the
//      last hotbar row (slots 27-35, keys ASDFGHJKL) using the official
//      api.actions.perform('shortcut:assign', { slot, kind: 'skill', id }) --
//      the same native callback a manual in-game drag uses. Server-side it is
//      real hotbar state, so it persists across relogs for that character.
//   3. On every scan tick, while hunting: support skills (buffs/heals, by name)
//      are pressed on their own long refresh cadence; attack skills are pressed
//      whenever a monster has target focus, interleaved with the physical
//      attackNearest() stream -- i.e. the character fights exactly like it would
//      if you spammed its hotbar keys yourself: swing, skill, swing, skill.
//   4. The server remains authoritative for everything: cooldowns, SP costs,
//      learned levels, range and targeting are all enforced by rAthena; the mod
//      only dispatches the same native "press this hotbar slot" action a human
//      would. A pressed skill that's on cooldown or lacks SP simply does not
//      fire server-side -- no packet spam beyond one request per cadence tick.
//   5. If assignments are ever missing (fresh log-in, preset switch), the mod
//      re-arms itself automatically within a second or two; if your server has
//      custom plugin skills with no ID in skill_db.yml they appear as skipped
//      (id: null) -- map them by hand, see tools/make_presets.py --manual.
//
// Honest limits: the client API exposes neither inventory nor hotbar contents
// (api.snapshot() is position/HP/SP/target only), so this cannot *read* what a
// slot holds; it assigns skills and presses slots, like you would by hand.
// Skills that require explicit target selection beyond "nearest monster has
// focus" work for single-target/splash casts on the focused mob -- same as
// pressing their hotbar keys in game.
//
// --- v4.3 addition: auto-teleport out of empty areas ---
// While a hunt runs and nothing has been in range for `teleport_idle_ms`, the mod presses
// one hotbar slot of your choosing -- put a Fly Wing (item) or the Teleport skill there.
// Instead of walking in circles the character jumps somewhere fresh and keeps finding
// monsters, which is what makes long AFK sessions level faster. It ships OFF because it can
// spend consumables: toggle it with its own key or the panel button, exactly like Auto-Heal.

export default function init(parameters, api) {
	if (api?.version !== 1) throw new Error('auto-hunt requires client API 1');

	const settings = {
		lowHpStopPercent: Number(parameters?.low_hp_stop_percent ?? 30),
		scanIntervalMs: Number(parameters?.scan_interval_ms ?? 800),
		toggleKeyCode: /^[A-Za-z0-9]+$/.test(String(parameters?.toggle_key_code ?? ''))
			? String(parameters.toggle_key_code)
			: 'Comma',
		healToggleKeyCode: /^[A-Za-z0-9]+$/.test(String(parameters?.heal_toggle_key_code ?? ''))
			? String(parameters.heal_toggle_key_code ?? '')
			: 'Period',
		healHpPercent: Number(parameters?.heal_hp_percent ?? 50),
		healSlotIndex: (() => {
			const n = Number(parameters?.heal_slot_index ?? 17);
			return Number.isInteger(n) && n >= 0 && n <= 35 ? n : 17;
		})(),
		healCooldownMs: Math.max(500, Number(parameters?.heal_cooldown_ms ?? 2000)),
		// --- v4.2 skill-preset settings ---
		activePresetName: String(parameters?.active_preset ?? ''),
		skillCastIntervalMs: Math.max(250, Number(parameters?.skill_cast_interval_ms ?? 1500)),
		buffRefreshMs: Math.max(5000, Number(parameters?.buff_refresh_ms ?? 30000)),
		// --- v4.3 auto-teleport settings ---
		teleportToggleKeyCode: /^[A-Za-z0-9]+$/.test(String(parameters?.teleport_toggle_key_code ?? ''))
			? String(parameters.teleport_toggle_key_code)
			: 'Semicolon',
		teleportSlotIndex: (() => {
			const n = Number(parameters?.teleport_slot_index ?? 18);
			return Number.isInteger(n) && n >= 0 && n <= 35 ? n : 18;
		})(),
		teleportIdleMs: Math.max(1000, Number(parameters?.teleport_idle_ms ?? 6000)),
		teleportCooldownMs: Math.max(1000, Number(parameters?.teleport_cooldown_ms ?? 6000)),
	};

	const PERIODIC_REDIRECT_MS = 5000;
	const STUCK_TICKS_THRESHOLD = 2;
	const STUCK_MOVE_EPSILON = 1;
	const CLEAR_MOVE_EPSILON = 3;
	const BUCKET_SIZE = 8;
	const CANDIDATE_COUNT = 8;
	const PROBE_DISTANCE = 15;
	const SECTOR_COUNT = 8;
	const SECTOR_JITTER = Math.PI / SECTOR_COUNT / 2;
	const BLOCKED_HEADING_TTL_MS = 90000;
	const WARP_CHECK_DISTANCE = 40;
	const WARP_CHECK_SAMPLES = 14;
	const WARP_DANGER_MARGIN = 5;

	const REENTRY_TIMEOUT_MS = 10000; // how long to wait for map:enter after map:leave before assuming something went wrong and stopping for safety

	// --- v4.2 skill-preset machinery ---
	const SKILL_SLOT_ROW = 3; // last hotbar row (ASDFGHJKL) gets the auto-assigned skills -- leave it free of your own shortcuts or they'll be overflown slot by slot
	const skillSlots = Array.from({ length: 9 }, (_, i) => SKILL_SLOT_ROW * 9 + i); // slots 27..35
	// One deliberate assignment after another, not a burst: the ShortCut component
	// applies each through its own onChange callback and a short gap keeps the
	// native UI honest under rapid succession.
	const ASSIGN_GAP_MS = 120;
	// Don't spend casts while SP is nearly empty -- the server would reject most of
	// them anyway, and this avoids burning ticks on guaranteed failures.
	const SP_RESERVE_FRACTION = 0.25;
	// Skills treated as "support" (press on a long refresh cadence whether or not
	// a monster is in front of you). Anything not listed here is pressed with the
	// short attack cadence and only while a target has focus. Extend this set if
	// your presets use buffs with unusual names -- unknowns default to attack.
	const SUPPORT_NAMES = new Set([
		'AB_CHEAL', 'CD_REPARATIO', 'CD_DILECTIO_HEAL', // heals (targeted/area, pressed like a heal hotbar)
		'CD_ARGUTUS_VITA', 'CD_ARGUTUS_TELUM', 'CD_PRESENS_ACIES', 'CD_COMPETENTIA',
		'CD_RELIGIO', 'CD_BENEDICTUM', 'AB_CLEMENTIA', 'AB_CANTO', 'AB_PRAEFATIO',
		'AB_EXPIATIO', 'AB_SACRAMENT', // resist/crit/stat buffs (Cardinal/Arch Bishop)
		'ALL_FULL_THROTTLE', 'LK_CONCENTRATION', 'MG_ENERGYCOAT', // generic support
	]);

	let presets = null; // { characterName: [{ name, id }, ...] } from presets.json (id null = unresolved custom skill)
	let activePreset = api.preferences.get('activePreset', settings.activePresetName);
	if (typeof activePreset !== 'string' || !/^[A-Za-z0-9_\-]+$/.test(activePreset)) activePreset = '';
	let assignments = []; // [{ slot, id, name }] -- only successfully-assigned slots, in preset file order
	let assigning = false;
	const lastCastAt = new Map(); // hotbar slot -> timestamp of the mod's last press

	// Same load pattern as warps.json below: resolve relative to this module so we
	// never guess at the app's URL scheme.
	const presetsUrl = new URL('presets.json', import.meta.url).href;
	fetch(presetsUrl)
		.then((res) => {
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return res.json();
		})
		.then((data) => {
			presets = data;
			if (activePreset && !presets[activePreset]) activePreset = ''; // preset not in the shipped list
			populatePresetSelect(activePreset);
			console.log(`[auto-hunt] presets loaded from ${presetsUrl}: ${Object.keys(data).length} character(s)`);
		})
		.catch((err) => {
			presets = {}; // carry on as pure-physical hunting rather than break the mod
			populatePresetSelect('');
			console.error(`[auto-hunt] failed to load presets from ${presetsUrl}:`, err);
		});

	const startAssigning = () => {
		if (assigning || !activePreset || !presets) return;
		const list = (presets[activePreset] || []).filter((s) => s.id);
		if (!list.length) {
			status.textContent = `Preset ${activePreset}: no resolvable skills in presets.json.`;
			return;
		}
		assigning = true;
		status.textContent = `Arming preset ${activePreset}...`;
		(async () => {
			assignments = [];
			const skipped = [];
			for (let i = 0; i < list.length; i++) {
				if (i >= skillSlots.length) {
					skipped.push(`${list[i].name} (no slot -- first ${skillSlots.length} skills only)`);
					continue;
				}
				const slot = skillSlots[i];
				const ok = api.actions.perform('shortcut:assign', { slot, kind: 'skill', id: list[i].id });
				if (ok) assignments.push({ slot, id: list[i].id, name: list[i].name });
				else skipped.push(list[i].name);
				await new Promise((resolve) => setTimeout(resolve, ASSIGN_GAP_MS));
			}
			assigning = false;
			console.log(`[auto-hunt] preset ${activePreset}: armed ${assignments.length}/${list.length}` + (skipped.length ? `; skipped: ${skipped.join(', ')}` : ''));
			status.textContent = assignments.length
				? `Preset ${activePreset}: ${assignments.length} skill(s) armed${skipped.length ? ' -- see console' : ''}`
				: `Preset ${activePreset}: nothing could be armed`;
		})().catch((err) => {
			assigning = false;
			console.error('[auto-hunt] preset assignment failed:', err);
		});
	};

	// Presses the mod-assigned hotbar slots on their cadences, only when a preset
	// is armed. Called from scanTick each tick (i.e. every scanIntervalMs while
	// Auto-Hunt runs): support skills refresh on buffRefreshMs whether or not a
	// monster stands in front of us; attack skills fire only while the focused
	// target still exists, interleaved with the physical attacks. The native
	// EXECUTE callback does what your own hotbar keypress would do -- including
	// honoring server-side cooldowns and SP checks.
	const castSkills = (snap) => {
		if (!assignments.length) return;
		const now = Date.now();
		const player = snap.player;
		if (player.maxSp > 0 && player.sp / player.maxSp < SP_RESERVE_FRACTION) return; // no cast spam when nearly OOMed on SP
		for (const a of assignments) {
			const isSupport = SUPPORT_NAMES.has(a.name);
			if (!isSupport && !snap.target) continue; // attack skills need the focused monster to exist
			const interval = isSupport ? settings.buffRefreshMs : settings.skillCastIntervalMs;
			if (now - (lastCastAt.get(a.slot) ?? 0) < interval) continue;
			lastCastAt.set(a.slot, now);
			api.actions.perform('shortcut', { index: a.slot });
		}
	};

	// --- v4.2x: completing targeted casts (the "aim cursor" problem) ----------
	// Pressing a hotbar slot for an enemy-targeted skill makes the client enter aim mode
	// (SkillTargetSelection): it freezes your cursor into the targeting reticle and waits
	// for YOU to click a monster before the cast actually goes out. A human never notices;
	// unattended, that's exactly why offensive preset skills "just triggered and changed my
	// cursor to targeting" instead of hitting anything.
	// The client ships an escape hatch: when touch-targeting mode (SessionStorage.TouchTargeting --
	// the MobileUI ⚙️ button) is ON, SkillTargetSelection.set() completes the cast IMMEDIATELY
	// against whatever entity currently has focus and never shows the aim cursor at all. Since
	// attackNearest() already keeps "the nearest living mob" as the focused entity every tick,
	// targeted skills then auto-snap + fire on that same monster -- exactly what a hand would do.
	// We flip that toggle ON while a preset is armed (by clicking the real MobileUI button through
	// its open shadow root) and restore it when hunting stops or the preset is dropped, so manual
	// play feels unchanged afterwards. Place/ground-targeted spells are deliberately NOT in that
	// auto-complete branch; they'd freeze aim mode forever if pressed while unattended -- the little
	// watch below cancels any such stuck state via the client's own Escape handling so it can never
	// jam your input (keep those skills out of presets, or cast them by hand).
	const AIM_GRACE_MS = 400; // a genuine targeted auto-cast completes almost instantly; longer than this = stuck
	let touchWeEnabled = false; // we flipped the client's toggle ON -> must restore it on stop/preset-drop
	let aimSeenAt = 0;
	const touchTargetButton = () => {
		for (const c of api.components.current()) if (c.name === 'MobileUI' && c.root) return c.root.querySelector('#toggleTargetingButton');
		return null; // MobileUI not mounted yet -- retry on a later tick
	};
	const ensureTouchTargetingOn = () => {
		if (touchWeEnabled) return;
		const btn = touchTargetButton();
		if (!btn) return;
		if (btn.classList.contains('active')) return; // user already runs with it -- don't clobber their setting
		btn.click();
		touchWeEnabled = true;
		console.log('[auto-hunt] enabled the client\'s touch-targeting mode so targeted preset skills auto-cast on the focused monster');
	};
	const restoreTouchTargeting = () => {
		if (!touchWeEnabled) return;
		touchWeEnabled = false;
		const btn = touchTargetButton();
		if (btn && btn.classList.contains('active')) btn.click(); // back to whatever it was before we started
	};
	const cancelStuckAimMode = () => {
		if (!document.getElementById('SkillTargetSelection')) { aimSeenAt = 0; return; } // not in aim mode
		const now = Date.now();
		if (!aimSeenAt) { aimSeenAt = now; return; }
		if (now - aimSeenAt < AIM_GRACE_MS) return; // give it a moment -- targeted auto-casts clear near-instantly
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true })); // client's own Escape handler drops targeting
		console.warn('[auto-hunt] a pressed skill stayed in aim mode (ground/place-target skills can\'t auto-cast) -- cancelled it; press it by hand if you want that one');
	};

	// --- v4.3 auto-teleport state (opt-in: it can spend Fly Wings, so default OFF) ---
	let teleportEnabled = Boolean(api.preferences.get('autoTeleport', parameters?.auto_teleport_enabled === true));
	let lastTeleportAt = 0;
	let noTargetSince = 0; // when the current "nothing in range" stretch began (0 = a monster is/was in range)

	let healEnabled = Boolean(api.preferences.get('autoHeal', parameters?.auto_heal_enabled !== false));
	let lastHealAt = 0;
	let healTimer = null;

	let enabled = false;
	let timer = null;
	let wandering = false;
	let lastKnownMap = null; // map name as of the last confirmed map:enter (or start())
	let awaitingReentry = false; // true between a map:leave and its matching map:enter
	let reentryTimer = null;
	let currentAngle = null;
	let wanderChangedAt = 0;
	let lastTickPosition = null;
	let stuckTicks = 0;
	let stuckEpisode = false; // true from the first stuck redirect until we're confirmed moving freely again
	const sectorTriedAt = new Array(SECTOR_COUNT).fill(-Infinity); // per-compass-direction, when it was last tried while stuck
	const visited = new Map(); // "bucketX,bucketY" -> last-visited timestamp
	const blockedHeadings = new Map(); // "bucketX,bucketY|sector" -> when that heading last failed from about there

	let allWarps = null; // { mapName: [[x, y, spanx, spany], ...], ... }, loaded once
	let mapWarps = []; // warps for the current map only

	const warpsUrl = new URL('warps.json', import.meta.url).href;
	fetch(warpsUrl)
		.then((res) => {
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return res.json();
		})
		.then((data) => {
			allWarps = data;
			refreshMapWarps();
			console.log(`[auto-hunt] warp data loaded from ${warpsUrl}: ${Object.keys(data).length} maps`);
		})
		.catch((err) => {
			allWarps = {}; // warp data failed to load -- carry on without avoidance rather than break the mod
			console.error(`[auto-hunt] failed to load warp data from ${warpsUrl}:`, err);
		});

	const refreshMapWarps = () => {
		const mapName = api.snapshot().map;
		mapWarps = (allWarps && mapName && allWarps[mapName]) || [];
		console.log(`[auto-hunt] ${mapName}: ${mapWarps.length} known warp(s)`);
	};

	const distanceToWarp = (x, y, warp) => {
		const [wx, wy, spanx, spany] = warp;
		const dx = Math.max(Math.abs(x - wx) - spanx, 0);
		const dy = Math.max(Math.abs(y - wy) - spany, 0);
		return Math.hypot(dx, dy);
	};

	const nearestWarp = (x, y, margin) => {
		let nearest = null;
		let nearestDist = Infinity;
		for (const warp of mapWarps) {
			const dist = distanceToWarp(x, y, warp);
			if (dist <= margin && dist < nearestDist) {
				nearest = warp;
				nearestDist = dist;
			}
		}
		return nearest;
	};

	const pathCrossesWarp = (position, angle) => {
		if (!mapWarps.length) return false;
		for (let i = 1; i <= WARP_CHECK_SAMPLES; i++) {
			const t = (i / WARP_CHECK_SAMPLES) * WARP_CHECK_DISTANCE;
			const x = position[0] + Math.cos(angle) * t;
			const y = position[1] + Math.sin(angle) * t;
			if (nearestWarp(x, y, WARP_DANGER_MARGIN)) return true;
		}
		return false;
	};

	const source = api.movement.register('auto-hunt', () => {
		wandering = false;
	});

	const bucketKey = (x, y) => `${Math.floor(x / BUCKET_SIZE)},${Math.floor(y / BUCKET_SIZE)}`;
	const sectorOf = (angle) => {
		const normalized = ((angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
		return Math.round(normalized / ((Math.PI * 2) / SECTOR_COUNT)) % SECTOR_COUNT;
	};

	const recordVisit = (position) => {
		visited.set(bucketKey(position[0], position[1]), Date.now());
	};

	const recordBlockedHeading = (position, angle) => {
		blockedHeadings.set(`${bucketKey(position[0], position[1])}|${sectorOf(angle)}`, Date.now());
	};

	const isHeadingBlocked = (position, angle) => {
		const seenAt = blockedHeadings.get(`${bucketKey(position[0], position[1])}|${sectorOf(angle)}`);
		return seenAt !== undefined && Date.now() - seenAt < BLOCKED_HEADING_TTL_MS;
	};

	const chooseExploreDirection = (position) => {
		const now = Date.now();
		let candidates = [];
		for (let i = 0; i < CANDIDATE_COUNT; i++) {
			const angle = (i / CANDIDATE_COUNT) * Math.PI * 2 + (Math.random() - 0.5) * (Math.PI / CANDIDATE_COUNT);
			candidates.push(angle);
		}
		const safe = candidates.filter((angle) => !pathCrossesWarp(position, angle));
		if (safe.length) candidates = safe;
		const clear = candidates.filter((angle) => !isHeadingBlocked(position, angle));
		if (clear.length) candidates = clear;
		let best = null;
		let bestScore = -Infinity;
		for (const angle of candidates) {
			const probeX = position[0] + Math.cos(angle) * PROBE_DISTANCE;
			const probeY = position[1] + Math.sin(angle) * PROBE_DISTANCE;
			const lastVisit = visited.get(bucketKey(probeX, probeY));
			const staleness = lastVisit ? now - lastVisit : Number.MAX_SAFE_INTEGER;
			const score = staleness + Math.random() * 1000;
			if (score > bestScore) {
				bestScore = score;
				best = angle;
			}
		}
		return { dx: Math.cos(best), dy: Math.sin(best), angle: best };
	};

	const chooseStuckDirection = (position) => {
		const sectorAngle = (index) => (index / SECTOR_COUNT) * Math.PI * 2 + (Math.random() - 0.5) * SECTOR_JITTER * 2;
		const order = [...sectorTriedAt.keys()].sort((a, b) => sectorTriedAt[a] - sectorTriedAt[b]);
		for (const index of order) {
			const angle = sectorAngle(index);
			if (!pathCrossesWarp(position, angle) && !isHeadingBlocked(position, angle)) {
				return { dx: Math.cos(angle), dy: Math.sin(angle), angle, sector: index };
			}
		}
		for (const index of order) {
			const angle = sectorAngle(index);
			if (!pathCrossesWarp(position, angle)) {
				return { dx: Math.cos(angle), dy: Math.sin(angle), angle, sector: index };
			}
		}
		const index = order[0];
		const angle = sectorAngle(index);
		return { dx: Math.cos(angle), dy: Math.sin(angle), angle, sector: index };
	};

	const beginWander = (position) => {
		const { dx, dy, angle } = chooseExploreDirection(position);
		if (source.begin(dx, dy)) {
			wandering = true;
			currentAngle = angle;
			wanderChangedAt = Date.now();
			stuckTicks = 0;
			status.textContent = 'Nothing nearby, wandering...';
		}
	};

	const redirectWander = (position) => {
		const { dx, dy, angle } = chooseExploreDirection(position);
		source.update(dx, dy);
		currentAngle = angle;
		wanderChangedAt = Date.now();
		stuckTicks = 0;
	};

	const redirectStuck = (position) => {
		stuckEpisode = true;
		const { dx, dy, angle, sector } = chooseStuckDirection(position);
		sectorTriedAt[sector] = Date.now();
		source.update(dx, dy);
		currentAngle = angle;
		wanderChangedAt = Date.now();
		stuckTicks = 0;
		status.textContent = 'Stuck, trying another way...';
	};

	const steerAwayFrom = (position, warp) => {
		const angle = Math.atan2(position[1] - warp[1], position[0] - warp[0]);
		if (wandering) source.update(Math.cos(angle), Math.sin(angle));
		else if (source.begin(Math.cos(angle), Math.sin(angle))) wandering = true;
		currentAngle = angle;
		wanderChangedAt = Date.now();
		stuckTicks = 0;
		status.textContent = 'Too close to a warp, backing away...';
	};

	// --- v4.3: auto-teleport out of empty areas ---------------------------------
	// "Nothing nearby" means this spot has no monsters: left alone the character just
	// walks in circles. With auto-teleport on we instead press ONE hotbar slot you
	// nominated (Fly Wing item or the Teleport skill) to jump somewhere fresh, then drop
	// the old exploration bookkeeping so the wander logic starts clean in the new spot.
	// Same native mechanism as Auto-Heal -- a plain "press this hotbar slot" action, so
	// the server still decides whether the wing/skill actually fires (item count, SP,
	// cast delay); an empty slot simply does nothing.
	const maybeAutoTeleport = () => {
		if (!teleportEnabled) {
			noTargetSince = 0;
			return false;
		}
		const now = Date.now();
		if (!noTargetSince) {
			noTargetSince = now; // first tick with nothing in range -- start the idle clock
			return false;
		}
		if (now - noTargetSince < settings.teleportIdleMs) return false;
		if (now - lastTeleportAt < settings.teleportCooldownMs) return false;
		lastTeleportAt = now;
		noTargetSince = now; // restart the clock so the slot is never pressed twice in a row
		api.actions.perform('shortcut', { index: settings.teleportSlotIndex });
		visited.clear();
		blockedHeadings.clear();
		sectorTriedAt.fill(-Infinity);
		stuckTicks = 0;
		stuckEpisode = false;
		lastTickPosition = null;
		if (wandering) {
			source.end();
			wandering = false;
		}
		const idleSeconds = Math.round(settings.teleportIdleMs / 1000);
		status.textContent = `Nothing nearby for ${idleSeconds}s, teleporting...`;
		console.log(`[auto-hunt] auto-teleport: pressed hotbar slot ${settings.teleportSlotIndex} after ${idleSeconds}s with nothing in range`);
		return true;
	};

	const KEY_DISPLAY_NAMES = { Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'",
		BracketLeft: '[', BracketRight: ']', Backquote: '`', Minus: '-', Equal: '=', Space: 'Space' };
	const keyLabel = KEY_DISPLAY_NAMES[settings.toggleKeyCode]
		?? settings.toggleKeyCode.replace(/^Key/, '').replace(/^Digit/, '');
	const healKeyLabel = KEY_DISPLAY_NAMES[settings.healToggleKeyCode]
		?? settings.healToggleKeyCode.replace(/^Key/, '').replace(/^Digit/, '');
	const teleportKeyLabel = KEY_DISPLAY_NAMES[settings.teleportToggleKeyCode]
		?? settings.teleportToggleKeyCode.replace(/^Key/, '').replace(/^Digit/, '');
	const render = () => {
		button.textContent = `Auto-Hunt: ${enabled ? 'ON' : 'OFF'} (${keyLabel})`;
		button.classList.toggle('on', enabled);
	};

	const clearReentryWatch = () => {
		awaitingReentry = false;
		if (reentryTimer) {
			clearTimeout(reentryTimer);
			reentryTimer = null;
		}
	};

	const stop = (message) => {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
		restoreTouchTargeting(); // return the client's targeting mode to what it was before this hunt
		if (document.getElementById('SkillTargetSelection')) window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true })); // clear any leftover aim state so manual input is free
		if (wandering) {
			source.end();
			wandering = false;
		}
		enabled = false;
		lastTickPosition = null;
		stuckTicks = 0;
		stuckEpisode = false;
		noTargetSince = 0;
		sectorTriedAt.fill(-Infinity);
		blockedHeadings.clear();
		clearReentryWatch();
		render();
		status.textContent = message || '';
	};

	const healTick = () => {
		const snap = api.snapshot();
		if (!snap.map || !snap.player) return;
		const { player } = snap;
		if (!(player.maxHp > 0 && player.hp / player.maxHp <= settings.healHpPercent / 100)) return;
		const now = Date.now();
		if (now - lastHealAt < settings.healCooldownMs) return;
		lastHealAt = now;
		api.actions.perform('shortcut', { index: settings.healSlotIndex });
		console.log(`[auto-hunt] auto-heal: HP ${Math.round((player.hp / player.maxHp) * 100)}%, pressed hotbar slot ${settings.healSlotIndex}`);
	};

	const startHeal = () => {
		if (healTimer) return;
		healTick();
		healTimer = setInterval(healTick, settings.scanIntervalMs);
	};

	const stopHeal = () => {
		if (healTimer) {
			clearInterval(healTimer);
			healTimer = null;
		}
	};

	const scanTick = () => {
		const snap = api.snapshot();
		if (!snap.map || !snap.player) return;
		const { player, target } = snap;

		if (player.maxHp > 0 && player.hp / player.maxHp <= settings.lowHpStopPercent / 100) {
			stop(`Stopped: HP fell to ${Math.round((player.hp / player.maxHp) * 100)}%.`);
			return;
		}

		// v4.2: skill-preset step -- re-arm if a preset is selected but nothing is
		// armed yet (fresh login, preset switch), then run the cadence presses.
		if (!assigning && activePreset && !assignments.length) startAssigning();
		// While a hunt with an armed preset runs: make targeted skills auto-complete
		// on the focused monster and cancel any aim mode that can't (ground spells).
		// Restored in stop() / when the preset is dropped, so manual play is untouched.
		if (activePreset && assignments.length) {
			ensureTouchTargetingOn();
			cancelStuckAimMode();
		}
		castSkills(snap);

		recordVisit(player.position);

		const attacked = api.actions.attackNearest();
		if (attacked || target) {
			noTargetSince = 0; // something to fight -- the idle clock resets
			wandering = false;
			stuckTicks = 0;
			stuckEpisode = false;
			sectorTriedAt.fill(-Infinity);
			lastTickPosition = player.position;
			status.textContent = target ? `Fighting ${target.name || 'a monster'}...` : 'Hunting...';
			return;
		}

		// v4.3: nothing in range this tick -- if that keeps up, jump somewhere fresh
		if (maybeAutoTeleport()) {
			lastTickPosition = player.position;
			return;
		}

		const closeWarp = nearestWarp(player.position[0], player.position[1], WARP_DANGER_MARGIN);
		if (closeWarp) {
			steerAwayFrom(player.position, closeWarp);
			lastTickPosition = player.position;
			return;
		}

		if (!wandering) {
			beginWander(player.position);
			lastTickPosition = player.position;
			return;
		}

		const dx = lastTickPosition ? player.position[0] - lastTickPosition[0] : Infinity;
		const dy = lastTickPosition ? player.position[1] - lastTickPosition[1] : Infinity;
		const distanceMoved = Math.hypot(dx, dy);
		lastTickPosition = player.position;

		if (distanceMoved < STUCK_MOVE_EPSILON) {
			stuckTicks++;
			if (stuckTicks >= STUCK_TICKS_THRESHOLD) {
				if (currentAngle !== null) recordBlockedHeading(player.position, currentAngle);
				redirectStuck(player.position);
			}
			return;
		}
		stuckTicks = 0;

		if (stuckEpisode && distanceMoved >= CLEAR_MOVE_EPSILON) {
			stuckEpisode = false;
			sectorTriedAt.fill(-Infinity);
		}

		if (Date.now() - wanderChangedAt >= PERIODIC_REDIRECT_MS) {
			redirectWander(player.position);
		}
	};

	const start = () => {
		enabled = true;
		visited.clear();
		blockedHeadings.clear();
		lastTickPosition = null;
		stuckTicks = 0;
		stuckEpisode = false;
		lastTeleportAt = 0;
		noTargetSince = 0;
		sectorTriedAt.fill(-Infinity);
		lastKnownMap = api.snapshot().map;
		clearReentryWatch();
		refreshMapWarps();
		render();
		status.textContent = 'Hunting...';
		scanTick();
		timer = setInterval(scanTick, settings.scanIntervalMs);
	};

	// --- UI ---
	const host = document.createElement('div');
	host.id = 'ragnarok-autohunt-v4.2';
	const root = host.attachShadow({ mode: 'open' });
	root.innerHTML = `<style>
		:host { position:fixed; top:2px; z-index:10001; font:11px system-ui; text-align:left; }
		button, select { display:block; min-height:22px; font:inherit; cursor:pointer; border:1px solid #a09276; border-radius:5px; background:#f6f0df; color:#322b1d; padding:2px 6px; opacity:.85; margin-bottom:2px; }
		button { cursor:pointer; }
		select { cursor:pointer; max-width:170px; }
		button.on { background:#c9f0c9; border-color:#4a9a4a; opacity:1; }
		button:hover, button:focus-visible, select:hover { opacity:1; }
		output { display:block; margin-top:2px; font-size:10px; max-width:180px; color:#222; text-shadow:0 0 3px #fff, 0 0 3px #fff, 0 0 3px #fff; }
	</style>
	<select id="presetSelect" title="Skill preset for the character currently logged in (from presets.json)">
		<option value="">No skill preset</option><option disabled>Loading...</option>
	</select>
	<button id="toggle" aria-pressed="false">Auto-Hunt: OFF</button>
	<button id="healToggle" aria-pressed="false">Auto-Heal: OFF</button>
	<button id="teleportToggle" aria-pressed="false">Auto-Teleport: OFF</button>
	<output></output>`;
	document.body.append(host);
	const presetSelect = root.querySelector('#presetSelect');
	const button = root.querySelector('#toggle');
	const healButton = root.querySelector('#healToggle');
	const teleportButton = root.querySelector('#teleportToggle');
	const status = root.querySelector('output');

	const populatePresetSelect = (selectedValue) => {
		presetSelect.innerHTML = '<option value="">No skill preset</option>';
		for (const name of Object.keys(presets || {}).sort()) {
			const list = presets[name] || [];
			if (!list.some((s) => s && s.id)) continue; // skip characters with no usable skills
			const option = document.createElement('option');
			option.value = name;
			option.textContent = `${name} (${list.length})`;
			presetSelect.append(option);
		}
		presetSelect.value = selectedValue && presets?.[selectedValue] ? selectedValue : '';
	};

	presetSelect.addEventListener('change', () => {
		activePreset = presetSelect.value;
		try { api.preferences.set('activePreset', activePreset); } catch (err) { console.error('[auto-hunt] failed to save preset preference:', err); }
		assignments.length = 0;
		lastCastAt.clear();
		if (activePreset) startAssigning();
		else { status.textContent = 'Skill preset off.'; restoreTouchTargeting(); }
	});

	const position = () => {
		host.style.right = `${Math.round(window.innerWidth / 4)}px`;
	};
	position();
	window.addEventListener('resize', position);

	const toggle = () => {
		if (enabled) stop();
		else start();
	};

	button.addEventListener('click', toggle);

	const renderHeal = () => {
		healButton.textContent = `Auto-Heal: ${healEnabled ? 'ON' : 'OFF'} (${healKeyLabel})`;
		healButton.classList.toggle('on', healEnabled);
	};
	const toggleHeal = () => {
		healEnabled = !healEnabled;
		if (healEnabled) startHeal();
		else stopHeal();
		try {
			api.preferences.set('autoHeal', healEnabled);
		} catch (err) {
			console.error('[auto-hunt] failed to save Auto-Heal preference:', err);
		}
		renderHeal();
	};
	healButton.addEventListener('click', toggleHeal);
	renderHeal();
	if (healEnabled) startHeal();

	const renderTeleport = () => {
		teleportButton.textContent = `Auto-Teleport: ${teleportEnabled ? 'ON' : 'OFF'} (${teleportKeyLabel})`;
		teleportButton.classList.toggle('on', teleportEnabled);
	};
	const toggleTeleport = () => {
		teleportEnabled = !teleportEnabled;
		noTargetSince = 0; // start the idle clock fresh from this moment
		try {
			api.preferences.set('autoTeleport', teleportEnabled);
		} catch (err) {
			console.error('[auto-hunt] failed to save Auto-Teleport preference:', err);
		}
		renderTeleport();
	};
	teleportButton.addEventListener('click', toggleTeleport);
	renderTeleport();

	const keyAbort = new AbortController();
	window.addEventListener('keydown', (event) => {
		const action = event.code === settings.toggleKeyCode ? toggle
			: event.code === settings.healToggleKeyCode ? toggleHeal
			: event.code === settings.teleportToggleKeyCode ? toggleTeleport
			: null;
		if (!action) return;
		if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || event.isComposing) return;
		if (event.repeat) return;
		if (!api.input.state().canMove) return;
		if (api.input.shortcutConflict(event.keyCode || event.which)) return;
		event.preventDefault();
		event.stopImmediatePropagation();
		action();
	}, { capture: true, signal: keyAbort.signal });

	api.on('map:leave', () => {
		if (!enabled) return;
		awaitingReentry = true;
		if (reentryTimer) clearTimeout(reentryTimer);
		reentryTimer = setTimeout(() => {
			if (awaitingReentry) {
				awaitingReentry = false;
				stop('Stopped: map change did not complete.');
				host.hidden = true;
			}
		}, REENTRY_TIMEOUT_MS);
	});
	api.on('map:enter', () => {
		const newMap = api.snapshot().map;
		host.hidden = !newMap;
		if (awaitingReentry) {
			clearReentryWatch();
			if (enabled && newMap && newMap !== lastKnownMap) {
				stop();
			} else if (enabled) {
				refreshMapWarps();
				status.textContent = 'Hunting...';
			}
		} else {
			refreshMapWarps();
		}
		lastKnownMap = newMap;
	});
	// Re-arming happens lazily on the next scanTick (startAssigning guard), but a
	// fresh connection clears our local assignment bookkeeping first so it is
	// forced even if stale entries survived from a previous session.
	api.on('connection', () => {
		if (!enabled) return;
		assignments.length = 0;
		lastCastAt.clear();
		restoreTouchTargeting(); // relog clears hotbar assignments -> touch-targeting no longer needed until next arm
	});
	host.hidden = !api.snapshot().map;

	api.cleanup(() => {
		stop();
		stopHeal();
		source.dispose();
		keyAbort.abort();
		host.remove();
	});

	render();
}

// playStatsCore.js — roadmap 102 M4: ANONYMOUS PLAY STATISTICS for a published game, the pure half.
// No imports, no clock, no DOM: playStats.js feeds it the facts and the time, and hands what it
// returns to the cloud plugin (cloudHooks.notifyPlayStats), which posts it to the community Worker.
//
// One page that plays a published scene = ONE play. Its "token" is this tracker object, which lives in
// the tab's memory and is never sent: the beacon carries only the scene id the page was opened with
// (?s=<id>), a device CLASS and closed-vocabulary events. A play sends `start` once and its `end`
// (time played as a BUCKET, the level and game state at that moment) each time the page is hidden; a
// later hide first RETRACTS the end it sent before (w = -1), so the server's SUM counts one end per
// play with no id to join on. A hard cap bounds what one play can ever send.

/** time played, as the bucket the server stores (no exact duration ever leaves the device) */
export const TIME_BUCKETS = /** @type {const} */ (['lt30s', '30s1m', '1to3', '3to10', '10to30', 'gt30']);
/** the game state at exit (gameState.state, with `over` split by its outcome) */
export const PLAY_STATES = /** @type {const} */ (['playing', 'paused', 'menu', 'won', 'lost', 'over', 'none']);
/** the most events ONE play sends, ever (a start + seven end updates, each a retraction + an end) */
export const PLAY_EVENT_CAP = 16;
/** the most events one beacon carries (the Worker refuses more) */
export const BEACON_MAX_EVENTS = 8;
const SCENE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** seconds played -> its bucket @param {number} seconds */
export function timeBucket(seconds) {
	const s = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
	if (s < 30) return 'lt30s';
	if (s < 60) return '30s1m';
	if (s < 180) return '1to3';
	if (s < 600) return '3to10';
	if (s < 1800) return '10to30';
	return 'gt30';
}

/**
 * The game state at exit, folded into PLAY_STATES. `null` = the scene has no game rules.
 * @param {{state?: string, outcome?: string} | null | undefined} g @param {boolean} [hasGame]
 */
export function playStateOf(g, hasGame = true) {
	if (!g || !hasGame) return 'none';
	const s = String(g.state || '');
	if (s === 'over') {
		const o = String(g.outcome || '').toLowerCase();
		if (/^(win|won|victory|success)$/.test(o)) return 'won';
		if (/^(lose|lost|loss|defeat|fail|failed|dead|death)$/.test(o)) return 'lost';
		return 'over';
	}
	return s === 'playing' || s === 'paused' || s === 'menu' ? s : 'none';
}

/**
 * The device CLASS, nothing finer: headset, phone (tablets too — a touch handheld) or desktop.
 * @param {{ua?: string, coarse?: boolean}} d
 * @returns {'desktop' | 'phone' | 'headset'}
 */
export function playDeviceOf(d) {
	const ua = String(d?.ua || '');
	if (/OculusBrowser|Quest|Pico|VRShell|Wolvic|Vive/i.test(ua)) return 'headset';
	if (d?.coarse || /Mobi|Android|iPhone|iPad/.test(ua)) return 'phone';
	return 'desktop';
}

/** a level's name as the creator wrote it, clamped the way the Worker clamps it @param {any} v */
export function cleanLevel(v) {
	return String(v ?? '')
		.replace(/[^\p{L}\p{N} _.-]+/gu, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 32);
}

/**
 * One play's tracker. Feed it `playing(on, now)` on every play / stop, `level(name)` and `state(s)`
 * as they change; `flush(now, send)` hands the beacon body for this moment to `send` and remembers it
 * once `send` says it went out. Never throws.
 * @param {{ scene: string, device: 'desktop' | 'phone' | 'headset' }} o
 */
export function createPlayTracker(o) {
	const scene = SCENE_ID.test(String(o?.scene || '')) ? String(o.scene) : '';
	const device = o?.device === 'phone' || o?.device === 'headset' ? o.device : 'desktop';
	let started = false;
	let startSent = false;
	let on = false;
	let playingSince = 0;
	let playedMs = 0;
	let levelName = '';
	let stateName = /** @type {string} */ ('none');
	/** the end last sent (to retract), or null @type {null | {t: string, l: string, g: string}} */
	let lastEnd = null;
	let sentEvents = 0;

	const elapsed = (/** @type {number} */ now) => playedMs + (on ? Math.max(0, now - playingSince) : 0);

	return {
		/** @param {boolean} next @param {number} now */
		playing(next, now) {
			if (!scene) return;
			if (next && !on) {
				on = true;
				playingSince = now;
				started = true;
			} else if (!next && on) {
				on = false;
				playedMs += Math.max(0, now - playingSince);
			}
		},
		/** @param {any} name */
		level(name) {
			levelName = cleanLevel(name);
		},
		/** @param {string} s */
		state(s) {
			stateName = PLAY_STATES.includes(/** @type {any} */ (s)) ? s : 'none';
		},
		/** what would be sent now (tests) @param {number} now */
		peek(now) {
			return { started, startSent, seconds: elapsed(now) / 1000, level: levelName, state: stateName, sentEvents, lastEnd };
		},
		/**
		 * Send what is new at this moment through `send(body)`; it is remembered as sent ONLY when
		 * `send` returns true (no listener, a refused sendBeacon = nothing happened, the next hide
		 * tries again). Returns the body that went out, or null.
		 * @param {number} now @param {(body: { v: 1, s: string, d: string, e: any[] }) => boolean} send
		 */
		flush(now, send) {
			if (!scene || !started) return null;
			const e = [];
			const room = () => PLAY_EVENT_CAP - sentEvents - e.length;
			if (!startSent && room() > 0) e.push({ k: 'start' });
			const end = { t: timeBucket(elapsed(now) / 1000), l: levelName, g: stateName };
			const same = lastEnd && lastEnd.t === end.t && lastEnd.l === end.l && lastEnd.g === end.g;
			// an update costs two events (retract + new); a first end, one. Out of room = keep what was sent.
			const endFits = !same && room() >= (lastEnd ? 2 : 1);
			if (endFits) {
				if (lastEnd) e.push({ k: 'end', ...lastEnd, w: -1 });
				e.push({ k: 'end', ...end, w: 1 });
			}
			if (!e.length) return null;
			/** @type {{ v: 1, s: string, d: string, e: any[] }} */
			const body = { v: 1, s: scene, d: device, e: e.slice(0, BEACON_MAX_EVENTS) };
			let ok = false;
			try {
				ok = send(body) === true;
			} catch {
				ok = false;
			}
			if (!ok) return null;
			sentEvents += e.length;
			if (e[0].k === 'start') startSent = true;
			if (endFits) lastEnd = end;
			return body;
		}
	};
}

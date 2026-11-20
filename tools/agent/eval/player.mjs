// Roadmap 2.0 N3a — THE PLAYER the checks drive. Everything goes through the test facade `window.__tp.test.v1`
// (no `__stores` reach-ins) and does what a person does in Play: enter Play, walk (the camera moves in 0.1 s
// steps, exactly like the app's own `playtest` tool), click an object (the On Click path a tap in Play takes),
// press a key (a real Playwright key press), restart the round (the pause menu's Restart), read what the HUD
// shows. What a check READS is the outcome a person would see — where an object is, whether it is visible,
// how bright it is, the HUD text — never which nodes or behaviour produced it, so any way of building it counts.

/** the eye above the floor while walking (m) — runtimeTools.js EYE */
export const EYE = 1.6;

/** the init script every eval page gets: count every sound that starts (Web Audio sources + media elements), and
 * `__n3aFind(ref)` = the object a check means (its setup uuid while it still exists, else the first object with its name) */
export function evalInit() {
	/** @type {any} */
	const w = window;
	w.__n3aFind = (/** @type {any} */ ref) => {
		/** @type {any} */
		let g;
		w.__tp?.test?.v1?.objectsGroup?.subscribe((/** @type {any} */ x) => (g = x))();
		if (!g) return null;
		return (
			(ref?.uuid && g.getObjectByProperty('uuid', ref.uuid)) ||
			(ref?.name && g.getObjectByName(ref.name)) ||
			null
		);
	};
	w.__n3aLook = (/** @type {any} */ ref) => {
		const o = w.__n3aFind(ref);
		if (!o) return null;
		o.updateWorldMatrix?.(true, true);
		const T = w.__tp.test.v1.THREE;
		const p = new T.Vector3();
		const q = new T.Quaternion();
		const s = new T.Vector3();
		o.matrixWorld.decompose(p, q, s);
		let shown = true;
		for (let x = o; x; x = x.parent) if (x.visible === false) shown = false;
		const lum = (/** @type {any} */ c) => (c ? 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b : 0);
		let emis = 0;
		let col = 0;
		let opacity = 1;
		let ownLight = 0;
		o.traverse((/** @type {any} */ m) => {
			let vis = true;
			for (let x = m; x && x !== o.parent; x = x.parent) if (x.visible === false) vis = false;
			if (!vis) return;
			if (m.isLight) ownLight = Math.max(ownLight, m.intensity ?? 0);
			for (const mat of [].concat(m.material ?? [])) {
				/** @type {any} */
				const mm = mat;
				emis = Math.max(emis, lum(mm.emissive) * (mm.emissiveIntensity ?? 1));
				col = Math.max(col, lum(mm.color));
				opacity = Math.min(opacity, mm.transparent ? (mm.opacity ?? 1) : 1);
			}
		});
		// lights near it (not inside it), anywhere in the scene
		let near = 0;
		let g;
		w.__tp.test.v1.objectsGroup.subscribe((x) => (g = x))();
		const lp = new T.Vector3();
		g?.traverse((/** @type {any} */ l) => {
			if (!l.isLight || l.isAmbientLight || l.isDirectionalLight || l.isHemisphereLight) return;
			let inside = false;
			for (let x = l; x; x = x.parent) if (x === o) inside = true;
			if (inside) return;
			let vis = true;
			for (let x = l; x; x = x.parent) if (x.visible === false) vis = false;
			if (!vis) return;
			l.getWorldPosition(lp);
			if (lp.distanceTo(p) <= 1.5) near = Math.max(near, l.intensity ?? 0);
		});
		// a glowing thing shown AT it (a flame, a halo sphere): visible meshes within 1.2 m that are not part of it
		let glow = 0;
		g?.traverse((/** @type {any} */ m) => {
			if (!m.isMesh || m === o) return;
			for (let x = m; x; x = x.parent) if (x === o || x.visible === false) return;
			m.getWorldPosition(lp);
			if (lp.distanceTo(p) > 1.2) return;
			for (const mat of [].concat(m.material ?? [])) {
				/** @type {any} */
				const mm = mat;
				glow = Math.max(glow, lum(mm.emissive) * (mm.emissiveIntensity ?? 1));
			}
		});
		return {
			uuid: o.uuid,
			pos: p.toArray(),
			quat: q.toArray(),
			scale: s.toArray(),
			shown,
			emis: +emis.toFixed(3),
			col: +col.toFixed(3),
			opacity: +opacity.toFixed(3),
			light: +Math.max(ownLight, near).toFixed(3),
			glow: +glow.toFixed(3),
			isLight: !!o.isLight,
			intensity: o.isLight ? o.intensity : undefined
		};
	};
	w.__n3aSounds = [];
	const note = (/** @type {string} */ kind) => w.__n3aSounds.push({ t: performance.now(), kind });
	// every class that OWNS a start (Chromium puts AudioBufferSourceNode's own start on its prototype, so
	// wrapping the base class alone misses every sample a game plays)
	for (const C of [
		'AudioScheduledSourceNode',
		'AudioBufferSourceNode',
		'OscillatorNode',
		'ConstantSourceNode'
	])
		try {
			const proto = w[C]?.prototype;
			if (!proto || !Object.prototype.hasOwnProperty.call(proto, 'start')) continue;
			const start = proto.start;
			proto.start = function (/** @type {any[]} */ ...a) {
				note(C);
				return start.apply(this, a);
			};
		} catch {}
	try {
		const play = HTMLMediaElement.prototype.play;
		HTMLMediaElement.prototype.play = function (...a) {
			note('media');
			return play.apply(this, a);
		};
	} catch {}
}

/** @param {any} page @param {number} ms */
export const sleep = (page, ms) => page.waitForTimeout(ms);

/** read a store's current value through the facade @param {any} page @param {string} path e.g. "isLocked" or "gameState.gameState" */
export function storeValue(page, path) {
	return page.evaluate((p) => {
		/** @type {any} */
		let o = window.__tp.test.v1;
		for (const k of p.split('.')) o = o?.[k];
		let v;
		o?.subscribe?.((x) => (v = x))();
		return v;
	}, path);
}

/** @param {any} page */
export const isPlaying = async (page) => (await storeValue(page, 'isLocked')) === true;

/** Play, as the Play button does it (flat, no headset) @param {any} page */
export async function enterPlay(page) {
	if (await isPlaying(page)) return true;
	await page.evaluate(() => window.__tp.test.v1.playMode.requestPlay({ flat: true }));
	for (let i = 0; i < 60 && !(await isPlaying(page)); i++) await sleep(page, 100);
	await sleep(page, 800);
	return isPlaying(page);
}

/** out of Play (the pause menu's Back to editor when the scene is a game) @param {any} page */
export async function leavePlay(page) {
	if (!(await isPlaying(page))) return true;
	await page.evaluate(() => window.__tp.test.v1.playMode.exitPlay());
	for (let i = 0; i < 30 && (await isPlaying(page)); i++) await sleep(page, 100);
	if (await isPlaying(page))
		await page.evaluate(() => window.__tp.test.v1.gameKit?.gameShell?.leaveToEditor?.());
	for (let i = 0; i < 30 && (await isPlaying(page)); i++) await sleep(page, 100);
	await sleep(page, 400);
	return !(await isPlaying(page));
}

/** the pause menu's Restart (a new round) @param {any} page */
export async function restartRound(page, settleMs = 1200) {
	const r = await page.evaluate(() => {
		const shell = window.__tp.test.v1.gameKit?.gameShell;
		return shell?.restartGame ? shell.restartGame() : { ok: false, reason: 'no game shell' };
	});
	if (settleMs) await sleep(page, settleMs);
	return r;
}

/** where the player stands (feet) @param {any} page @returns {Promise<number[]>} */
export function playerPos(page) {
	return page.evaluate((eye) => {
		/** @type {any} */
		let cam;
		window.__tp.test.v1.globalCamera.subscribe((c) => (cam = c))();
		return cam ? [cam.position.x, cam.position.y - eye, cam.position.z] : [0, 0, 0];
	}, EYE);
}

/**
 * walk the player through floor points at `speed` m/s, the camera stepping every 0.1 s (runtimeTools playtest)
 * @param {any} page @param {number[][]} points @param {number} [speed]
 */
export function walk(page, points, speed = 3) {
	return page.evaluate(
		async ({ points, speed, eye }) => {
			/** @type {any} */
			let cam;
			window.__tp.test.v1.globalCamera.subscribe((c) => (cam = c))();
			if (!cam) return false;
			// by the WALL CLOCK: a busy page's timers run late, and a step count would walk it slower than `speed`
			for (const p of points) {
				const to = [p[0], p[1] + eye, p[2]];
				const start = cam.position.toArray();
				const dist = Math.hypot(to[0] - start[0], to[1] - start[1], to[2] - start[2]);
				const t0 = performance.now();
				for (;;) {
					const t = dist ? Math.min(1, ((performance.now() - t0) / 1000) * (speed / dist)) : 1;
					cam.position.set(
						start[0] + (to[0] - start[0]) * t,
						start[1] + (to[1] - start[1]) * t,
						start[2] + (to[2] - start[2]) * t
					);
					cam.updateMatrixWorld?.();
					if (t >= 1) break;
					await new Promise((r) => setTimeout(r, 50));
				}
			}
			return true;
		},
		{ points, speed, eye: EYE }
	);
}

/**
 * walk like `walk` and WATCH while doing it, in the page (one evaluate: a check's own polling is too slow on a busy
 * page): every tick records where the player is and how each object looks; after the last point it stands there
 * (re-asserting the pose) for `afterMs`, or until `stopWhen(sample)` (a function source) says so.
 * @param {any} page @param {number[][]} points @param {number} speed @param {Record<string, any>} refs @param {number} afterMs
 * @returns {Promise<{t: number, at: number[], looks: Record<string, any>}[]>} t = ms since the walk began
 */
export function walkWatch(page, points, speed, refs, afterMs) {
	return page.evaluate(
		async ({ points, speed, eye, refs, afterMs }) => {
			/** @type {any} */
			const w = window;
			/** @type {any} */
			let cam;
			w.__tp.test.v1.globalCamera.subscribe((/** @type {any} */ c) => (cam = c))();
			/** @type {any[]} */
			const line = [];
			const T0 = performance.now();
			const snap = () => {
				/** @type {Record<string, any>} */
				const looks = {};
				for (const [k, r] of Object.entries(refs)) looks[k] = w.__n3aLook(r);
				line.push({
					t: Math.round(performance.now() - T0),
					at: [cam.position.x, cam.position.y - eye, cam.position.z],
					looks
				});
			};
			for (const p of points) {
				const to = [p[0], p[1] + eye, p[2]];
				const start = cam.position.toArray();
				const dist = Math.hypot(to[0] - start[0], to[1] - start[1], to[2] - start[2]);
				const t0 = performance.now();
				for (;;) {
					const t = dist ? Math.min(1, ((performance.now() - t0) / 1000) * (speed / dist)) : 1;
					cam.position.set(
						start[0] + (to[0] - start[0]) * t,
						start[1] + (to[1] - start[1]) * t,
						start[2] + (to[2] - start[2]) * t
					);
					cam.updateMatrixWorld?.();
					snap();
					if (t >= 1) break;
					await new Promise((r) => setTimeout(r, 50));
				}
			}
			const end = cam.position.clone();
			const t1 = performance.now();
			while (performance.now() - t1 < afterMs) {
				cam.position.copy(end);
				cam.updateMatrixWorld?.();
				snap();
				await new Promise((r) => setTimeout(r, 100));
			}
			return line;
		},
		{ points, speed, eye: EYE, refs, afterMs }
	);
}

/** stand still at a point for `ms`, re-asserting the pose every 0.1 s (a controller may nudge it) @param {any} page @param {number[]} p @param {number} ms */
export function stay(page, p, ms) {
	return page.evaluate(
		async ({ p, ms, eye }) => {
			/** @type {any} */
			let cam;
			window.__tp.test.v1.globalCamera.subscribe((c) => (cam = c))();
			const end = Date.now() + ms;
			while (Date.now() < end) {
				cam?.position.set(p[0], p[1] + eye, p[2]);
				cam?.updateMatrixWorld?.();
				await new Promise((r) => setTimeout(r, 100));
			}
		},
		{ p, ms, eye: EYE }
	);
}

/** a click on an object in Play (the On Click path a tap takes) @param {any} page @param {{uuid?: string, name?: string}} ref */
export function click(page, ref) {
	return page.evaluate(
		({ ref }) => {
			const o = /** @type {any} */ (window).__n3aFind(ref);
			if (!o) return { ok: false, why: 'no such object' };
			const reached = window.__tp.test.v1.flowRuntime.fireObjectClick(o.uuid);
			return { ok: true, reached };
		},
		{ ref }
	);
}

/** a real key press @param {any} page @param {string} key Playwright key name ("p", "KeyP") @param {number} [holdMs] */
export async function press(page, key, holdMs = 300) {
	await page.keyboard.down(key);
	await sleep(page, holdMs);
	await page.keyboard.up(key);
}

/**
 * What a person sees of one object: world pose, visibility (every ancestor), size, and BRIGHTNESS — the emissive and
 * base colour of its materials plus every light inside it or within 1.5 m of it (a star that "lights up" may glow,
 * change colour or get a light).
 * @param {any} page @param {{uuid?: string, name?: string}} ref
 */
export function look(page, ref) {
	return page.evaluate((ref) => /** @type {any} */ (window).__n3aLook(ref), ref);
}

/** metres between two looks' positions @param {any} a @param {any} b */
export const moved = (a, b) =>
	a && b ? Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1], a.pos[2] - b.pos[2]) : 0;
/** degrees between two looks' orientations @param {any} a @param {any} b */
export function turned(a, b) {
	if (!a || !b) return 0;
	const d = Math.abs(
		a.quat[0] * b.quat[0] + a.quat[1] * b.quat[1] + a.quat[2] * b.quat[2] + a.quat[3] * b.quat[3]
	);
	return (2 * Math.acos(Math.min(1, d)) * 180) / Math.PI;
}
/** largest size ratio change between two looks @param {any} a @param {any} b */
export const resized = (a, b) =>
	a && b
		? Math.max(
				...a.scale.map((/** @type {number} */ v, /** @type {number} */ i) =>
					Math.abs(Math.log(Math.max(1e-4, Math.abs(b.scale[i])) / Math.max(1e-4, Math.abs(v))))
				)
			)
		: 0;

/** is `now` a door/gate/blocker that has OPENED compared with `base`: moved ≥ 0.5 m, turned ≥ 30°, hidden, shrunk/grown ≥ 50 % or faded */
export function opened(/** @type {any} */ base, /** @type {any} */ now) {
	if (!base) return false;
	if (!now) return true; // deleted counts as out of the way
	return (
		moved(base, now) >= 0.5 ||
		turned(base, now) >= 30 ||
		(base.shown && !now.shown) ||
		resized(base, now) >= Math.log(1.5) ||
		now.opacity <= 0.35
	);
}
/** back where it was: within 0.15 m, 10°, shown again, same size */
export function closedAgain(/** @type {any} */ base, /** @type {any} */ now) {
	return (
		!!base &&
		!!now &&
		moved(base, now) <= 0.15 &&
		turned(base, now) <= 10 &&
		now.shown === base.shown &&
		resized(base, now) <= 0.1 &&
		now.opacity > 0.6
	);
}
/** brighter than `base`: glow, colour or a light near it */
export function lit(/** @type {any} */ base, /** @type {any} */ now) {
	if (!base || !now || !now.shown) return false;
	if (base.isLight)
		return (
			(now.intensity ?? 0) > Math.max(0.05, (base.intensity ?? 0) * 1.5) ||
			(!base.shown && now.shown)
		);
	return (
		now.emis - base.emis >= 0.15 ||
		now.light - base.light >= 0.3 ||
		now.col - base.col >= 0.2 ||
		(now.glow ?? 0) - (base.glow ?? 0) >= 0.3
	);
}

/**
 * What the HUD shows right now: the visible text of the HUD layer (incl. the Announce banner) and the live
 * values of its elements (bars as numbers, timers, texts).
 * @param {any} page
 */
export function hud(page) {
	return page.evaluate(() => {
		const layer = document.querySelector('#hud-layer');
		/** @type {string[]} */
		const lines = [];
		if (layer) {
			const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
			for (let n = walker.nextNode(); n; n = walker.nextNode()) {
				const el = n.parentElement;
				if (!el) continue;
				const cs = getComputedStyle(el);
				if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0)
					continue;
				if (!el.getClientRects().length) continue;
				let hidden = false;
				for (let x = el; x && x !== layer; x = x.parentElement) {
					const s = getComputedStyle(x);
					if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0)
						hidden = true;
				}
				if (hidden) continue;
				const t = (n.textContent ?? '').trim();
				if (t) lines.push(t);
			}
		}
		/** @type {Record<string, any>} */
		let rt = {};
		window.__tp.test.v1.hudDocs?.hudRuntime?.subscribe((/** @type {any} */ v) => (rt = v ?? {}))();
		/** @type {Record<string, any>} */
		const values = {};
		/** bars: a bar's runtime value as a fraction of its range, then any aria progress the layer draws */
		/** @type {number[]} */
		const bars = [];
		for (const [k, v] of Object.entries(rt)) {
			if (typeof v === 'object' && v !== null) {
				values[k] = typeof v.value === 'number' ? v.value : v.text ? v.text : (v.value ?? '');
				if (typeof v.value === 'number' && typeof v.max === 'number' && v.max !== (v.min ?? 0))
					bars.push((v.value - (v.min ?? 0)) / (v.max - (v.min ?? 0)));
			} else values[k] = v;
		}
		for (const b of layer?.querySelectorAll('[role="progressbar"][aria-valuenow]') ?? []) {
			const n = Number(b.getAttribute('aria-valuenow'));
			const max = Number(b.getAttribute('aria-valuemax') ?? 100);
			if (Number.isFinite(n) && max) bars.push(n / max);
		}
		return { text: lines.join(' | '), values, bars };
	});
}

/** every number in a HUD reading (text + values), in order @param {{text: string, values: Record<string, any>}} h */
export function numbersIn(h) {
	const out = [];
	for (const m of (h.text ?? '').matchAll(/-?\d+(?:\.\d+)?/g)) out.push(Number(m[0]));
	for (const v of Object.values(h.values ?? {}))
		if (typeof v === 'number') out.push(v);
		else if (typeof v === 'string')
			for (const m of v.matchAll(/-?\d+(?:\.\d+)?/g)) out.push(Number(m[0]));
	return out;
}

/** every clock reading (m:ss → seconds; a bare number of seconds ≥ 10 also counts) in a HUD reading @param {any} h */
export function clocksIn(h) {
	const s = [
		h.text ?? '',
		...Object.values(h.values ?? {}).map((v) =>
			typeof v === 'string' || typeof v === 'number' ? String(v) : ''
		)
	].join(' | ');
	const out = [];
	for (const m of s.matchAll(/(\d{1,2}):(\d{2})(?:\.\d+)?/g))
		out.push(Number(m[1]) * 60 + Number(m[2]));
	if (!out.length)
		for (const m of s.matchAll(/\b(\d{2,3})(?:\.\d+)?\s*s?\b/g)) out.push(Number(m[1]));
	return out;
}

/** a world-visible scene object that SAYS something (3D text, a sign): its name, its userData or its geometry's text
 * matches `re` (source) @param {any} page @param {string} re @returns {Promise<string[]>} the names that match */
export function sceneSays(page, re) {
	return page.evaluate((src) => {
		const rx = new RegExp(src, 'i');
		/** @type {any} */
		let g;
		window.__tp.test.v1.objectsGroup.subscribe((/** @type {any} */ x) => (g = x))();
		/** @type {string[]} */
		const out = [];
		g?.traverse((/** @type {any} */ o) => {
			let vis = true;
			for (let x = o; x; x = x.parent) if (x.visible === false) vis = false;
			if (!vis || o === g) return;
			let ud = '';
			try {
				ud = JSON.stringify(o.userData ?? {}).slice(0, 4000);
			} catch {}
			if (
				rx.test(String(o.name ?? '')) ||
				rx.test(ud) ||
				rx.test(String(o.geometry?.parameters?.text ?? ''))
			)
				out.push(String(o.name || o.uuid));
		});
		return out;
	}, re);
}

/** a NEW round, as a player gets one: the pause menu's Restart (back to the start), then the game's Start (playing) */
export async function newRound(page) {
	const r = await restartRound(page);
	const g = await game(page);
	if (g?.state !== 'playing')
		await page.evaluate(() => window.__tp.test.v1.gameState.setGameState('playing'));
	await sleep(page, 1200);
	return { restart: r, state: (await game(page))?.state, round: (await game(page))?.round };
}

/** the game shell's state @param {any} page */
export const game = (page) => storeValue(page, 'gameState.gameState');

/** sounds started since `since` (performance.now ms), merging starts closer than 40 ms into one @param {any} page @param {number} since */
export function soundsSince(page, since) {
	return page.evaluate((since) => {
		const all = /** @type {any} */ (window.__n3aSounds ?? [])
			.filter((/** @type {any} */ s) => s.t >= since)
			.map((/** @type {any} */ s) => s.t);
		/** @type {number[]} */
		const merged = [];
		for (const t of all) if (!merged.length || t - merged[merged.length - 1] > 40) merged.push(t);
		return merged;
	}, since);
}

/** the page clock (performance.now) @param {any} page */
export const pageNow = (page) => page.evaluate(() => performance.now());

/** sample `fn` every `stepMs` for `ms` @template T @param {any} page @param {() => Promise<T>} fn @param {number} ms @param {number} [stepMs] @returns {Promise<{t: number, v: T}[]>} */
export async function sample(page, fn, ms, stepMs = 200) {
	const out = [];
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		out.push({ t: Date.now() - t0, v: await fn() });
		await sleep(page, stepMs);
	}
	return out;
}

/** a diagnostic line: the round as the runtime sees it, and every latch/once's value and last trigger stamp
 * @param {any} page */
export function roundDiag(page) {
	return page.evaluate(() => {
		const t = /** @type {any} */ (window).__tp.test.v1;
		const read = (/** @type {any} */ s) => {
			let v;
			s?.subscribe?.((/** @type {any} */ x) => (v = x))();
			return v;
		};
		const g = read(t.gameState?.gameState) ?? {};
		const values = read(t.flowValues) ?? {};
		const trig = read(t.flowTriggers) ?? {};
		const cut = t.gameState?.roundCutoff?.();
		const nodes = (t.flowStore?.allNodes?.() ?? t.allNodes?.() ?? []).filter(
			(/** @type {any} */ n) => ['latch', 'once', 'onclick'].includes(n.type)
		);
		return {
			state: g.state,
			round: g.round,
			startedAt: g.startedAt,
			cutoff: cut === Infinity ? 'inf' : cut,
			cutoffSec:
				typeof cut === 'number' && Number.isFinite(cut)
					? +((cut % 86400000) / 1000).toFixed(2)
					: null,
			nodes: nodes.slice(0, 6).map((/** @type {any} */ n) => ({
				t: n.type,
				pr: !!n.data?.perRound,
				v: values[n.id],
				last: trig[n.id]?.lastT
			}))
		};
	});
}

/** this page's frame time now (ms, a 1 s rAF sample): a timing rule finer than one frame cannot be judged
 * @param {any} page @returns {Promise<number>} */
export function frameMs(page) {
	return page.evaluate(
		() =>
			new Promise((done) => {
				const t0 = performance.now();
				let n = 0;
				const step = () => {
					n++;
					if (performance.now() - t0 >= 1000) done((performance.now() - t0) / n);
					else requestAnimationFrame(step);
				};
				requestAnimationFrame(step);
			})
	);
}

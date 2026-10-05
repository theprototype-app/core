// 36-fb-water F13 + S2: EVERY water parameter on every preset and shape changes the picture.
// "Water tank: Foam, Visibility, Opacity do nothing" (user, 2026-10-05) — so this suite sets each
// Water-panel control to a low and a high value on a frozen water clock (two frames differ ONLY
// by that control) and counts the pixels that changed in the water's clip. A control under the
// threshold is DEAD and fails the run: the visual-regression guard that a setting keeps doing
// something (S2). Evidence: PARAMS_OUT/table.md + results.json + a lo/hi screenshot pair per
// control on the Water tank (the user's case).
//
//   MODE=full (default): every control x every preset on the tank, + every control on the pool,
//                        round pool and ocean, + the underwater controls, desktop (high) tier,
//                        + the tank's controls on the Quest tier.
//   MODE=quick:          every control on each shape's default preset only (the S2 regression run).
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

const MODE = process.env.MODE || 'full';
const OUT = process.env.PARAMS_OUT || '';
/** a control is live when at least this share of the clip changes (0.15% = ~260 px of 420²) */
const LIVE = 0.0015;

// every control of WaterPanel's look/waves sections: [key, label, lo, hi, base needed for it to
// act at all, 'look'|'waves', tiers it is meant to act on]
const D = ['high', 'quest'];
const DESK = ['high']; // screen-space only (the Quest tier has no pre-pass), documented in the UI
/** @type {[string, string, any, any, any, 'look'|'waves', string[]][]} */
const CONTROLS = [
	['count', 'Waves: Count', 0, 6, { waves: { amplitude: 0.15, count: 4 } }, 'waves', D],
	['amplitude', 'Waves: Amplitude', 0, 0.35, { waves: { count: 4 } }, 'waves', D],
	['wavelength', 'Waves: Wavelength', 0.6, 12, { waves: { amplitude: 0.15, count: 4 } }, 'waves', D],
	['speed', 'Waves: Speed', 0.2, 3, { waves: { amplitude: 0.15, count: 4 } }, 'waves', D],
	['direction', 'Waves: Direction', 0, 120, { waves: { amplitude: 0.15, count: 4 } }, 'waves', D],
	['choppiness', 'Waves: Choppiness', 0, 1, { waves: { amplitude: 0.2, count: 4 } }, 'waves', D],
	['shallowColor', 'Shallow colour', '#ff2020', '#20ff40', {}, 'look', D],
	['deepColor', 'Deep colour', '#ff2020', '#2040ff', { look: { opacity: 0.95 } }, 'look', D],
	['clarity', 'Clarity (m)', 0.3, 15, {}, 'look', D],
	['opacity', 'Opacity', 0.2, 1, {}, 'look', D],
	['refraction', 'Refraction', 0, 1.5, { look: { opacity: 0.6 } }, 'look', DESK],
	['chromatic', 'Chromatic', 0, 1, { look: { refraction: 1.2, opacity: 0.6 } }, 'look', DESK],
	['reflection', 'Reflection', 'none', 'env', {}, 'look', D],
	['reflectivity', 'Reflectivity', 0, 1, {}, 'look', D],
	['fresnel', 'Fresnel', 0.6, 8, { look: { reflectivity: 1 } }, 'look', D],
	['roughness', 'Roughness', 0.02, 0.9, { look: { reflectivity: 1 } }, 'look', D],
	['foam', 'Foam', 0, 1, { look: { foamWidth: 0.4 } }, 'look', D],
	['foamColor', 'Foam colour', '#ffffff', '#ff00ff', { look: { foam: 1, foamWidth: 0.4 } }, 'look', D],
	['foamWidth', 'Shore foam (m)', 0.05, 1.5, { look: { foam: 1 } }, 'look', D],
	['caustics', 'Caustics', 0, 2, { look: { opacity: 0.5 } }, 'look', DESK],
	['causticScale', 'Caustic size', 0.3, 6, { look: { caustics: 2, opacity: 0.5 } }, 'look', DESK],
	['causticSpeed', 'Caustic speed', 0.1, 3, { look: { caustics: 2, opacity: 0.5 } }, 'look', DESK],
	['detail', 'Ripples', 0, 1.5, {}, 'look', D],
	['detailScale', 'Ripple size', 0.3, 10, { look: { detail: 1.2 } }, 'look', D],
	['detailSpeed', 'Ripple speed', 0, 3, { look: { detail: 1.2 } }, 'look', D],
	['emissive', 'Glow colour', '#000000', '#ff6000', { look: { emissiveStrength: 1.5 } }, 'look', D],
	['emissiveStrength', 'Glow strength', 0, 3, { look: { emissive: '#ff6000' } }, 'look', D],
	['fogColor', 'Underwater fog colour', '#ff0000', '#00ff60', { look: { fogDistance: 0.6 } }, 'look', D],
	['fogDistance', 'Visibility (m)', 0.4, 40, {}, 'look', D],
	['frozen', 'Frozen', false, true, { waves: { amplitude: 0.15, count: 4 } }, 'look', D]
];
// FROZEN (look.frozen) locks these by design (resolveLook: no waves, no foam, no ripple motion) —
// the Water panel greys them out with the reason, so on a frozen preset they are n/a, not dead
const FROZEN_LOCKED = ['count', 'amplitude', 'wavelength', 'speed', 'direction', 'choppiness', 'foam', 'foamColor', 'foamWidth', 'detailSpeed'];
// these act on what is SEEN THROUGH the water (or from inside it): n/a outside an opaque preset,
// where the camera-inside rows below measure them instead
const SEE_THROUGH = ['fogColor', 'fogDistance'];
// the camera INSIDE the water — the controls that are about being underwater
const UNDER = [
	['fogColor', 'Underwater fog colour', '#ff0000', '#00ff60', {}, 'look', D],
	['fogDistance', 'Visibility (m)', 0.5, 40, {}, 'look', D],
	['caustics', 'Caustics (underwater)', 0, 2, {}, 'look', DESK]
];

// the shapes, as Add ▸ Water makes them, each on a bench (floor, stripes, a cube in the water)
const SHAPES = {
	tank: { kind: 'tank', at: [0, 0.7, 0], cam: [1.3, 2.3, 2.5], look: [0, 0.7, 0], under: [0, 0.6, 0.1], underLook: [0, 0.6, -1] },
	pool: { kind: 'pool', at: [0, -0.75, 0], cam: [3.4, 3.2, 5.6], look: [0, -0.8, 0], under: [0, -0.6, 1], underLook: [0, -0.8, -2] },
	round: { kind: 'cylinder', at: [0, -0.6, 0], cam: [3, 3, 4.6], look: [0, -0.7, 0], under: [0, -0.5, 0.5], underLook: [0, -0.7, -2] },
	ocean: { kind: 'ocean', at: [0, -1, 0], cam: [5, 3.2, 9], look: [0, -0.5, 0], under: [0, -1.2, 2], underLook: [0, -1.4, -4] }
};

h.run(async () => {
	if (OUT) fs.mkdirSync(path.join(OUT, 'pairs'), { recursive: true });
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 720 } }, storage: { 'water:quality': 'high' } });
	const presets = await A.page.evaluate(() => window.__stores.waterPresets.WATER_PRESETS.map((p) => p.key));

	/** build one shape's bench; returns the water uuid @param {string} shape */
	const bench = (shape) =>
		A.page.evaluate(
			async ({ shape, s }) => {
				const st = window.__stores;
				st.waterRuntime.freezeWaterClock(100.25);
				const cmd = st.commandsHandler.sceneCommand;
				let g;
				st.objectsGroup.subscribe((v) => (g = v))();
				cmd('/clear all');
				const last = () => g.children[g.children.length - 1];
				const box = (/** @type {number[]} */ size, /** @type {number[]} */ pos, /** @type {string} */ color) => {
					cmd('/create Box ' + size.join(' '));
					const o = last();
					o.position.set(pos[0], pos[1], pos[2]);
					o.material.color.set(color);
					delete o.userData.physics;
					o.updateMatrixWorld(true);
					return o;
				};
				const y0 = s.at[1] - (shape === 'tank' ? 0.6 : shape === 'ocean' ? 1 : 0.75);
				box([16, 0.2, 12], [0, y0 - 0.1, 0], '#d8c7a4');
				const stripes = ['#e63946', '#f1c453', '#2a9d8f', '#264653', '#ffffff', '#8338ec'];
				stripes.forEach((c, i) => box([0.35, 2.4, 0.1], [-2.6 + i * 1.05, y0 + 1.2, -1.6], c));
				box([0.35, 0.35, 0.35], [0.2, y0 + 0.25, 0.1], '#ff7a00');
				cmd(st.waterActions.WATER_KINDS.find((/** @type {any} */ k) => k.key === s.kind).command);
				const w = last();
				st.waterActions.makeWater(w, s.kind);
				w.position.set(s.at[0], s.at[1], s.at[2]);
				w.updateMatrixWorld(true);
				return w.uuid;
			},
			{ shape, s: SHAPES[shape] }
		);
	/** @param {number[]} pos @param {number[]} target */
	const look = (pos, target) =>
		A.page.evaluate(
			([p, t]) => {
				let cam, orbit;
				window.__stores.editorCam.subscribe((v) => (cam = v))();
				window.__stores.orbitControls.subscribe((v) => (orbit = v))();
				cam.position.set(p[0], p[1], p[2]);
				orbit?.target?.set(t[0], t[1], t[2]);
				orbit?.update?.();
				cam.lookAt(t[0], t[1], t[2]);
				window.__stores.objectActions.deselectObject?.();
			},
			[pos, target]
		);
	/** the blob: preset + the control's base + the value @param {string} uuid @param {string} preset @param {any} c @param {any} v @param {string} shapeKind */
	const apply = (uuid, preset, c, v, shapeKind) =>
		A.page.evaluate(
			({ uuid, preset, c, v, shapeKind }) => {
				const st = window.__stores;
				const blob = st.waterPresets.waterPreset(preset, { shape: shapeKind });
				const [key, , , , base, group] = c;
				blob.look = { ...blob.look, ...(base.look ?? {}) };
				blob.waves = { ...blob.waves, ...(base.waves ?? {}) };
				blob[group] = { ...blob[group], [key]: v };
				st.waterActions.setObjectWater(uuid, blob, { immediate: true });
			},
			{ uuid, preset, c, v, shapeKind }
		);
	/** @type {any[]} */
	const rows = [];
	/** one control: lo frame, hi frame, the delta @param {any} ctx */
	async function measure({ uuid, preset, c, shape, tier, clip, pairName }) {
		const base = SHAPES[shape.replace(/-under$/, '')];
		const kind = base.kind === 'cylinder' ? 'cylinder' : base.kind === 'ocean' ? 'plane' : 'box';
		await apply(uuid, preset, c, c[2], kind);
		await A.page.waitForTimeout(320);
		const lo = await A.page.screenshot({ clip });
		await apply(uuid, preset, c, c[3], kind);
		await A.page.waitForTimeout(320);
		const hi = await A.page.screenshot({ clip });
		const d = await h.frameDelta(A.page, lo, hi, 18);
		const live = d.fraction >= LIVE;
		const pl = await A.page.evaluate((k) => window.__stores.waterPresets.resolveLook(window.__stores.waterPresets.waterPreset(k, {})), preset);
		const under = shape.endsWith('-under');
		const na = (pl.frozen && FROZEN_LOCKED.includes(c[0])) || (!under && SEE_THROUGH.includes(c[0]) && pl.opacity >= 0.9 && !(pl.refraction > 0));
		rows.push({ key: c[0], label: c[1], lo: c[2], hi: c[3], preset, shape, tier, fraction: d.fraction, changed: d.changed, live, expected: c[6].includes(tier) && !na, na });
		if (OUT && pairName) {
			fs.writeFileSync(path.join(OUT, 'pairs', `${pairName}-lo.png`), lo);
			fs.writeFileSync(path.join(OUT, 'pairs', `${pairName}-hi.png`), hi);
		}
		return live;
	}

	const tiers = MODE === 'full' ? ['high', 'quest'] : ['high'];
	for (const tier of tiers) {
		await A.page.evaluate((t) => window.__stores.waterPrefs.waterQuality.set(t === 'quest' ? 'low' : 'high'), tier);
		for (const shape of Object.keys(SHAPES)) {
			if (tier === 'quest' && shape !== 'tank') continue;
			const uuid = await bench(shape);
			const s = SHAPES[shape];
			await look(s.cam, s.look);
			await A.page.waitForTimeout(1200);
			const clip = await h.centeredClip(A, s.look, 420);
			const presetList = MODE === 'full' && shape === 'tank' && tier === 'high' ? presets : [await A.page.evaluate((u) => {
				let g;
				window.__stores.objectsGroup.subscribe((v) => (g = v))();
				return g.getObjectByProperty('uuid', u).userData.water.preset;
			}, uuid)];
			for (const preset of presetList) {
				let n = 0;
				for (const c of CONTROLS) {
					const pairName = shape === 'tank' && tier === 'high' && preset === 'aquarium' ? `${String(++n).padStart(2, '0')}-tank-${c[0]}` : tier === 'quest' && preset === 'aquarium' ? `q${String(++n).padStart(2, '0')}-tank-${c[0]}` : '';
					await measure({ uuid, preset, c, shape, tier, clip, pairName });
				}
			}
			// underwater: the camera inside the volume (every preset on the tank in full mode)
			if (tier === 'high') {
				await look(s.under, s.underLook);
				await A.page.waitForTimeout(800);
				const uclip = { x: 340, y: 160, width: 600, height: 400 };
				for (const preset of presetList) {
					let n = 0;
					for (const c of UNDER) await measure({ uuid, preset, c, shape: shape + '-under', tier, clip: uclip, pairName: shape === 'tank' && preset === 'aquarium' ? `u${++n}-tank-${c[0]}` : '' });
				}
			}
		}
	}
	await A.page.evaluate(() => window.__stores.waterRuntime.freezeWaterClock(null));

	// the verdicts: every control that is meant to act on a tier must change pixels there
	const dead = rows.filter((r) => r.expected && !r.live);
	// a control dead on EVERY row of a shape is a dead control; a few dead rows on odd presets
	// (lava's opaque crust hides refraction) are reported in the table, the dead control fails
	/** @type {Map<string, {all: number, dead: number}>} */
	const per = new Map();
	for (const r of rows.filter((r) => r.expected)) {
		const k = `${r.key}|${r.shape}|${r.tier}`;
		const e = per.get(k) ?? { all: 0, dead: 0 };
		e.all++;
		if (!r.live) e.dead++;
		per.set(k, e);
	}
	for (const [k, e] of per) {
		const [key, shape, tier] = k.split('|');
		h.check(e.dead < e.all, `${key} changes the picture on the ${shape} (${tier}) — dead on ${e.dead}/${e.all} preset(s)`);
	}
	if (OUT) {
		fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(rows, null, 1));
		const shapes = [...new Set(rows.map((r) => r.shape + ' ' + r.tier))];
		let md = `# Water parameter audit (36-fb-water F13 / S2) — ${new Date().toISOString().slice(0, 16)}\n\n`;
		md += `Each cell: % of the water clip that changed between the low and the high value (frozen clock). `;
		md += `LIVE threshold ${LIVE * 100}% · **DEAD** = under it · n/a = not meant for that tier (screen-space only).\n\n`;
		md += `## Tank, every preset (desktop high)\n\n| control | lo → hi | ${presets.join(' | ')} |\n|---|---|${presets.map(() => '---').join('|')}|\n`;
		for (const c of CONTROLS) {
			md += `| ${c[1]} | ${c[2]} → ${c[3]} | ` + presets.map((p) => {
				const r = rows.find((x) => x.key === c[0] && x.shape === 'tank' && x.tier === 'high' && x.preset === p);
				return r ? (r.na ? 'n/a' : r.live ? (r.fraction * 100).toFixed(1) : `**DEAD ${(r.fraction * 100).toFixed(2)}**`) : '';
			}).join(' | ') + ' |\n';
		}
		md += `\n## Underwater (camera inside the tank), every preset\n\n| control | ${presets.join(' | ')} |\n|---|${presets.map(() => '---').join('|')}|\n`;
		for (const c of UNDER) {
			md += `| ${c[1]} | ` + presets.map((p) => {
				const r = rows.find((x) => x.key === c[0] && x.shape === 'tank-under' && x.preset === p);
				return r ? (r.na ? 'n/a' : r.live ? (r.fraction * 100).toFixed(1) : `**DEAD ${(r.fraction * 100).toFixed(2)}**`) : '';
			}).join(' | ') + ' |\n';
		}
		md += `\nn/a: Frozen locks waves, foam and ripple motion (the panel greys them out and says so); the see-through fog rows are measured from inside an opaque preset.\n`;
		md += `\n## Every shape (its default preset) and the Quest tier\n\n| control | ${shapes.join(' | ')} |\n|---|${shapes.map(() => '---').join('|')}|\n`;
		const keys = [...new Set(rows.map((r) => r.key + '|' + r.label))];
		for (const kl of keys) {
			const [key, label] = kl.split('|');
			md += `| ${label} | ` + shapes.map((sh) => {
				const rs = rows.filter((x) => x.key === key && x.shape + ' ' + x.tier === sh);
				if (!rs.length) return '';
				const r = rs[0];
				if (!r.expected) return 'n/a';
				return r.live ? (r.fraction * 100).toFixed(1) : `**DEAD ${(r.fraction * 100).toFixed(2)}**`;
			}).join(' | ') + ' |\n';
		}
		md += `\nScreenshot pairs (Water tank, aquarium preset): pairs/NN-tank-<control>-lo.png / -hi.png; Quest tier q*; underwater u*.\n`;
		fs.writeFileSync(path.join(OUT, 'table.md'), md);
	}
	console.log('rows', rows.length, 'dead (expected-live)', dead.length);
	await h.finish(browser);
});

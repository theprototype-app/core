<script module lang="ts">
	// 102 M8 — the curve view of ONE Timeline property track (lazy: TimelineEditor imports it only
	// when a curve row is open). It renders TWO grid cells — the controls beside the track names and
	// the graph under the lanes — so it lines up with the Timeline's columns and shares its time axis.
	//
	// Everything is a curveCore mutator on the track's keys, written through updateTrack: the
	// existing sequence document, wire message, latest-wins stamp and undo (a drag is ONE step via
	// begin/endSequenceGesture). No new channel, no new key model, no second evaluation: the curve
	// drawn here is sampleCurve, the same function propPlayback poses objects with on every peer.
	//
	// The clipboard is LOCAL to this tab (module scope, shared by every open curve row).
	let clipboard: { type: string; keys: any[] } | null = null;
</script>

<script lang="ts">
	import { untrack } from 'svelte';
	import Icon from '../ui/Icon.svelte';
	import ThemedSelect from '../ui/ThemedSelect.svelte';
	import { updateTrack } from '$lib/sequences';
	import { propDef } from '$lib/propTracks';
	import { sampleCurve, moveKeys, deleteKeys, insertKey, setHandle, canBezier, widthOf, SAME_TIME } from '$lib/curveCore';
	import {
		setKeys,
		setKeyMode,
		keyModeOf,
		applyPreset,
		copyKeys,
		pasteKeys,
		valueBounds,
		unwrapSeries,
		KEY_MODES,
		EASE_PRESETS
	} from '$lib/curveEdit';

	let {
		track,
		seqId,
		fps = 30,
		viewStart = 0,
		viewEnd = 10,
		width = 600,
		playhead = 0,
		snapOn = true,
		liveValue = () => null,
		onedited = () => {},
		gesture
	}: {
		track: any;
		seqId: string;
		fps?: number;
		viewStart?: number;
		viewEnd?: number;
		width?: number;
		playhead?: number;
		snapOn?: boolean;
		liveValue?: () => any;
		onedited?: () => void;
		/** the Timeline's undo gesture (sequenceSync), passed in so this lazy chunk does not import the
		 *  history family: a static import there made its preload list name ~400 chunks (3.4 KB gz of boot) */
		gesture: { begin: (id: string) => void; end: (id: string) => void; cancel: (id: string) => void };
	} = $props();

	const H = 168;
	const PAD = 12;
	const KEY_R = 5;
	const COMP_NAMES = ['X', 'Y', 'Z'];
	const COMP_COLOR = ['var(--axis-x)', 'var(--axis-y)', 'var(--axis-z)'];

	// phone: view-only under 600 px wide (the brief); the window width, not the pane's
	let winW = $state(typeof window === 'undefined' ? 1200 : window.innerWidth);
	const readOnly = $derived(winW < 600);

	const type = $derived(track.type as string);
	const keys = $derived((track.keys ?? []) as any[]);
	const def = $derived(propDef(track.path));
	/** rotations edit in DEGREES (stored radians, nothing in the file changes) */
	const isAngle = $derived(def?.unit === 'rad');
	const k = $derived(isAngle ? 180 / Math.PI : 1);
	const unit = $derived(isAngle ? '°' : (def?.unit ?? ''));
	const w = $derived(widthOf(type));
	const isQuat = $derived(type === 'quat');
	const isStep = $derived(type === 'step');
	const valueEditable = $derived(!readOnly && !isQuat);
	let comp = $state(0);

	// ---- axes -------------------------------------------------------------------------
	const span = $derived(Math.max(0.05, viewEnd - viewStart));
	const pps = $derived(Math.max(1e-3, width / span));
	const xOf = (t: number) => (t - viewStart) * pps;
	const tOf = (x: number) => viewStart + x / pps;
	let vLo = $state(-1);
	let vHi = $state(1);
	const yOf = (v: number) => PAD + ((vHi - v) / Math.max(1e-9, vHi - vLo)) * (H - 2 * PAD);
	const vOf = (y: number) => vHi - ((y - PAD) / (H - 2 * PAD)) * (vHi - vLo);

	/** a component of a stored value, in display units */
	function shown(v: any, c = comp) {
		if (isStep) return v === true ? 1 : v === false ? 0 : Number(v) || 0;
		const n = w === 1 ? Number(v) : Number(v?.[c]);
		return n * k;
	}

	/** quaternion [x,y,z,w] → Euler XYZ radians (three's order and formula) */
	function quatEuler(q: number[]) {
		const [x, y, z, ww] = q;
		const m11 = 1 - 2 * (y * y + z * z), m12 = 2 * (x * y - z * ww), m13 = 2 * (x * z + y * ww);
		const m22 = 1 - 2 * (x * x + z * z), m23 = 2 * (y * z - x * ww);
		const m32 = 2 * (y * z + x * ww), m33 = 1 - 2 * (x * x + y * y);
		const ey = Math.asin(Math.max(-1, Math.min(1, m13)));
		if (Math.abs(m13) < 0.9999999) return [Math.atan2(-m23, m33), ey, Math.atan2(-m12, m11)];
		return [Math.atan2(m32, m22), ey, 0];
	}

	/** the sampled values drawn, display units: one series per component (a quat = its unwrapped
	 *  Euler read-out in degrees) */
	const series = $derived.by(() => {
		if (!keys.length) return { ts: [] as number[], vals: [] as number[][] };
		const n = Math.max(2, Math.ceil(width / 2));
		const ts = Array.from({ length: n + 1 }, (_, i) => tOf((i / n) * width));
		const comps = isQuat ? 3 : w;
		const raw: number[][] = Array.from({ length: comps }, () => []);
		for (const t of ts) {
			const v = sampleCurve(type, keys, t);
			if (isQuat) {
				const e = quatEuler(v);
				for (let c = 0; c < 3; c++) raw[c].push(e[c]);
			} else for (let c = 0; c < comps; c++) raw[c].push(shown(v, c));
		}
		const vals = isQuat ? raw.map((r) => unwrapSeries(r).map((v) => (v * 180) / Math.PI)) : raw;
		return { ts, vals };
	});
	const lines = $derived(
		series.vals.map((disp, c) => {
			const n = series.ts.length - 1;
			let d = '';
			for (let i = 0; i <= n; i++) {
				const x = (i / n) * width;
				if (isStep && i > 0 && disp[i] !== disp[i - 1]) d += `L${x.toFixed(1)},${yOf(disp[i - 1]).toFixed(1)}`;
				d += (i ? 'L' : 'M') + x.toFixed(1) + ',' + yOf(disp[i]).toFixed(1);
			}
			return { c, d };
		})
	);

	// ---- frame ------------------------------------------------------------------------
	function frame(only: string[] | null = null) {
		const list = only?.length ? keys.filter((kk) => only.includes(kk.id)) : keys;
		let lo = Infinity;
		let hi = -Infinity;
		if (isQuat) {
			for (const vals of series.vals)
				for (const v of vals) {
					lo = Math.min(lo, v);
					hi = Math.max(hi, v);
				}
		} else if (isStep) {
			lo = 0;
			hi = 1;
		} else {
			for (let c = 0; c < w; c++) {
				const b = valueBounds(type, list, c);
				if (b) {
					lo = Math.min(lo, b.lo * k);
					hi = Math.max(hi, b.hi * k);
				}
			}
		}
		if (!Number.isFinite(lo)) {
			lo = -1;
			hi = 1;
		}
		if (hi - lo < 1e-6) {
			const m = Math.max(1, Math.abs(lo) * 0.1);
			lo -= m;
			hi += m;
		}
		const pad = (hi - lo) * 0.12;
		vLo = lo - pad;
		vHi = hi + pad;
	}
	let framedFor = '';
	$effect(() => {
		const key = track.id + ':' + (keys.length ? 1 : 0);
		if (key !== framedFor) {
			framedFor = key;
			untrack(() => frame());
		}
	});

	const gridLines = $derived.by(() => {
		const range = vHi - vLo;
		if (!(range > 0)) return [];
		const raw = range / 4;
		const p = Math.pow(10, Math.floor(Math.log10(raw)));
		const step = [1, 2, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? raw;
		const out = [];
		for (let v = Math.ceil(vLo / step) * step; v <= vHi; v += step) out.push(Math.round(v / step) * step);
		return out;
	});
	const fmt = (v: number) => {
		const a = Math.abs(v);
		return (a >= 100 ? v.toFixed(0) : a >= 1 ? v.toFixed(2).replace(/\.?0+$/, '') : v.toFixed(3).replace(/\.?0+$/, '')) || '0';
	};

	// ---- selection --------------------------------------------------------------------
	let sel = $state<string[]>([]);
	$effect(() => {
		// a remote edit or an undo can drop keys: keep only ids that still exist
		const ids = new Set(keys.map((kk) => kk.id));
		untrack(() => {
			if (sel.some((id) => !ids.has(id))) sel = sel.filter((id) => ids.has(id));
		});
	});
	const selKeys = $derived(keys.filter((kk) => sel.includes(kk.id)));
	const one = $derived(selKeys.length === 1 ? selKeys[0] : null);

	// ---- writing ----------------------------------------------------------------------
	function write(next: any[]) {
		updateTrack(seqId, track.id, { keys: next });
		onedited();
	}
	const snapT = (t: number, free = false) => (snapOn && !free ? Math.round(t * fps) / fps : t);

	type Drag =
		| { kind: 'keys'; x0: number; y0: number; keys0: any[]; ids: string[]; moved: boolean; anchorT: number }
		| { kind: 'handle'; id: string; side: 'in' | 'out'; keys0: any[]; moved: boolean }
		| { kind: 'box'; x0: number; y0: number; x1: number; y1: number; add: boolean; moved: boolean }
		| null;
	let drag = $state<Drag>(null);
	let svgEl: SVGSVGElement | null = $state(null);

	function local(e: PointerEvent) {
		const r = svgEl!.getBoundingClientRect();
		return { x: e.clientX - r.left, y: e.clientY - r.top };
	}

	function keyDown(e: PointerEvent, key: any) {
		e.stopPropagation();
		svgEl?.focus();
		if (e.button !== 0) return;
		if (e.shiftKey || e.ctrlKey || e.metaKey) {
			sel = sel.includes(key.id) ? sel.filter((id) => id !== key.id) : [...sel, key.id];
			if (!sel.includes(key.id)) return;
		} else if (!sel.includes(key.id)) sel = [key.id];
		if (readOnly) return;
		const p = local(e);
		drag = { kind: 'keys', x0: p.x, y0: p.y, keys0: keys, ids: sel.slice(), moved: false, anchorT: key.t };
		svgEl?.setPointerCapture(e.pointerId);
	}
	function handleDown(e: PointerEvent, key: any, side: 'in' | 'out') {
		e.stopPropagation();
		if (readOnly || e.button !== 0) return;
		drag = { kind: 'handle', id: key.id, side, keys0: keys, moved: false };
		svgEl?.setPointerCapture(e.pointerId);
	}
	function bgDown(e: PointerEvent) {
		svgEl?.focus();
		if (e.button !== 0) return;
		const p = local(e);
		drag = { kind: 'box', x0: p.x, y0: p.y, x1: p.x, y1: p.y, add: e.shiftKey || e.ctrlKey || e.metaKey, moved: false };
		svgEl?.setPointerCapture(e.pointerId);
	}
	function move(e: PointerEvent) {
		if (!drag) return;
		const p = local(e);
		if (drag.kind === 'box') {
			drag.x1 = p.x;
			drag.y1 = p.y;
			drag.moved = drag.moved || Math.hypot(p.x - drag.x0, p.y - drag.y0) > 4;
			return;
		}
		if (!drag.moved) {
			gesture.begin(seqId);
			drag.moved = true;
		}
		if (drag.kind === 'keys') {
			const d = drag;
			// time snaps the GRABBED key to a frame; the others keep their spacing
			const t = snapT(d.anchorT + (p.x - d.x0) / pps, e.altKey);
			const dt = Math.max(-Math.min(...d.keys0.filter((kk) => d.ids.includes(kk.id)).map((kk) => kk.t)), t - d.anchorT);
			let dv: any = 0;
			if (valueEditable) {
				const dDisp = vOf(p.y) - vOf(drag.y0);
				if (isStep) dv = 0;
				else if (w === 1) dv = dDisp / k;
				else dv = Array.from({ length: w }, (_, c) => (c === comp ? dDisp / k : 0));
			}
			let next = moveKeys(type, drag.keys0, drag.ids, dt, dv);
			if (isStep && valueEditable) {
				// a step value is 0 / 1: the pointer's half of the graph picks it
				const on = vOf(p.y) >= 0.5 ? 1 : 0;
				next = setKeys(type, next, drag.ids, { v: on });
			}
			write(next);
			return;
		}
		// a handle: absolute, from the gesture's start keys, in the key's own frame
		const key = drag.keys0.find((kk) => kk.id === (drag as any).id);
		if (!key) return;
		const old = (key[drag.side] ?? [0, ...new Array(w).fill(0)]).slice();
		let dt = tOf(p.x) - key.t;
		dt = drag.side === 'in' ? Math.min(0, dt) : Math.max(0, dt);
		const dvDisp = vOf(p.y) - shown(key.v);
		old[0] = dt;
		old[1 + comp] = dvDisp / k;
		write(setHandle(type, drag.keys0, key.id, drag.side, old));
	}
	function up(e: PointerEvent) {
		const d = drag;
		drag = null;
		if (!d) return;
		if (d.kind === 'box') {
			if (!d.moved) {
				if (!d.add) sel = [];
				return;
			}
			const [xa, xb] = [Math.min(d.x0, d.x1), Math.max(d.x0, d.x1)];
			const [ya, yb] = [Math.min(d.y0, d.y1), Math.max(d.y0, d.y1)];
			const hit = keys
				.filter((kk) => {
					const x = xOf(kk.t);
					const y = keyY(kk);
					return x >= xa && x <= xb && y >= ya && y <= yb;
				})
				.map((kk) => kk.id);
			sel = d.add ? [...new Set([...sel, ...hit])] : hit;
			return;
		}
		if (d.moved) gesture.end(seqId);
	}
	function cancel() {
		if (drag && drag.kind !== 'box' && drag.moved) {
			gesture.cancel(seqId);
			onedited();
		}
		drag = null;
	}
	function bgDouble(e: MouseEvent) {
		if (readOnly) return;
		const r = svgEl!.getBoundingClientRect();
		const t = snapT(Math.max(0, tOf(e.clientX - r.left)), e.altKey);
		addKeyAt(t, isQuat ? null : vOf(e.clientY - r.top));
	}

	/** a key at `t`: the curve's own value there (the pointer's value on a number curve) */
	function addKeyAt(t: number, dispV: number | null) {
		let v: any = sampleCurve(type, keys, t);
		if (v === null) v = liveValue();
		if (v === null || v === undefined) return;
		if (dispV !== null && valueEditable) {
			if (isStep) v = dispV >= 0.5 ? 1 : 0;
			else if (w === 1) v = dispV / k;
			else v = v.map((c: number, i: number) => (i === comp ? dispV / k : c));
		}
		const next = insertKey(type, keys, t, v, { src: 'user' });
		const hit = next.find((kk) => Math.abs(kk.t - t) <= SAME_TIME);
		write(next);
		if (hit) sel = [hit.id];
	}
	/** K: key the object's value NOW at the playhead (move it with the gizmo, then key it) */
	function keyAtPlayhead() {
		if (readOnly) return;
		const v = liveValue() ?? sampleCurve(type, keys, playhead);
		if (v === null || v === undefined) return;
		const t = snapT(playhead);
		const next = insertKey(type, keys, t, v, { src: 'user' });
		const hit = next.find((kk) => Math.abs(kk.t - t) <= SAME_TIME);
		write(next);
		if (hit) sel = [hit.id];
	}

	// ---- keyboard (the editor's capture handler leaves these keys to a focused graph) -----
	function onKey(e: KeyboardEvent) {
		const mod = e.ctrlKey || e.metaKey;
		let used = true;
		const frameT = 1 / Math.max(1, fps);
		if ((e.key === 'Delete' || e.key === 'Backspace') && sel.length && !readOnly) {
			write(deleteKeys(type, keys, sel));
			sel = [];
		} else if (mod && (e.key === 'a' || e.key === 'A')) sel = keys.map((kk) => kk.id);
		else if (mod && (e.key === 'c' || e.key === 'C')) {
			const clip = copyKeys(type, keys, sel);
			if (clip) clipboard = clip;
		} else if (mod && (e.key === 'v' || e.key === 'V') && !readOnly) paste();
		else if (e.key === 'Escape') {
			if (drag) cancel();
			else sel = [];
		} else if ((e.key === 'f' || e.key === 'F') && !mod) frame(e.shiftKey ? sel : null);
		else if ((e.key === 'k' || e.key === 'K') && !mod) keyAtPlayhead();
		else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && sel.length && !readOnly) {
			const step = (e.key === 'ArrowLeft' ? -1 : 1) * frameT * (e.shiftKey ? 10 : 1);
			const minT = Math.min(...selKeys.map((kk) => kk.t));
			write(moveKeys(type, keys, sel, Math.max(step, -minT), 0));
		} else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && sel.length && valueEditable && !isStep) {
			const dDisp = ((e.key === 'ArrowUp' ? 1 : -1) * (vHi - vLo)) / (e.shiftKey ? 10 : 100);
			const dv = w === 1 ? dDisp / k : Array.from({ length: w }, (_, c) => (c === comp ? dDisp / k : 0));
			write(moveKeys(type, keys, sel, 0, dv));
		} else used = false;
		if (used) {
			e.preventDefault();
			e.stopPropagation();
		}
	}
	function paste() {
		const { keys: next, ids } = pasteKeys(type, keys, clipboard, snapT(playhead), { period: isAngle ? 2 * Math.PI : 0 });
		if (!ids.length) return;
		write(next);
		sel = ids;
	}

	// ---- controls ---------------------------------------------------------------------
	const modeItems = $derived(
		Object.entries(KEY_MODES)
			.filter(([m]) => (isQuat ? m === 'linear' || m === 'stepped' : isStep ? m === 'stepped' : true))
			.map(([value, m]) => ({ value, name: m.label }))
	);
	const selMode = $derived.by(() => {
		const modes = new Set(selKeys.map(keyModeOf));
		return modes.size === 1 ? [...modes][0] : undefined;
	});
	const presetItems = $derived(
		Object.entries(EASE_PRESETS)
			.filter(([p]) => canBezier(type) || p === 'linear' || p === 'stepped')
			.map(([value, p]) => ({ value, name: p.label }))
	);
	function setMode(m: string) {
		if (readOnly || !sel.length) return;
		write(setKeyMode(type, keys, sel, m));
	}
	function preset(p: string) {
		if (readOnly || !sel.length) return;
		write(applyPreset(type, keys, sel, p));
	}
	function entry(field: 't' | 'v', raw: string) {
		if (readOnly || !sel.length) return;
		const n = Number(raw);
		if (!Number.isFinite(n)) return;
		if (field === 't') {
			if (one) write(setKeys(type, keys, [one.id], { t: Math.max(0, n) }));
			return;
		}
		if (!valueEditable) return;
		// several keys: each keeps its other components
		let next = keys;
		for (const kk of selKeys) {
			const v = isStep ? (n >= 0.5 ? 1 : 0) : w === 1 ? n / k : kk.v.map((c: number, i: number) => (i === comp ? n / k : c));
			next = setKeys(type, next, [kk.id], { v });
		}
		write(next);
	}

	// ---- drawing helpers --------------------------------------------------------------
	function keyY(kk: any) {
		if (isQuat) return H - PAD;
		return yOf(shown(kk.v));
	}
	function handlePoints(kk: any, n: number) {
		if (!canBezier(type)) return [];
		const out: { side: 'in' | 'out'; x: number; y: number }[] = [];
		const prev = keys[n - 1];
		if (kk.out && kk.i === 'bezier' && n < keys.length - 1)
			out.push({ side: 'out', x: xOf(kk.t + kk.out[0]), y: yOf(shown(kk.v) + (kk.out[1 + comp] ?? 0) * k) });
		if (kk.in && prev?.i === 'bezier')
			out.push({ side: 'in', x: xOf(kk.t + kk.in[0]), y: yOf(shown(kk.v) + (kk.in[1 + comp] ?? 0) * k) });
		return out;
	}
	const playX = $derived(xOf(playhead));
	const box = $derived(
		drag && drag.kind === 'box' && drag.moved
			? { x: Math.min(drag.x0, drag.x1), y: Math.min(drag.y0, drag.y1), w: Math.abs(drag.x1 - drag.x0), h: Math.abs(drag.y1 - drag.y0) }
			: null
	);
	const label = $derived((def?.label ?? track.path) + (isQuat ? ' (read-out in degrees)' : ''));
</script>

<svelte:window bind:innerWidth={winW} />

<div class="cg-head" data-curve-head={track.id} style="height: {H}px">
	<div class="cg-row">
		<span class="cg-title" title={label}><Icon name="spline" size={16} /> Curve</span>
		<button class="cg-btn" title="Frame all keys (F)" aria-label="Frame all keys" data-curve-frame onclick={() => frame()}
			><Icon name="maximize-2" size={16} /></button
		>
		<button
			class="cg-btn"
			title="Frame the selected keys (Shift+F)"
			aria-label="Frame the selected keys"
			disabled={!sel.length}
			onclick={() => frame(sel)}><Icon name="focus" size={16} /></button
		>
	</div>
	{#if w > 1 && !isQuat}
		<div class="cg-row" role="group" aria-label="Component to edit">
			{#each COMP_NAMES.slice(0, w) as name, c}
				<button
					class="cg-chip"
					aria-pressed={comp === c}
					title="Edit {name}"
					data-curve-comp={c}
					style="--cg-c: {COMP_COLOR[c]}"
					onclick={() => (comp = c)}>{name}</button
				>
			{/each}
		</div>
	{/if}
	{#if readOnly}
		<span class="cg-note" role="note">View only on a small screen</span>
	{:else if isQuat}
		<span class="cg-note" role="note">A recorded rotation: drag keys in time; values come from the take</span>
	{/if}
	{#if sel.length && !readOnly}
		<div class="cg-row">
			<label class="cg-field" title="Key time in seconds"
				><span>Time</span><input
					type="number"
					step={1 / Math.max(1, fps)}
					disabled={!one}
					data-curve-time
					value={one ? +one.t.toFixed(4) : ''}
					onchange={(e) => entry('t', e.currentTarget.value)}
				/></label
			>
			{#if valueEditable}
				<label class="cg-field" title="Key value{unit ? ' (' + unit + ')' : ''}"
					><span>Value{unit ? ' ' + unit : ''}</span><input
						type="number"
						step="any"
						data-curve-value
						value={one ? +shown(one.v).toFixed(4) : ''}
						placeholder={one ? '' : 'several'}
						onchange={(e) => entry('v', e.currentTarget.value)}
					/></label
				>
			{/if}
		</div>
		<div class="cg-row cg-pick" title="Key mode (the shape after the key, and its handles)">
			<ThemedSelect id="curve-mode-{track.id}" clip={false} placeholder="Mode" items={modeItems} value={selMode} onchange={setMode} />
		</div>
		<div class="cg-row cg-pick" title="Ease the segment after each selected key">
			<ThemedSelect id="curve-preset-{track.id}" clip={false} placeholder="Ease preset" items={presetItems} value={undefined} onchange={preset} />
		</div>
	{/if}
</div>

<!-- the keyboard path is the focusable graph itself (select all, arrows nudge, K, Delete, copy / paste);
     keys and handles are its pointer targets -->
<div class="cg-lane" style="height: {H}px" data-curve-graph={track.id} data-curve-readonly={readOnly ? '' : undefined}>
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions, a11y_no_noninteractive_tabindex -->
	<svg
		bind:this={svgEl}
		width={width}
		height={H}
		tabindex="0"
		role="application"
		aria-label="{label} curve. Click a key to select, drag to move; drag a handle to shape; double-click to add a key; K keys the object at the playhead; Delete, Ctrl+C, Ctrl+V, F frames all"
		onpointerdown={bgDown}
		onpointermove={move}
		onpointerup={up}
		onpointercancel={cancel}
		ondblclick={bgDouble}
		onkeydown={onKey}
	>
		{#each gridLines as v (v)}
			<line class="cg-grid" x1="0" x2={width} y1={yOf(v)} y2={yOf(v)} />
			<text class="cg-glabel" x="4" y={yOf(v) - 2}>{fmt(v)}{unit}</text>
		{/each}
		<line class="cg-play" x1={playX} x2={playX} y1="0" y2={H} />
		{#each lines as l (l.c)}
			<path
				class="cg-curve"
				class:cg-dim={(w > 1 || isQuat) && !isQuat && l.c !== comp}
				d={l.d}
				style={w > 1 || isQuat ? `stroke: ${COMP_COLOR[l.c]}` : ''}
				data-curve-line={l.c}
			/>
		{/each}
		{#each keys as kk, n (kk.id)}
			{@const s = sel.includes(kk.id)}
			{#if s && !readOnly}
				{#each handlePoints(kk, n) as h (h.side)}
					<line class="cg-hline" x1={xOf(kk.t)} y1={keyY(kk)} x2={h.x} y2={h.y} />
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<circle
						class="cg-handle"
						cx={h.x}
						cy={h.y}
						r="4"
						data-curve-handle="{kk.id}:{h.side}"
						onpointerdown={(e) => handleDown(e, kk, h.side)}
					/>
				{/each}
			{/if}
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<rect
				class="cg-key"
				class:cg-sel={s}
				class:cg-user={kk.src === 'user'}
				x={xOf(kk.t) - KEY_R}
				y={keyY(kk) - KEY_R}
				width={KEY_R * 2}
				height={KEY_R * 2}
				transform="rotate(45 {xOf(kk.t)} {keyY(kk)})"
				data-curve-key={kk.id}
				onpointerdown={(e) => keyDown(e, kk)}
			/>
		{/each}
		{#if box}
			<rect class="cg-box" x={box.x} y={box.y} width={box.w} height={box.h} />
		{/if}
	</svg>
</div>

<style>
	.cg-head {
		display: flex;
		flex-direction: column;
		gap: 4px;
		min-width: 0;
		padding: 4px 4px 4px 8px;
		overflow: hidden;
		border-bottom: 1px solid var(--border);
		background: var(--surface-1);
		font-size: var(--fs-desc);
	}
	.cg-row {
		display: flex;
		align-items: center;
		gap: 4px;
		min-width: 0;
	}
	.cg-title {
		display: inline-flex;
		flex: 1 1 auto;
		align-items: center;
		gap: 4px;
		color: var(--text-muted);
	}
	.cg-btn,
	.cg-chip {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 24px;
		height: 24px;
		padding: 0 6px;
		border: 1px solid transparent;
		border-radius: var(--radius-sm, 4px);
		background: transparent;
		color: var(--text);
		font: inherit;
		cursor: pointer;
	}
	.cg-btn:hover,
	.cg-chip:hover {
		background: var(--surface-hover);
	}
	.cg-btn:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}
	.cg-btn:focus-visible,
	.cg-chip:focus-visible,
	.cg-lane svg:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}
	.cg-chip {
		border-color: var(--border);
		color: var(--cg-c);
		font-weight: 600;
	}
	.cg-chip[aria-pressed='true'] {
		border-color: var(--cg-c);
		background: color-mix(in srgb, var(--cg-c) 16%, transparent);
	}
	.cg-field {
		display: flex;
		flex: 1 1 0;
		flex-direction: column;
		min-width: 0;
		color: var(--text-muted);
	}
	.cg-field input {
		width: 100%;
		min-width: 0;
		height: 24px;
		padding: 0 4px;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm, 4px);
		background: var(--surface-2);
		color: var(--text);
		font: inherit;
	}
	.cg-pick :global(.themed-select),
	.cg-pick :global(button) {
		width: 100%;
	}
	.cg-note {
		color: var(--text-muted);
	}
	.cg-lane {
		position: relative;
		overflow: hidden;
		border-bottom: 1px solid var(--border);
		background: var(--surface-0, var(--surface-1));
		touch-action: none;
	}
	.cg-lane svg {
		display: block;
		user-select: none;
	}
	.cg-grid {
		stroke: var(--border);
		stroke-width: 1;
	}
	.cg-glabel {
		fill: var(--text-muted);
		font-size: 10px;
		pointer-events: none;
	}
	.cg-play {
		stroke: var(--accent);
		stroke-width: 1;
		opacity: 0.7;
		pointer-events: none;
	}
	.cg-curve {
		fill: none;
		stroke: var(--accent);
		stroke-width: 2;
		pointer-events: none;
	}
	.cg-curve.cg-dim {
		opacity: 0.35;
		stroke-width: 1.5;
	}
	.cg-key {
		fill: color-mix(in srgb, var(--accent) 45%, var(--surface-1));
		stroke: var(--accent);
		stroke-width: 1.5;
		cursor: grab;
	}
	.cg-key.cg-user {
		fill: var(--accent);
	}
	.cg-key.cg-sel {
		fill: var(--text);
		stroke: var(--text);
	}
	.cg-hline {
		stroke: var(--text-muted);
		stroke-width: 1;
		pointer-events: none;
	}
	.cg-handle {
		fill: var(--surface-1);
		stroke: var(--text);
		stroke-width: 1.5;
		cursor: grab;
	}
	.cg-box {
		fill: color-mix(in srgb, var(--accent) 12%, transparent);
		stroke: var(--accent);
		stroke-dasharray: 3 2;
		pointer-events: none;
	}
	[data-curve-readonly] .cg-key {
		cursor: default;
	}
</style>

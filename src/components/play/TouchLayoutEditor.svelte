<script>
	// 36 U8: THE TOUCH LAYOUT EDITOR — drag, resize and fade every on-screen control, for
	// this game or for every game, saved on this device. Opened from Settings ▸ Touch
	// controls ▸ Edit layout and from the pause menu (touchActions.openTouchLayoutEditor).
	//
	// It edits exactly what the overlay draws (touchSpec + the same effectiveTouchLayout),
	// on a WORKING COPY: nothing is written until Save, Cancel/Escape throws it away, and
	// Reset puts the default arrangement back for the chosen scope. Every pointer is its own
	// drag, so two fingers move two buttons at once; a second finger beside one that holds
	// a control PINCHES it (size), and the selected control also has a corner grip and two
	// sliders, so a mouse can do everything a hand can.
	//
	// Listeners are DIRECT and on the window for the same reasons as the overlay (delegated
	// handlers die in panel chrome; a drag must survive leaving its element).
	import { onMount, untrack } from 'svelte';
	import { get } from 'svelte/store';
	import { X, RotateCcw, Check } from '@lucide/svelte';
	import { gameId } from '$lib/gameSettings';
	import {
		touchPrefs,
		setTouchPrefs,
		touchLayouts,
		touchTextures,
		savedLayoutFor,
		effectiveTouchLayout,
		defaultTouchLayout,
		saveTouchLayout,
		resetTouchLayout,
		resolveTouchControls,
		closeTouchLayoutEditor,
		TOUCH_SIZE_RANGE,
		TOUCH_OPACITY_RANGE
	} from '$lib/touchActions';
	import { touchSpec } from '$lib/touchSpec';
	import TouchActionButton from './TouchActionButton.svelte';

	let viewW = $state(typeof window === 'undefined' ? 1280 : window.innerWidth);
	let viewH = $state(typeof window === 'undefined' ? 720 : window.innerHeight);

	// a scene with no buttons of its own still gets something to arrange: the shooter frame
	// (stick + Fire + Jump), which is what a saved GLOBAL layout mostly serves
	const sceneSpec = get(touchSpec);
	const demo = sceneSpec.actions.length === 0;
	const spec = demo ? resolveTouchControls({ declared: [{ owner: '', actions: [], preset: 'shooter', at: 0 }] }) : sceneSpec;
	const game = get(gameId);

	let scope = $state(/** @type {'game' | 'global'} */ (get(touchPrefs).scope));
	/** the working copy, item key -> item */
	let items = $state(
		structuredClone(
			effectiveTouchLayout(spec, savedLayoutFor(get(touchLayouts), game), window.innerWidth, window.innerHeight).items
		)
	);
	let selected = $state(/** @type {string | null} */ (spec.actions[0] ? 'btn:' + spec.actions[0].id : 'stick'));
	let dirty = $state(false);

	/** @param {string} key */
	function labelOf(key) {
		if (key === 'stick') return 'Move stick';
		const action = spec.actions.find((a) => 'btn:' + a.id === key);
		return action ? action.label : key;
	}

	const keys = $derived(['stick', ...spec.actions.map((a) => 'btn:' + a.id)].filter((k) => items[k]));
	const sel = $derived(selected && items[selected] ? items[selected] : null);

	/** @param {number} v @param {number} lo @param {number} hi */
	const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

	/** @param {string} key @param {Partial<import('$lib/touchActions').TouchItem>} patch */
	function patchItem(key, patch) {
		if (!items[key]) return;
		items[key] = { ...items[key], ...patch };
		dirty = true;
	}

	/** pointer id -> what it is doing @type {Map<number, {key: string, kind: 'move'|'resize', sx: number, sy: number, ix: number, iy: number, size: number}>} */
	const drags = new Map();
	/** @type {{key: string, a: number, b: number, dist: number, size: number} | null} */
	let pinch = null;

	/** where each live pointer is now @type {Map<number, {x: number, y: number}>} */
	const points = new Map();

	/** @param {PointerEvent} e */
	function onDown(e) {
		const target = /** @type {Element | null} */ (e.target instanceof Element ? e.target : null);
		if (!target || !target.closest('#touch-layout-editor')) return;
		if (target.closest('.tle-panel')) return; // the controls are ordinary UI
		points.set(e.pointerId, { x: e.clientX, y: e.clientY });
		const grip = target.closest('[data-edit-grip]');
		const itemEl = target.closest('[data-edit-item]');
		const key = (grip ?? itemEl)?.getAttribute(grip ? 'data-edit-grip' : 'data-edit-item') ?? null;
		e.preventDefault();
		if (key && items[key]) {
			selected = key;
			const it = items[key];
			drags.set(e.pointerId, { key, kind: grip ? 'resize' : 'move', sx: e.clientX, sy: e.clientY, ix: it.x, iy: it.y, size: it.size });
			return;
		}
		// a finger on empty space while another holds a control = pinch that control
		const holder = [...drags.entries()].find(([, d]) => d.kind === 'move');
		if (holder) {
			const [otherId, d] = holder;
			const other = points.get(otherId);
			if (other) {
				pinch = { key: d.key, a: otherId, b: e.pointerId, dist: Math.max(10, Math.hypot(e.clientX - other.x, e.clientY - other.y)), size: items[d.key].size };
				return;
			}
		}
		selected = null;
	}

	/** @param {PointerEvent} e */
	function onMove(e) {
		if (!points.has(e.pointerId)) return;
		points.set(e.pointerId, { x: e.clientX, y: e.clientY });
		if (pinch && (e.pointerId === pinch.a || e.pointerId === pinch.b)) {
			const pa = points.get(pinch.a);
			const pb = points.get(pinch.b);
			if (pa && pb) {
				const dist = Math.hypot(pa.x - pb.x, pa.y - pb.y);
				patchItem(pinch.key, { size: Math.round(clamp((pinch.size * dist) / pinch.dist, TOUCH_SIZE_RANGE.min, TOUCH_SIZE_RANGE.max)) });
			}
			if (e.pointerId === pinch.b) return;
		}
		const d = drags.get(e.pointerId);
		if (!d) return;
		if (d.kind === 'resize') {
			// the grip sits on the circle's lower-right edge: grow by the outward travel
			const grow = ((e.clientX - d.sx) + (e.clientY - d.sy)) / Math.SQRT2;
			patchItem(d.key, { size: Math.round(clamp(d.size + grow * 2, TOUCH_SIZE_RANGE.min, TOUCH_SIZE_RANGE.max)) });
			return;
		}
		patchItem(d.key, {
			x: clamp(d.ix + (e.clientX - d.sx) / viewW, 0, 1),
			y: clamp(d.iy + (e.clientY - d.sy) / viewH, 0, 1)
		});
	}

	/** @param {PointerEvent} e */
	function onUp(e) {
		points.delete(e.pointerId);
		drags.delete(e.pointerId);
		if (pinch && (e.pointerId === pinch.a || e.pointerId === pinch.b)) pinch = null;
	}

	/** @param {KeyboardEvent} e */
	function onKey(e) {
		if (e.key === 'Escape') {
			e.preventDefault();
			e.stopImmediatePropagation();
			closeTouchLayoutEditor();
		}
	}

	function onResize() {
		viewW = window.innerWidth;
		viewH = window.innerHeight;
	}

	onMount(() => {
		window.addEventListener('pointerdown', onDown, true);
		window.addEventListener('pointermove', onMove);
		window.addEventListener('pointerup', onUp, true);
		window.addEventListener('pointercancel', onUp, true);
		window.addEventListener('keydown', onKey, true);
		window.addEventListener('resize', onResize);
		return () => {
			window.removeEventListener('pointerdown', onDown, true);
			window.removeEventListener('pointermove', onMove);
			window.removeEventListener('pointerup', onUp, true);
			window.removeEventListener('pointercancel', onUp, true);
			window.removeEventListener('keydown', onKey, true);
			window.removeEventListener('resize', onResize);
		};
	});

	/** @param {'game' | 'global'} next */
	function pickScope(next) {
		scope = next;
		setTouchPrefs({ scope: next });
		// show what that scope would load, unless the player has already moved things
		if (!dirty) {
			const store = get(touchLayouts);
			const saved = next === 'global' ? store.global : savedLayoutFor(store, game);
			items = structuredClone(effectiveTouchLayout(spec, saved, viewW, viewH).items);
		}
	}

	function reset() {
		resetTouchLayout(scope, game);
		const store = get(touchLayouts);
		const fallback = scope === 'game' ? store.global : null;
		items = structuredClone(effectiveTouchLayout(spec, fallback, viewW, viewH).items);
		dirty = false;
	}

	function save() {
		saveTouchLayout({ v: 1, items: untrack(() => $state.snapshot(items)) }, scope, game);
		closeTouchLayoutEditor();
	}

	const defaults = $derived(defaultTouchLayout(spec, viewW, viewH).items);
	/** @param {number} frac @param {number} span @param {number} size */
	function placed(frac, span, size) {
		return Math.min(span - size / 2 - 4, Math.max(size / 2 + 4, frac * span));
	}
</script>

<div id="touch-layout-editor" class="tle" role="dialog" aria-label="Touch controls layout">
	<div class="tle-grid" aria-hidden="true"></div>
	{#each keys as key (key)}
		{@const it = items[key]}
		{@const action = spec.actions.find((a) => 'btn:' + a.id === key)}
		<div
			class="tle-item"
			class:selected={selected === key}
			class:hidden-item={it.hidden}
			data-edit-item={key}
			style:left="{placed(it.x, viewW, it.size)}px"
			style:top="{placed(it.y, viewH, it.size)}px"
			style:width="{it.size}px"
			style:height="{it.size}px"
		>
			{#if action}
				<TouchActionButton {action} size={it.size} texture={$touchTextures[action.id] ?? null} opacity={it.opacity} />
			{:else}
				<span class="tle-stick" style:opacity={it.opacity}><span class="tle-nub"></span></span>
			{/if}
			<span class="tle-name">{labelOf(key)}</span>
			{#if selected === key}
				<span class="tle-grip" data-edit-grip={key} title="Drag to resize" aria-hidden="true"></span>
			{/if}
		</div>
	{/each}

	<div class="tle-panel" data-tour="touch-layout-panel">
		<div class="tle-row tle-head">
			<strong>Touch controls layout</strong>
			<span class="tle-seg tp-seg" role="group" aria-label="Save for">
				<button type="button" id="touch-layout-scope-game" class="tp-seg-btn" aria-pressed={scope === 'game'} onclick={() => pickScope('game')}>This game</button>
				<button type="button" id="touch-layout-scope-global" class="tp-seg-btn" aria-pressed={scope === 'global'} onclick={() => pickScope('global')}>All games</button>
			</span>
		</div>
		{#if demo}
			<p class="tle-hint">This scene has no action buttons of its own — arranging the usual Fire and Jump here sets the layout games start from.</p>
		{/if}
		{#if sel && selected}
			<div class="tle-row">
				<span class="tle-sel" id="touch-layout-selected">{labelOf(selected)}</span>
				<label class="tle-check"><input id="touch-layout-hide" class="tp-check" type="checkbox" checked={!!sel.hidden} onchange={(e) => patchItem(/** @type {string} */ (selected), { hidden: e.currentTarget.checked })} /> Hide</label>
			</div>
			<label class="tle-row tle-slider">
				<span>Size</span>
				<input
					id="touch-layout-size"
					type="range"
					min={TOUCH_SIZE_RANGE.min}
					max={TOUCH_SIZE_RANGE.max}
					step="2"
					value={sel.size}
					oninput={(e) => patchItem(/** @type {string} */ (selected), { size: Number(e.currentTarget.value) })}
				/>
				<span class="tle-num">{sel.size}px</span>
			</label>
			<label class="tle-row tle-slider">
				<span>Opacity</span>
				<input
					id="touch-layout-opacity"
					type="range"
					min={TOUCH_OPACITY_RANGE.min}
					max={TOUCH_OPACITY_RANGE.max}
					step="0.05"
					value={sel.opacity}
					oninput={(e) => patchItem(/** @type {string} */ (selected), { opacity: Number(e.currentTarget.value) })}
				/>
				<span class="tle-num">{Math.round(sel.opacity * 100)}%</span>
			</label>
			<div class="tle-row">
				<button type="button" class="tle-btn" id="touch-layout-default-item" onclick={() => selected && defaults[selected] && patchItem(selected, { ...defaults[selected], hidden: false })}>Default place</button>
			</div>
		{:else}
			<p class="tle-hint">Drag a control to move it. Select one to resize it (or pinch it with a second finger).</p>
		{/if}
		<div class="tle-row tle-actions">
			<button type="button" class="tle-btn" id="touch-layout-reset" data-tour="touch-layout-reset" onclick={reset}><RotateCcw size={14} aria-hidden="true" /> Reset</button>
			<span class="tle-spacer"></span>
			<button type="button" class="tle-btn" id="touch-layout-cancel" onclick={() => closeTouchLayoutEditor()}><X size={14} aria-hidden="true" /> Cancel</button>
			<button type="button" class="tle-btn tle-primary" id="touch-layout-save" data-tour="touch-layout-save" onclick={save}><Check size={14} aria-hidden="true" /> Save</button>
		</div>
	</div>
</div>

<style>
	.tle {
		position: fixed;
		inset: 0;
		z-index: calc(var(--z-modal, 1100) + 10);
		background: rgb(var(--surface-deep-rgb, 0 0 0) / 0.42);
		touch-action: none;
		user-select: none;
		-webkit-user-select: none;
		color: var(--text, #f3f4f6);
	}
	.tle-grid {
		position: absolute;
		inset: 0;
		pointer-events: none;
		background-image:
			linear-gradient(to right, rgb(var(--surface-rgb, 255 255 255) / 0.08) 1px, transparent 1px),
			linear-gradient(to bottom, rgb(var(--surface-rgb, 255 255 255) / 0.08) 1px, transparent 1px);
		background-size: 40px 40px;
	}
	.tle-item {
		position: absolute;
		transform: translate(-50%, -50%);
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: grab;
		border-radius: 9999px;
		outline: 2px dashed transparent;
		outline-offset: 3px;
	}
	.tle-item.selected {
		outline-color: var(--accent, #3b82f6);
	}
	.tle-item.hidden-item {
		filter: grayscale(1);
		opacity: 0.35;
	}
	.tle-name {
		position: absolute;
		top: 100%;
		margin-top: 6px;
		font-size: 11px;
		font-weight: 600;
		white-space: nowrap;
		padding: 1px 6px;
		border-radius: 4px;
		background: rgb(var(--surface-deep-rgb, 0 0 0) / 0.7);
		pointer-events: none;
	}
	.tle-stick {
		position: relative;
		width: 100%;
		height: 100%;
		border-radius: 9999px;
		border: 2px solid rgb(var(--surface-rgb, 255 255 255) / 0.5);
		background: rgb(var(--surface-deep-rgb, 0 0 0) / 0.3);
		box-sizing: border-box;
		pointer-events: none;
	}
	.tle-nub {
		position: absolute;
		left: 50%;
		top: 50%;
		width: 41%;
		height: 41%;
		transform: translate(-50%, -50%);
		border-radius: 9999px;
		background: color-mix(in srgb, var(--text, #fff) 55%, transparent);
	}
	.tle-grip {
		position: absolute;
		right: 4%;
		bottom: 4%;
		width: 22px;
		height: 22px;
		border-radius: 9999px;
		background: var(--accent, #3b82f6);
		border: 2px solid var(--text, #fff);
		cursor: nwse-resize;
		transform: translate(50%, 50%);
	}
	.tle-panel {
		position: absolute;
		left: 50%;
		top: max(12px, env(safe-area-inset-top));
		transform: translateX(-50%);
		width: min(420px, calc(100vw - 32px));
		box-sizing: border-box;
		padding: 10px 12px;
		border-radius: 10px;
		border: 1px solid var(--border, #374151);
		background: var(--surface, #1f2937);
		color: var(--text, #f3f4f6);
		box-shadow: 0 8px 24px rgb(0 0 0 / 0.35);
		user-select: auto;
		touch-action: manipulation;
		display: flex;
		flex-direction: column;
		gap: 8px;
		font-size: 13px;
	}
	.tle-row {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.tle-head {
		justify-content: space-between;
		flex-wrap: wrap;
	}
	.tle-slider span:first-child {
		width: 58px;
		color: var(--text-2, #d1d5db);
	}
	.tle-slider input {
		flex: 1;
		min-width: 0;
	}
	.tle-num {
		width: 44px;
		text-align: right;
		font-variant-numeric: tabular-nums;
		color: var(--text-2, #d1d5db);
	}
	.tle-sel {
		font-weight: 600;
		flex: 1;
	}
	.tle-check {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}
	.tle-hint {
		margin: 0;
		font-size: 12px;
		color: var(--muted, #9ca3af);
	}
	.tle-spacer {
		flex: 1;
	}
	.tle-btn {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 5px 10px;
		border-radius: 6px;
		border: 1px solid var(--border, #374151);
		background: var(--surface-2, #374151);
		color: var(--text, #f3f4f6);
		font-size: 12px;
		cursor: pointer;
	}
	.tle-btn:hover {
		background: var(--hover, #4b5563);
	}
	.tle-primary {
		background: var(--accent, #3b82f6);
		border-color: var(--accent, #3b82f6);
		color: #fff;
	}
	.tle-primary:hover {
		background: var(--accent-2, #2563eb);
	}
</style>

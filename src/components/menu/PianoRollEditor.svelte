<script>
	// 75 MU2 — the piano roll: a looping clip of notes for any device that plays notes.
	// Mounted by musicToolbox.js into the shared toolbox shell (so it is a floating window on
	// desktop and the bottom sheet on a phone). The clip lives in the device document
	// (pianoRoll.js); every write goes through setRoll / previewRoll, so it replicates, saves
	// and undoes like a knob: a click is one entry, a drag previews (throttled broadcast) and
	// commits ONE entry carrying the document it started from — modalGrab's contract.
	import { onMount } from 'svelte';
	import { objectsGroup } from '../../stores/sceneStore';
	import { deviceCatalogVersion, findDeviceObject, noteDevice } from '$lib/audioDevices';
	import { transport, toggleTransport, transportNow } from '$lib/musicClock';
	import { createGesture } from '$lib/modalGrab';
	import {
		rollOf,
		setRoll,
		previewRoll,
		withNote,
		withoutNotes,
		shiftNotes,
		noteKey,
		normalizeRoll,
		listNoteDevices,
		pianoRollPick,
		ROLL_STEP,
		ROLL_BAR_CHOICES
	} from '$lib/pianoRoll';
	import { noteName } from '$lib/midiInput';

	const CELL = 16; // px per sixteenth
	const ROW = 14; // px per semitone
	const ROWS = 24; // two octaves on screen
	const SEND_MS = 66;
	const LENGTHS = [
		{ value: 0.25, label: '1/16' },
		{ value: 0.5, label: '1/8' },
		{ value: 1, label: '1/4' },
		{ value: 2, label: '1/2' },
		{ value: 4, label: '1 bar' }
	];

	let tick = $state(0);
	let pickedUuid = $state('');
	$effect(() => {
		const uuid = $pianoRollPick;
		if (uuid) {
			pickedUuid = uuid;
			pianoRollPick.set('');
		}
	});
	const devices = $derived.by(() => {
		void tick;
		void $objectsGroup;
		void $deviceCatalogVersion;
		return listNoteDevices();
	});
	const current = $derived(devices.find((d) => d.uuid === pickedUuid) ?? devices[0] ?? null);
	const roll = $derived.by(() => {
		void tick;
		void $objectsGroup;
		return current ? rollOf(findDeviceObject(current.uuid)) : normalizeRoll(null);
	});

	/** the lowest pitch on screen (C3 by default; the octave buttons move it) */
	let low = $state(48);
	let length = $state(1);
	/** selected notes by `p@s` @type {Set<string>} */
	let selected = $state(new Set());
	/** the notes as the grid draws them — a drag shows its preview here at once */
	const shown = $derived(roll.notes);
	const span = $derived(roll.bars * 4);
	const pitches = $derived(Array.from({ length: ROWS }, (_, i) => low + ROWS - 1 - i));
	let announce = $state('');

	// ---- writes ---------------------------------------------------------------------------

	/** @param {any} next */
	function commit(next) {
		if (!current) return;
		setRoll(current.uuid, next);
		tick++;
	}
	/** a quiet local audition of a note you placed (this screen only) @param {number} p */
	function audition(p) {
		if (current) noteDevice(current.uuid, { note: p, velocity: 0.6, gate: 0.2 }, { replicate: false });
	}

	// ---- the drag (move / stretch) ----------------------------------------------------------

	/** @type {{uuid: string, before: any, keys: Set<string>, mode: 'move'|'stretch', lastSent: number, moved: boolean, last: any}|null} */
	let drag = null;
	const gesture = createGesture({
		snapshot: () => (current && selected.size ? { roll, before: structuredClone(findDeviceObject(current.uuid)?.userData.device) } : null),
		start(ctx) {
			if (!current) return false;
			drag = { uuid: current.uuid, before: ctx.snapshot.before, keys: new Set(selected), mode: ctx.data?.mode ?? 'move', lastSent: 0, moved: false, last: null };
		},
		apply(ctx) {
			if (!drag) return;
			const delta = drag.mode === 'stretch' ? { dLength: Math.round(ctx.dx / CELL) * ROLL_STEP } : { dBeat: Math.round(ctx.dx / CELL) * ROLL_STEP, dPitch: -Math.round(ctx.dy / ROW) };
			const next = shiftNotes(ctx.snapshot.roll, drag.keys, delta);
			drag.moved = drag.moved || Object.values(delta).some((v) => v !== 0);
			if (!drag.moved) return;
			const now = Date.now();
			const broadcast = now - drag.lastSent >= SEND_MS;
			if (broadcast) drag.lastSent = now;
			previewRoll(drag.uuid, next, broadcast);
			drag.last = { next, delta };
			tick++;
		},
		revert(ctx) {
			if (drag) previewRoll(drag.uuid, ctx.snapshot.roll, true);
		},
		end(_ctx, kept) {
			const open = drag;
			drag = null;
			if (!open || !kept || !open.moved || !open.last) {
				tick++;
				return;
			}
			setRoll(open.uuid, open.last.next, { before: open.before });
			// the selection follows the notes to where they landed
			const d = open.last.delta;
			selected = new Set([...open.keys].map((k) => {
				const [p, s] = k.split('@').map(Number);
				const n = open.last.next.notes.find((/** @type {any} */ x) => x.p === p + (d.dPitch ?? 0) && Math.abs(x.s - (s + (d.dBeat ?? 0))) < 1e-9);
				return n ? noteKey(n) : k;
			}));
			tick++;
		}
	});

	// ---- pointer -----------------------------------------------------------------------------

	/** @type {HTMLElement|null} */
	let grid = $state(null);
	/** the vertical scroller (keys and grid scroll together; a phone sheet shows ~a dozen rows)
	 * @type {HTMLElement|null} */
	let body = $state(null);
	// open with middle C in the middle of what is visible, and again after an octave shift
	$effect(() => {
		void low;
		if (!body) return;
		body.scrollTop = Math.max(0, (low + ROWS - 1 - 60) * ROW + ROW / 2 - body.clientHeight / 2);
	});

	/** @param {MouseEvent} e */
	function cellAt(e) {
		const rect = /** @type {HTMLElement} */ (grid).getBoundingClientRect();
		const x = e.clientX - rect.left + /** @type {HTMLElement} */ (grid).scrollLeft;
		const y = e.clientY - rect.top;
		const s = Math.max(0, Math.min(span - ROLL_STEP, Math.floor(x / CELL) * ROLL_STEP));
		const p = pitches[Math.max(0, Math.min(ROWS - 1, Math.floor(y / ROW)))];
		return { p, s };
	}

	/** an empty cell: a new note there, selected. On CLICK, not pointerdown: a finger that
	 * starts a scroll on a phone never makes a click, so scrolling the grid adds nothing.
	 * @param {MouseEvent} e */
	function onGridClick(e) {
		if (e.button !== 0 || !current) return;
		if (/** @type {HTMLElement} */ (e.target).closest('.pr-note')) return;
		const { p, s } = cellAt(e);
		const note = { p, s, l: Math.min(length, span - s), v: 0.8 };
		commit(withNote(roll, note));
		selected = new Set([noteKey(note)]);
		audition(p);
		announce = noteName(p) + ' added';
		grid?.focus();
	}

	/** @param {PointerEvent} e @param {any} n */
	function onNoteDown(e, n) {
		if (e.button !== 0) return;
		e.stopPropagation();
		e.preventDefault();
		grid?.focus();
		const key = noteKey(n);
		if (e.shiftKey) {
			const next = new Set(selected);
			next.has(key) ? next.delete(key) : next.add(key);
			selected = next;
			return;
		}
		if (!selected.has(key)) selected = new Set([key]);
		const target = /** @type {HTMLElement} */ (e.currentTarget);
		const edge = e.clientX > target.getBoundingClientRect().right - 6;
		gesture.begin(e, { data: { mode: edge ? 'stretch' : 'move' } });
	}

	/** @param {MouseEvent} e @param {any} n */
	function onNoteRemove(e, n) {
		e.preventDefault();
		e.stopPropagation();
		removeKeys(new Set([noteKey(n)]));
	}

	/** @param {Set<string>} keys */
	function removeKeys(keys) {
		if (!keys.size) return;
		commit(withoutNotes(roll, (n) => keys.has(noteKey(n))));
		announce = keys.size + (keys.size === 1 ? ' note' : ' notes') + ' removed';
		selected = new Set([...selected].filter((k) => !keys.has(k)));
	}

	// ---- keyboard ----------------------------------------------------------------------------

	/** @param {{dBeat?: number, dPitch?: number, dLength?: number}} delta */
	function nudge(delta) {
		if (!current || !selected.size) return;
		const next = shiftNotes(roll, selected, delta);
		const keys = new Set(selected);
		commit(next);
		selected = new Set(
			[...keys].map((k) => {
				const [p, s] = k.split('@').map(Number);
				const n = next.notes.find((x) => x.p === p + (delta.dPitch ?? 0) && Math.abs(x.s - (s + (delta.dBeat ?? 0))) < 1e-9);
				return n ? noteKey(n) : k;
			})
		);
	}

	/** captured on the grid and stopped there: Delete would otherwise delete the OBJECT and
	 * the arrows would move it @param {KeyboardEvent} e */
	function onKey(e) {
		const t = e.target;
		if (t instanceof HTMLElement && (t.tagName === 'SELECT' || t.tagName === 'INPUT')) return;
		let handled = true;
		const big = e.shiftKey;
		if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
			const dir = e.key === 'ArrowLeft' ? -1 : 1;
			if (e.altKey) nudge({ dLength: dir * ROLL_STEP });
			else nudge({ dBeat: dir * (big ? 1 : ROLL_STEP) });
		} else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') nudge({ dPitch: (e.key === 'ArrowUp' ? 1 : -1) * (big ? 12 : 1) });
		else if (e.key === 'Delete' || e.key === 'Backspace') removeKeys(new Set(selected));
		else if (e.key === 'Enter' || e.key === 'Insert') addFromKeyboard();
		else if (e.key === 'Escape') selected = new Set();
		else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') selected = new Set(roll.notes.map(noteKey));
		else handled = false;
		if (handled) {
			e.preventDefault();
			e.stopPropagation();
		}
	}

	/** the keyboard's way to ADD: a note right after the selection (same pitch), or middle C
	 * on beat 1 — then the arrows place it */
	function addFromKeyboard() {
		if (!current) return;
		const picked = roll.notes.filter((n) => selected.has(noteKey(n)));
		const last = picked.sort((a, b) => a.s + a.l - (b.s + b.l)).at(-1);
		const s = last ? Math.min(span - ROLL_STEP, last.s + last.l) : 0;
		const note = { p: last ? last.p : 60, s, l: Math.min(length, span - s), v: 0.8 };
		commit(withNote(roll, note));
		selected = new Set([noteKey(note)]);
		audition(note.p);
		announce = noteName(note.p) + ' added';
	}

	// ---- toolbar -----------------------------------------------------------------------------

	/** @param {Event} e */
	function setBars(e) {
		const bars = Number(/** @type {HTMLSelectElement} */ (e.currentTarget).value);
		commit({ ...roll, bars });
	}
	function toggleClip() {
		commit({ ...roll, on: !roll.on });
	}
	function clearClip() {
		commit({ ...roll, notes: [] });
		selected = new Set();
		announce = 'Clip cleared';
	}
	/** @param {number} by */
	function shiftOctave(by) {
		low = Math.max(0, Math.min(127 - ROWS + 1, low + by));
	}

	// ---- the playhead --------------------------------------------------------------------------

	let head = $state(-1);
	onMount(() => {
		let raf = 0;
		// an undo, a redo or a peer's edit writes the document with no store to say so; the
		// stored clip is one string, so comparing it per frame is the cheap way to redraw
		let lastRaw = '';
		const loop = () => {
			const now = transportNow();
			head = now.playing ? now.beat % span : -1;
			const raw = current ? String(findDeviceObject(current.uuid)?.userData?.device?.params?.roll ?? '') : '';
			if (raw !== lastRaw) {
				lastRaw = raw;
				tick++;
			}
			raf = requestAnimationFrame(loop);
		};
		raf = requestAnimationFrame(loop);
		return () => {
			cancelAnimationFrame(raf);
			gesture.cancel();
		};
	});

	/** @param {any} n */
	function describe(n) {
		const bar = Math.floor(n.s / 4) + 1;
		const beat = (n.s % 4) + 1;
		return noteName(n.p) + ', bar ' + bar + ' beat ' + beat + ', ' + n.l + (n.l === 1 ? ' beat' : ' beats');
	}
</script>

<div class="pr" id="piano-roll">
	{#if !devices.length}
		<div class="tbx-row pr-empty">No device in the scene plays notes. Add a piano or a synth from Add ▸ Devices.</div>
	{:else if current}
		<div class="tbx-row pr-bar">
			<select id="pr-device" class="pr-select" aria-label="Device" value={current.uuid} onchange={(e) => { pickedUuid = /** @type {HTMLSelectElement} */ (e.currentTarget).value; selected = new Set(); }}>
				{#each devices as d (d.uuid)}
					<option value={d.uuid}>{d.name}</option>
				{/each}
			</select>
			<button id="pr-transport" class="tbx-btn" aria-pressed={$transport.playing} title={$transport.playing ? 'Stop the transport' : 'Play the transport'} aria-label={$transport.playing ? 'Stop the transport' : 'Play the transport'} onclick={() => toggleTransport()}>{$transport.playing ? '■' : '▶'}</button>
			<label class="pr-check">
				<input id="pr-on" class="tbx-check" type="checkbox" checked={roll.on} onchange={toggleClip} />
				<span>Play clip</span>
			</label>
		</div>
		<div class="tbx-row pr-bar">
			<label class="pr-field"><span>Bars</span>
				<select id="pr-bars" class="pr-select" value={String(roll.bars)} onchange={setBars}>
					{#each ROLL_BAR_CHOICES as b}<option value={String(b)}>{b}</option>{/each}
				</select>
			</label>
			<label class="pr-field"><span>Note</span>
				<select id="pr-length" class="pr-select" value={String(length)} onchange={(e) => (length = Number(/** @type {HTMLSelectElement} */ (e.currentTarget).value))}>
					{#each LENGTHS as l}<option value={String(l.value)}>{l.label}</option>{/each}
				</select>
			</label>
			<button id="pr-oct-down" class="tbx-btn" aria-label="Octave down" title="Octave down" onclick={() => shiftOctave(-12)}>−</button>
			<button id="pr-oct-up" class="tbx-btn" aria-label="Octave up" title="Octave up" onclick={() => shiftOctave(12)}>+</button>
			<button id="pr-delete" class="tbx-btn tbx-danger" aria-label="Delete selected notes" title="Delete selected notes" disabled={!selected.size} onclick={() => removeKeys(new Set(selected))}>✕</button>
			<button id="pr-clear" class="tbx-btn" title="Clear the clip" disabled={!roll.notes.length} onclick={clearClip}>Clear</button>
		</div>
		<div class="pr-body" bind:this={body}>
			<div class="pr-keys" aria-hidden="true">
				{#each pitches as p (p)}
					<div class="pr-key" class:pr-black={[1, 3, 6, 8, 10].includes(p % 12)} style:height="{ROW}px">{p % 12 === 0 ? noteName(p) : ''}</div>
				{/each}
			</div>
			<!-- the grid is an application widget with its own keys (onkeydowncapture: Enter adds,
				 arrows move, Delete removes), so the click has its keyboard twin -->
			<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
			<div
				class="pr-grid"
				bind:this={grid}
				role="application"
				aria-label={'Piano roll for ' + current.name + '. Click a cell or press Enter to add a note; arrows move the selection, Shift for bigger steps, Alt to change its length, Delete removes it.'}
				tabindex="0"
				onclick={onGridClick}
				onkeydowncapture={onKey}
				oncontextmenu={(e) => e.preventDefault()}
			>
				<div class="pr-canvas" style:width="{span * 4 * CELL}px" style:height="{ROWS * ROW}px" style:--pr-cell="{CELL}px" style:--pr-row="{ROW}px">
					{#each pitches as p, i (p)}
						<div class="pr-lane" class:pr-black={[1, 3, 6, 8, 10].includes(p % 12)} style:top="{i * ROW}px"></div>
					{/each}
					{#each shown as n (noteKey(n))}
						{#if n.p >= low && n.p < low + ROWS}
							<button
								class="pr-note"
								class:pr-sel={selected.has(noteKey(n))}
								data-key={noteKey(n)}
								tabindex="-1"
								aria-label={describe(n)}
								aria-pressed={selected.has(noteKey(n))}
								style:left="{(n.s / ROLL_STEP) * CELL}px"
								style:top="{(low + ROWS - 1 - n.p) * ROW}px"
								style:width="{(n.l / ROLL_STEP) * CELL - 1}px"
								style:opacity={0.45 + n.v * 0.55}
								onpointerdown={(e) => onNoteDown(e, n)}
								ondblclick={(e) => onNoteRemove(e, n)}
								oncontextmenu={(e) => onNoteRemove(e, n)}
							></button>
						{/if}
					{/each}
					{#if head >= 0}
						<div class="pr-head" style:left="{(head / ROLL_STEP) * CELL}px"></div>
					{/if}
				</div>
			</div>
		</div>
		<p class="pr-hint" id="pr-status" aria-live="polite">
			{announce || (roll.notes.length ? roll.notes.length + (roll.notes.length === 1 ? ' note' : ' notes') + (roll.on ? '' : ' · clip off') : 'Click the grid to add a note.')}
		</p>
	{/if}
</div>

<style>
	.pr {
		grid-column: 1 / -1;
		display: flex;
		flex-direction: column;
		gap: 4px;
		width: 100%;
		min-width: 0;
	}
	.pr-empty,
	.pr-hint {
		margin: 0;
		color: var(--tbx-muted);
		font-size: 0.75rem;
	}
	.pr-bar {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		align-items: center;
	}
	.pr-select {
		min-width: 0;
		background: var(--surface-2);
		color: var(--tbx-text);
		border: 1px solid var(--tbx-border);
		border-radius: 4px;
		font-size: 0.75rem;
		padding: 2px 4px;
	}
	#pr-device {
		flex: 1 1 8rem;
	}
	.pr-field {
		display: flex;
		align-items: center;
		gap: 4px;
		font-size: 0.75rem;
		color: var(--tbx-muted);
	}
	.pr-check {
		display: flex;
		align-items: center;
		gap: 4px;
		font-size: 0.75rem;
		white-space: nowrap;
		color: var(--tbx-text);
	}
	.pr-bar .tbx-btn {
		width: auto;
		min-width: 28px;
		height: 28px;
		padding: 0 6px;
		font-size: 0.75rem;
	}
	.pr-body {
		display: flex;
		min-width: 0;
		border: 1px solid var(--tbx-border);
		border-radius: 4px;
		overflow-x: hidden;
		overflow-y: auto;
		max-height: 336px;
	}
	/* the phone bottom sheet: the grid must end on screen, so it scrolls instead */
	:global(.tbx-sheet) .pr-body {
		max-height: 22vh;
	}
	.pr-keys {
		flex: 0 0 34px;
		background: var(--surface-2);
		border-right: 1px solid var(--tbx-border);
	}
	.pr-key {
		font-size: 0.6rem;
		line-height: 14px;
		padding-left: 3px;
		color: var(--tbx-muted);
		box-sizing: border-box;
		border-bottom: 1px solid var(--tbx-border);
	}
	.pr-key.pr-black {
		background: var(--surface-inset);
	}
	.pr-grid {
		flex: 1;
		min-width: 0;
		overflow-x: auto;
		overflow-y: hidden;
		outline: none;
	}
	.pr-grid:focus-visible {
		box-shadow: inset 0 0 0 2px var(--accent);
	}
	.pr-canvas {
		position: relative;
		/* a finger scrolls the grid; a note (touch-action: none) drags */
		touch-action: pan-x pan-y;
		/* a sixteenth line every cell, a stronger one every beat (four cells) */
		background-image:
			linear-gradient(to right, var(--border-strong) 1px, transparent 1px),
			linear-gradient(to right, var(--tbx-border) 1px, transparent 1px);
		background-size:
			calc(var(--pr-cell) * 4) 100%,
			var(--pr-cell) 100%;
	}
	.pr-lane {
		position: absolute;
		left: 0;
		right: 0;
		height: var(--pr-row);
		box-sizing: border-box;
		border-bottom: 1px solid var(--tbx-border);
		pointer-events: none;
	}
	.pr-lane.pr-black {
		background: var(--surface-inset);
		opacity: 0.6;
	}
	.pr-note {
		position: absolute;
		height: calc(var(--pr-row) - 2px);
		margin-top: 1px;
		padding: 0;
		border: 1px solid var(--accent);
		border-radius: 2px;
		background: var(--accent);
		cursor: grab;
		touch-action: none;
	}
	.pr-note::after {
		content: '';
		position: absolute;
		right: 0;
		top: 0;
		bottom: 0;
		width: 5px;
		cursor: ew-resize;
	}
	.pr-note.pr-sel {
		border-color: var(--text);
		box-shadow: 0 0 0 1px var(--text);
	}
	.pr-head {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 2px;
		background: var(--ink-warn);
		pointer-events: none;
	}
</style>

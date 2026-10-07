<script lang="ts">
	import { get } from 'svelte/store';
	import { untrack } from 'svelte';
	import Icon from '../ui/Icon.svelte';
	import { minimalScroll } from '$lib/ui/minimalScroll.js';
	import {
		annotations,
		activeAnnotation,
		setAnnotation,
		deleteAnnotation,
		annotationWorldPosition,
		followingNote,
		startNoteFollow,
		stopNoteFollow,
		displayName,
		displayAuthor,
		isMyNote,
		myAuthorName,
		myAuthorKey,
		noteNumber,
		NOTE_COLORS,
		NOTE_SHAPES,
		DEFAULT_NOTE_COLOR
	} from '$lib/annotationsHandler';
	import { globalCamera, globalRenderer, orbitControls } from '../../stores/sceneStore';
	import { notesDrawerOpen, inspectorClose } from '../../stores/appStore.js';

	// H5 (notes v2): ONE note card with a VIEW face and an EDIT face, anchored
	// NEAR its pin by a continuous screen projection — the card rides the camera
	// through openAnnotation's 400ms fly and while orbiting afterwards (flyTo has
	// no completion hook, so a one-shot placement would race the tween). Drafts
	// project the CLICKED point, so "Add note" opens at the cursor.
	// In VR the pin is in-headset and this DOM card is invisible; openAnnotation
	// degrades to no visible change there (flyTo bails too).

	const existing = $derived(
		$activeAnnotation?.id
			? ($annotations.find((a) => a.id === $activeAnnotation.id) ?? null)
			: null
	);
	const draft = $derived($activeAnnotation?.draft ?? null);
	const note = $derived(existing ?? draft);
	const open = $derived(!!note);
	// a draft always opens in edit mode; a stored note follows the requested mode
	const editing = $derived(!!draft || $activeAnnotation?.mode === 'edit');
	// label suggestions: every label already used in the scene
	const labels = $derived(
		[...new Set($annotations.map((a) => (a.label || '').trim()).filter(Boolean))].sort()
	);
	const following = $derived(!!note && $followingNote?.id === note.id);

	// --- form state, reseeded whenever the open note (or face) changes ---------
	let name = $state('');
	let text = $state('');
	let color = $state(DEFAULT_NOTE_COLOR);
	let label = $state('');
	let shape = $state('round');
	let pose = $state<any>(null); // H11 saved framing {position, target} | null
	let followOnOpen = $state(false);
	let seeded = '';
	$effect(() => {
		const key = (note?.id ?? '') + ':' + (editing ? 'edit' : 'view');
		if (key === seeded) return;
		seeded = key;
		const source: any = note;
		untrack(() => {
			name = source?.name ?? '';
			text = source?.text ?? '';
			color = source?.color || DEFAULT_NOTE_COLOR;
			label = source?.label ?? '';
			shape = source?.shape || 'round';
			pose = source?.camera ?? null;
			followOnOpen = source?.follow === true;
		});
	});

	// H11: capture the CURRENT view as this note's framing. Opening the note flies
	// here, and a follow session then keeps this offset live as the object moves.
	function saveView() {
		const camera: any = $globalCamera;
		const controls: any = $orbitControls;
		if (!camera || !controls) return;
		pose = {
			position: camera.position.toArray(),
			target: controls.target.toArray()
		};
	}
	const SHAPE_ICONS: Record<string, any> = { round: 'circle', star: 'star', square: 'square' };

	let nameInput: HTMLInputElement | null = $state(null);
	$effect(() => {
		// focus without an autofocus attribute (a11y baseline)
		if (editing && nameInput) nameInput.focus();
	});

	// --- placement -------------------------------------------------------------
	let card: HTMLElement | null = $state(null);
	let pos = $state({ x: 0, y: 0, anchored: false });
	let narrow = $state(false);

	$effect(() => {
		if (typeof window === 'undefined') return;
		// EXACTLY 640 — the repo's bottom-sheet breakpoint (Inspector/NotesDrawer)
		const mq = window.matchMedia('(max-width: 640px)');
		const sync = () => (narrow = mq.matches);
		sync();
		mq.addEventListener('change', sync);
		return () => mq.removeEventListener('change', sync);
	});

	// one bottom sheet at a time on narrow: the note card takes the bottom, so the
	// properties sheet and the notes-drawer sheet step aside (NotesDrawer precedent)
	$effect(() => {
		if (!open || !narrow) return;
		untrack(() => {
			inspectorClose.set(true);
			notesDrawerOpen.set(false);
		});
	});

	$effect(() => {
		if (!open || narrow) return;
		let raf = requestAnimationFrame(step);
		function step() {
			raf = requestAnimationFrame(step);
			const active: any = get(activeAnnotation);
			// a draft has no store entry yet — project its own object+offset
			const anchor = active?.draft ?? active?.id;
			if (!anchor) return;
			const world: any = annotationWorldPosition(anchor);
			const camera: any = get(globalCamera);
			const renderer: any = get(globalRenderer);
			if (!world || !camera || !renderer?.domElement) return;
			const v = world.clone().project(camera);
			const rect = renderer.domElement.getBoundingClientRect();
			const w = card?.offsetWidth || 300;
			const h = card?.offsetHeight || 220;
			const m = 8;
			let anchored = true;
			let x: number;
			let y: number;
			if (v.z >= 1) {
				// the pin is behind the camera: keep the card usable, centred
				anchored = false;
				x = Math.max(m, (window.innerWidth - w) / 2);
				y = Math.max(m, (window.innerHeight - h) / 2);
			} else {
				const sx = rect.left + ((v.x + 1) / 2) * rect.width;
				const sy = rect.top + ((1 - v.y) / 2) * rect.height;
				x = sx + 18;
				if (x + w > window.innerWidth - m) x = sx - 18 - w; // flip to the pin's left
				x = Math.min(Math.max(m, x), Math.max(m, window.innerWidth - w - m));
				y = Math.min(Math.max(m, sy - 24), Math.max(m, window.innerHeight - h - m));
			}
			if (Math.abs(x - pos.x) > 0.5 || Math.abs(y - pos.y) > 0.5 || anchored !== pos.anchored)
				pos = { x, y, anchored };
		}
		return () => cancelAnimationFrame(raf);
	});

	// --- actions ---------------------------------------------------------------
	function close() {
		activeAnnotation.set(null);
	}

	function save() {
		const base: any = existing ?? draft;
		if (!base) return;
		const description = text.trim();
		const title = name.trim();
		if (!description && !title) return; // nothing to save yet
		// H10: our OWN note re-stamps the display name (so renaming yourself, or
		// setting a nickname after creating notes, fixes what everyone else sees) and
		// gains the stable key if it predates it. Someone else's note keeps its author.
		const mine = isMyNote(base);
		// spread the base so fields a newer peer added survive OUR save
		setAnnotation({
			...base,
			name: title,
			text: description,
			color,
			shape,
			camera: pose,
			follow: followOnOpen,
			label: label.trim(),
			author: mine ? myAuthorName() : base.author,
			authorKey: mine ? myAuthorKey() : base.authorKey,
			ts: Date.now()
		});
		activeAnnotation.set({ id: base.id, mode: 'view' });
	}

	function remove() {
		if (existing) deleteAnnotation(existing.id);
		else close();
	}

	function cancel() {
		if (existing) activeAnnotation.set({ id: existing.id, mode: 'view' });
		else close();
	}

	/** @param {number} ts */
	function when(ts: number) {
		try {
			return new Date(ts).toLocaleString();
		} catch {
			return '';
		}
	}
</script>

{#if open && note}
	<div
		bind:this={card}
		class="note-card ui-panel"
		class:note-sheet={narrow}
		style={narrow ? '' : `left:${pos.x}px; top:${pos.y}px;`}
		role="dialog"
		tabindex="-1"
		aria-label={editing ? 'Edit note' : 'Note'}
	>
		<div class="note-head">
			<span class="note-num" style="background:{note.color || DEFAULT_NOTE_COLOR}"
				>{noteNumber(note.id) || '+'}</span
			>
			<span class="note-title">{editing ? (existing ? 'Edit note' : 'New note') : displayName(note)}</span>
			{#if !editing}
				<button
					class="note-icon"
					title="Edit note"
					aria-label="Edit note"
					onclick={() => activeAnnotation.set({ id: note.id, mode: 'edit' })}
				>
					<Icon name="pencil" size={16} aria-hidden="true" />
				</button>
			{/if}
			<button class="note-icon" title="Close" aria-label="Close note" onclick={close}>
				<Icon name="x" size={16} aria-hidden="true" />
			</button>
		</div>

		{#if editing}
			<div class="note-body" use:minimalScroll>
				<input
					bind:this={nameInput}
					class="ui-input w-full"
					placeholder="Name (optional)"
					bind:value={name}
					onkeydown={(e) => {
						if (e.key === 'Enter') {
							e.preventDefault();
							save();
						}
					}}
				/>
				<textarea
					class="ui-input h-20 w-full resize-none"
					placeholder="Description… (Enter saves, Shift+Enter for a new line)"
					bind:value={text}
					onkeydown={(e) => {
						if (e.key === 'Enter' && !e.shiftKey) {
							e.preventDefault();
							save();
						}
					}}
				></textarea>
				<span class="note-caption">Pin color</span>
				<!-- fixed swatch row on purpose: a full color picker is heavy in a
				     small popup (and v4 needs the onInput prop, not on:input) -->
				<div class="note-swatches" role="group" aria-label="Pin color">
					{#each NOTE_COLORS as c (c)}
						<button
							class="note-swatch"
							class:is-on={color === c}
							style="background:{c}"
							title={c}
							aria-label={'Pin color ' + c}
							aria-pressed={color === c}
							onclick={() => (color = c)}
						></button>
					{/each}
				</div>
				<!-- shape is a VR-only distinction now: every 2D marker is the same pill
				     so the overlay reads consistently (user call) -->
				<span class="note-caption">Pin shape — VR only</span>
				<div class="note-shapes" role="group" aria-label="Pin shape">
					{#each NOTE_SHAPES as s (s)}
						{@const shapeIcon = SHAPE_ICONS[s]}
						<button
							class="note-shape"
							class:is-on={shape === s}
							title={'Pin shape: ' + s}
							aria-label={'Pin shape ' + s}
							aria-pressed={shape === s}
							onclick={() => (shape = s)}
						>
							<Icon name={shapeIcon} size={16} aria-hidden="true" />
							<span>{s}</span>
						</button>
					{/each}
				</div>
				<span class="note-caption">Label — groups notes in the drawer</span>
				<input
					class="ui-input w-full"
					list="note-labels"
					placeholder="e.g. mechanics"
					bind:value={label}
					onkeydown={(e) => {
						if (e.key === 'Enter') {
							e.preventDefault();
							save();
						}
					}}
				/>
				<datalist id="note-labels">
					{#each labels as l (l)}<option value={l}></option>{/each}
				</datalist>
				<span class="note-caption">Camera</span>
				<div class="note-camera">
					<button class="note-flat" title="Store the current view with this note" onclick={saveView}>
						<Icon name="locate-fixed" size={16} aria-hidden="true" />
						{pose ? 'Update saved view' : 'Save camera view'}
					</button>
					{#if pose}
						<button
							class="note-icon"
							title="Forget the saved view"
							aria-label="Clear the saved camera view"
							onclick={() => (pose = null)}
						>
							<Icon name="x" size={16} aria-hidden="true" />
						</button>
					{/if}
				</div>
				<label class="note-check">
					<!-- a switch, not a checkbox: it arms a MODE (the camera rides this pin),
					     which is the same reason Settings uses Toggle for behaviour flags -->
					<input type="checkbox" class="note-switch" bind:checked={followOnOpen} />
					<span>Follow the pin when opened</span>
				</label>
			</div>
			<div class="note-actions">
				{#if existing}
					<button class="note-danger" title="Delete note" aria-label="Delete note" onclick={remove}>
						<Icon name="trash-2" size={16} aria-hidden="true" /> Delete
					</button>
				{/if}
				<span class="flex-1"></span>
				<button class="ui-button-quiet" onclick={cancel}>Cancel</button>
				<button class="note-primary" onclick={save}>
					<Icon name="check" size={16} aria-hidden="true" /> Save
				</button>
			</div>
		{:else}
			<div class="note-body" use:minimalScroll>
				{#if note.name?.trim() && note.text?.trim()}
					<p class="note-desc">{note.text}</p>
				{:else if !note.text?.trim()}
					<p class="note-desc note-muted">No description</p>
				{/if}
				<div class="note-meta">
					{#if note.label}<span class="note-chip">{note.label}</span>{/if}
					<span class="note-dot" style="background:{note.color || DEFAULT_NOTE_COLOR}"></span>
					<span class="truncate">{displayAuthor(note)} · {when(note.ts)}</span>
				</div>
			</div>
			<div class="note-actions">
				<button class="note-danger" title="Delete note" aria-label="Delete note" onclick={remove}>
					<Icon name="trash-2" size={16} aria-hidden="true" /> Delete
				</button>
				<span class="flex-1"></span>
				<!-- H11: the follow session outlives this card — closing it keeps riding -->
				<button
					class="note-flat"
					class:is-on={following}
					title={following
						? 'Stop riding this pin with the camera'
						: 'Ride this pin with the camera (keeps going after you close this card)'}
					onclick={() => (following ? stopNoteFollow() : startNoteFollow(note.id))}
				>
					{#if following}
						<Icon name="video-off" size={16} aria-hidden="true" /> Following
					{:else}
						<Icon name="video" size={16} aria-hidden="true" /> Follow
					{/if}
				</button>
				<button
					class="note-primary"
					onclick={() => activeAnnotation.set({ id: note.id, mode: 'edit' })}
				>
					<Icon name="pencil" size={16} aria-hidden="true" /> Edit
				</button>
			</div>
		{/if}
	</div>
{/if}

<style>
	.note-card {
		position: fixed;
		/* above the drawers (the docked notes drawer sits at 1000) but below
		   --z-modal / --z-toast / --z-menu */
		z-index: 1090;
		width: min(300px, 92vw);
		padding: 0;
		display: flex;
		flex-direction: column;
	}
	.note-head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		border-bottom: 1px solid var(--border);
		padding: 0.4rem 0.5rem;
	}
	.note-num {
		display: inline-flex;
		height: 1.15rem;
		min-width: 1.15rem;
		align-items: center;
		justify-content: center;
		border-radius: 9999px;
		padding: 0 0.25rem;
		font-size: 10px;
		font-weight: 700;
		color: #1c1917; /* tokens-ok: dark ink on the user-picked note colour (data), same in every theme */
	}
	.note-title {
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--text);
	}
	.note-icon {
		display: inline-flex;
		flex: 0 0 auto;
		align-items: center;
		justify-content: center;
		border-radius: 0.25rem;
		padding: 0.15rem;
		color: var(--text-muted);
	}
	.note-icon:hover {
		background: var(--surface-hover);
		color: var(--text);
	}
	.note-body {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		padding: 0.5rem;
		min-height: 0;
		overflow-y: auto;
	}
	.note-desc {
		font-size: 0.8125rem;
		line-height: 1.35;
		color: var(--text-2);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.note-muted {
		color: var(--text-faint);
		font-style: italic;
	}
	.note-meta {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		font-size: 10px;
		color: var(--text-faint);
	}
	.note-chip {
		border-radius: 9999px;
		background: var(--surface-active);
		padding: 0 0.375rem;
		color: var(--text-2);
	}
	.note-dot {
		height: 0.5rem;
		width: 0.5rem;
		flex: 0 0 auto;
		border-radius: 9999px;
	}
	.note-caption {
		margin-top: 0.125rem;
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--text-faint);
	}
	.note-swatches {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem;
	}
	.note-swatch {
		height: 1.15rem;
		width: 1.15rem;
		border-radius: 9999px;
		border: 2px solid transparent;
		outline: 1px solid color-mix(in srgb, var(--bg-app) 35%, transparent);
	}
	.note-swatch.is-on {
		border-color: var(--text);
	}
	.note-shapes {
		display: flex;
		gap: 0.25rem;
	}
	.note-shape {
		display: inline-flex;
		flex: 1 1 0;
		align-items: center;
		justify-content: center;
		gap: 0.25rem;
		border: 1px solid var(--border-strong);
		border-radius: 0.25rem;
		padding: 0.15rem 0.25rem;
		font-size: 10px;
		text-transform: capitalize;
		color: var(--text-muted);
	}
	.note-shape:hover {
		color: var(--text);
	}
	.note-shape.is-on {
		border-color: var(--accent);
		background: var(--accent-soft);
		color: var(--accent-soft-text);
	}
	.note-camera {
		display: flex;
		align-items: center;
		gap: 0.25rem;
	}
	.note-check {
		display: flex;
		cursor: pointer;
		align-items: center;
		gap: 0.45rem;
		font-size: 11px;
		color: var(--text-2);
	}
	/* A compact switch built from the checkbox itself — same visual language as the
	   flowbite Toggle in Settings, without pulling the component into this card.
	   GOTCHA: flowbite's plugin emits
	     [type='checkbox']:checked { background-color: currentColor !important }
	   so no background-color of ours can ever win the ON state (it rendered
	   blue-600, flowbite's inherited color). The cure is to work WITH that rule and
	   drive the fill through `color` instead of fighting it with !important. */
	input[type='checkbox'].note-switch {
		position: relative;
		height: 14px;
		width: 26px;
		flex: 0 0 auto;
		appearance: none;
		border-radius: 9999px;
		color: var(--control-off);
		background-color: var(--control-off);
		transition:
			color 120ms ease,
			background-color 120ms ease;
		cursor: pointer;
	}
	input[type='checkbox'].note-switch::after {
		content: '';
		position: absolute;
		top: 2px;
		left: 2px;
		height: 10px;
		width: 10px;
		border-radius: 9999px;
		background: var(--knob);
		box-shadow: var(--shadow-knob);
		transition: transform 120ms ease;
	}
	input[type='checkbox'].note-switch:checked {
		/* the !important rule above paints background-color: currentColor */
		color: var(--accent);
	}
	input[type='checkbox'].note-switch:checked::after {
		transform: translateX(12px);
	}
	input[type='checkbox'].note-switch:focus-visible {
		outline: 2px solid color-mix(in srgb, var(--accent) 60%, transparent);
		outline-offset: 2px;
	}
	.note-actions {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		border-top: 1px solid var(--border);
		padding: 0.4rem 0.5rem;
	}
	.note-flat {
		display: inline-flex;
		flex: 1 1 auto;
		align-items: center;
		justify-content: center;
		gap: 0.25rem;
		border: 1px solid var(--border-strong);
		border-radius: 0.25rem;
		padding: 0.15rem 0.4rem;
		font-size: 0.75rem;
		color: var(--text-2);
	}
	.note-flat:hover {
		border-color: var(--text-faint);
		color: var(--text);
	}
	.note-flat.is-on {
		border-color: var(--accent);
		background: var(--accent-soft);
		color: var(--accent-soft-text);
	}
	.note-primary,
	.note-danger {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		border-radius: 0.25rem;
		padding: 0.15rem 0.5rem;
		font-size: 0.75rem;
	}
	.note-primary {
		background: var(--accent-fill);
		color: var(--on-accent);
	}
	.note-primary:hover {
		filter: brightness(0.92);
	}
	.note-danger {
		color: var(--ink-bad);
	}
	.note-danger:hover {
		background: color-mix(in srgb, var(--ink-bad) 15%, transparent);
	}
	/* Narrow / folded: a bottom sheet like the Inspector and notes drawer. */
	.note-card.note-sheet {
		left: 0;
		right: 0;
		bottom: 0;
		top: auto;
		width: 100%;
		max-height: calc(100vh - var(--connect-bottom, 54px) - 56px);
		border-radius: 0.75rem 0.75rem 0 0;
	}
	.note-card.note-sheet .note-body {
		padding-bottom: var(--controls-inset, 0px);
	}
</style>

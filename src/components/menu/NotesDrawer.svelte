<script>
	// E2 (roadmap #13): scene-notes drawer — the missing "see every note" surface.
	// Right-docked list of all annotations; a row flies the camera to the pin and
	// opens its note (openAnnotation), and can be deleted inline. Toggled from the
	// notes button in the top-right chrome (Users.svelte).
	// H6 (notes v2): rows are "#n name — description", grouped by LABEL (collapsible,
	// 'General' first) with per-group ‹ › traversal in GLOBAL pin-number order, plus
	// a header toggle for the in-scene pins.
	import WindowChrome from '../ui/WindowChrome.svelte';
	import Icon from '../ui/Icon.svelte';
	import EmptyState from '../ui/EmptyState.svelte';
	import { notesDrawerOpen, inspectorClose, noteDoubleClickToOpen } from '../../stores/appStore.js';
	import {
		annotations,
		activeAnnotation,
		openAnnotation,
		focusAnnotation,
		visitedNote,
		deleteAnnotation,
		displayName,
		displayAuthor,
		showNotePins,
		DEFAULT_NOTE_COLOR
	} from '$lib/annotationsHandler';
	import { objectsGroup } from '../../stores/sceneStore.js';
	import { safeStorage } from '$lib/safeStorage';
	import { minimalScroll } from '$lib/ui/minimalScroll.js';

	// One bottom sheet at a time on narrow: opening scene notes closes the object/scene
	// settings sheet (they'd otherwise stack at the bottom).
	$effect(() => {
		if (
			$notesDrawerOpen &&
			typeof window !== 'undefined' &&
			window.matchMedia('(max-width: 640px)').matches
		)
			inspectorClose.set(true);
	});

	// On a narrow/folded screen the notes drawer is a bottom SHEET (like the Flow/Explorer
	// bottom dock) with a drag handle to adjust its height — the right-side drawer was
	// covered by the profile chrome there. On wide screens it stays the right drawer.
	let stored =
		typeof localStorage !== 'undefined' ? parseInt(safeStorage.getItem('notesSheetH') || '') : NaN;
	let sheetH = $state(
		!stored || Number.isNaN(stored)
			? Math.round((typeof window !== 'undefined' ? window.innerHeight : 800) * 0.45)
			: stored
	);
	let resizing = false;
	/** @param {PointerEvent} e */
	function startResize(e) {
		resizing = true;
		/** @type {HTMLElement} */ (e.currentTarget).setPointerCapture?.(e.pointerId);
		e.preventDefault();
	}
	/** @param {PointerEvent} e */
	function doResize(e) {
		if (!resizing) return;
		// sheet is bottom:0, so height = viewport height - finger y; cap the top below
		// the Connect bar + top-right chrome (same limit as the Flow/Explorer dock)
		const cb = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--connect-bottom')) || 54;
		const maxH = Math.max(200, window.innerHeight - cb - 56);
		sheetH = Math.min(Math.max(160, window.innerHeight - e.clientY), maxH);
	}
	/** @param {PointerEvent} e */
	function endResize(e) {
		if (!resizing) return;
		resizing = false;
		/** @type {HTMLElement} */ (e.currentTarget).releasePointerCapture?.(e.pointerId);
		try {
			safeStorage.setItem('notesSheetH', String(sheetH));
		} catch {}
	}

	/** @param {string} uuid */
	function labelFor(uuid) {
		const g = $objectsGroup;
		const o = g && g.getObjectByProperty ? g.getObjectByProperty('uuid', uuid) : null;
		return o?.name || o?.type || uuid.slice(0, 8);
	}

	/** @param {number} ts */
	function when(ts) {
		try {
			return new Date(ts).toLocaleString();
		} catch {
			return '';
		}
	}

	// Label groups. Rows carry the GLOBAL 1-based pin number so the drawer and the
	// in-scene pin labels always agree (never number per group).
	const groups = $derived.by(() => {
		/** @type {Map<string, {a: any, n: number}[]>} */
		const map = new Map();
		$annotations.forEach((a, i) => {
			const key = (a.label || '').trim() || 'General';
			if (!map.has(key)) map.set(key, []);
			/** @type {any[]} */ (map.get(key)).push({ a, n: i + 1 });
		});
		const rest = [...map.keys()].filter((k) => k !== 'General').sort((x, y) => x.localeCompare(y));
		const order = map.has('General') ? ['General', ...rest] : rest;
		return order.map((label) => ({ label, rows: /** @type {any[]} */ (map.get(label)) }));
	});

	/** @type {Record<string, boolean>} */
	let collapsed = $state({}); // expanded by default

	/**
	 * "Go to this note": opens its card, or in double-click mode (Settings ▸
	 * Interface) only flies there — reviewing a scene then stays pure navigation.
	 * Either way `visitedNote` records where we are, which is what highlights the
	 * row and what the arrows step from.
	 * @param {string} id
	 */
	function goTo(id) {
		if ($noteDoubleClickToOpen) focusAnnotation(id);
		else openAnnotation(id, 'view');
	}

	/** Step through a group's notes in pin order, wrapping @param {any} group @param {number} dir */
	function step(group, dir) {
		const rows = group.rows;
		if (!rows.length) return;
		// walk from the note we last went to, opened or not
		const current = $activeAnnotation?.id ?? $visitedNote;
		const at = rows.findIndex((/** @type {any} */ r) => r.a.id === current);
		// continue from the current note when it belongs to this group, else start at the end
		const next = at < 0 ? (dir > 0 ? rows[0] : rows[rows.length - 1]) : rows[(at + dir + rows.length) % rows.length];
		goTo(next.a.id);
	}
</script>

{#if $notesDrawerOpen}
	<aside id="notes-drawer" data-key-scope="panel" class="ui-panel tp-ui tp-window flex flex-col" style="--notes-h: {sheetH}px;">
		<!-- top drag handle: adjusts the sheet height (bottom-sheet mode on narrow only) -->
		<div
			class="notes-resize"
			title="Drag to resize"
			onpointerdown={startResize}
			onpointermove={doResize}
			onpointerup={endResize}
		>
			<span class="notes-grabber"></span>
		</div>
		<!-- 38 R6: the one window header (ui/WindowChrome) -->
		<WindowChrome
			size="tool"
			bare
			body={false}
			title="Scene notes"
			count={$annotations.length || undefined}
			headerClass="ui-panel-header"
			onclose={() => notesDrawerOpen.set(false)}
			closeLabel="Close notes"
		>
			{#snippet actions()}
				<button
					class="wc-act"
					title={$showNotePins ? 'Hide note pins in the viewport' : 'Show note pins in the viewport'}
					aria-label={$showNotePins ? 'Hide note pins' : 'Show note pins'}
					aria-pressed={$showNotePins}
					onclick={() => showNotePins.set(!$showNotePins)}
				>
					{#if $showNotePins}<Icon name="eye" size={16} aria-hidden="true" />{:else}<Icon name="eye-off" size={16} aria-hidden="true" />{/if}
				</button>
			{/snippet}
		</WindowChrome>
		<div class="notes-body min-h-0 flex-1 overflow-y-auto p-2" use:minimalScroll>
			{#if !$annotations.length}
				<EmptyState
					icon="sticky-note"
					title="No notes yet"
					description="Select an object and add a note from its context menu or the object list."
				/>
			{:else}
				{#each groups as group (group.label)}
					<div class="notes-group">
						<div class="notes-group-head">
							<button
								class="notes-group-toggle"
								aria-expanded={!collapsed[group.label]}
								onclick={() => (collapsed = { ...collapsed, [group.label]: !collapsed[group.label] })}
							>
								{#if collapsed[group.label]}
									<Icon name="chevron-right" size={16} aria-hidden="true" />
								{:else}
									<Icon name="chevron-down" size={16} aria-hidden="true" />
								{/if}
								<span class="truncate">{group.label}</span>
								<span class="notes-count">{group.rows.length}</span>
							</button>
							<button
								class="notes-icon"
								title="Previous note in this group"
								aria-label={'Previous note in ' + group.label}
								onclick={() => step(group, -1)}
							>
								<Icon name="chevron-left" size={16} aria-hidden="true" />
							</button>
							<button
								class="notes-icon"
								title="Next note in this group"
								aria-label={'Next note in ' + group.label}
								onclick={() => step(group, 1)}
							>
								<Icon name="chevron-right" size={16} aria-hidden="true" />
							</button>
						</div>
						{#if !collapsed[group.label]}
							<ul class="flex flex-col gap-1.5 pb-1">
								{#each group.rows as row (row.a.id)}
									<li
										class="notes-row group"
										class:notes-row-active={($activeAnnotation?.id ?? $visitedNote) === row.a.id}
									>
										<div class="flex items-start gap-2 p-2">
											<button
												class="min-w-0 flex-1 text-left"
												title={$noteDoubleClickToOpen
													? 'Fly to this note (double-click to open it)'
													: 'Fly to this note and open it'}
												onclick={() => goTo(row.a.id)}
												ondblclick={() => openAnnotation(row.a.id, 'view')}
											>
												<div class="flex min-w-0 items-baseline gap-1.5">
													<span
														class="notes-num"
														style="background:{row.a.color || DEFAULT_NOTE_COLOR}">{row.n}</span
													>
													<span class="notes-name shrink-0">{displayName(row.a)}</span>
													{#if (row.a.name || '').trim() && (row.a.text || '').trim()}
														<span class="notes-desc">{row.a.text}</span>
													{/if}
												</div>
												<div class="notes-meta mt-0.5 flex items-center gap-1.5 truncate">
													<span class="notes-obj">{labelFor(row.a.objectUuid)}</span>
													<span class="truncate">{displayAuthor(row.a)} · {when(row.a.ts)}</span>
												</div>
											</button>
											<button
												class="notes-icon shrink-0"
												title="Edit note"
												aria-label="Edit note"
												onclick={() => openAnnotation(row.a.id, 'edit')}
											>
												<Icon name="pencil" size={16} aria-hidden="true" />
											</button>
											<button
												class="notes-icon notes-del shrink-0"
												title="Delete note"
												aria-label="Delete note"
												onclick={() => deleteAnnotation(row.a.id)}
											><Icon name="x" size={16} /></button>
										</div>
									</li>
								{/each}
							</ul>
						{/if}
					</div>
				{/each}
			{/if}
		</div>
	</aside>
{/if}

<style>
	/* Wide (unfolded): right-side drawer that sits ABOVE the top-right chrome (profile/
	   peers/bell/notes) — top:8 + a z above ~999 so it covers those buttons while open. */
	#notes-drawer {
		position: fixed;
		right: 0;
		/* default (Connect centred / not docked): below the profile icon, under the chrome */
		top: 64px;
		/* SUM, not max(): the Controls pill rides ABOVE the dock now (the band
		   [bottom-inset .. +66px]), so clearing the taller of the two no longer clears
		   both. Identical to the old max() whenever either term is 0. */
		bottom: calc(var(--bottom-inset, 0px) + var(--controls-inset, 0px));
		width: min(320px, 92vw);
		z-index: calc(var(--z-bottom) - 1);
		border-radius: var(--radius-window) 0 0 var(--radius-window);
	}
	/* only when Connect is docked (chrome dropped under it), and only in side-drawer mode
	   (wide) — tuck below the bar and cover the chrome buttons; narrow stays a bottom sheet */
	@media (min-width: 641px) {
		:global(:root.connect-docked) #notes-drawer {
			top: calc(var(--connect-bottom, 0px) + 4px);
			z-index: 1000;
		}
	}
	/* the resize grabber only shows in bottom-sheet mode */
	.notes-resize {
		display: none;
		flex: 0 0 auto;
		height: 16px;
		cursor: ns-resize;
		touch-action: none;
		align-items: center;
		justify-content: center;
	}
	.notes-grabber {
		width: 40px;
		height: 4px;
		border-radius: 9999px;
		background: var(--border-strong);
	}
	/* --- H6 rows + groups --------------------------------------------------- */
	/* 38 R6: rows, groups and icons in the tokens */
	.notes-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		border-radius: var(--radius-input);
		color: var(--text-muted);
	}
	.notes-icon:hover {
		background: var(--surface-hover);
		color: var(--text);
	}
	.notes-del:hover {
		color: var(--warn-text);
	}
	.notes-row {
		border: 1px solid var(--border);
		border-radius: var(--radius-card);
		background: var(--surface-2);
	}
	.notes-row:hover {
		border-color: var(--border-strong);
	}
	.notes-name {
		font-size: var(--fs-desc);
		color: var(--text);
	}
	.notes-meta {
		font-size: var(--fs-badge);
		color: var(--text-faint);
	}
	.notes-obj {
		padding: 0 6px;
		border-radius: var(--radius-pill);
		background: var(--badge-bg);
		color: var(--badge-text);
	}
	.notes-count {
		font-family: var(--font-ui-mono);
		font-weight: 500;
		letter-spacing: 0;
	}
	.notes-group + .notes-group {
		margin-top: 0.5rem;
	}
	.notes-group-head {
		display: flex;
		align-items: center;
		gap: 0.125rem;
		padding: 0.125rem 0.125rem 0.25rem;
	}
	.notes-group-toggle {
		display: flex;
		min-width: 0;
		flex: 1 1 auto;
		align-items: center;
		gap: 0.25rem;
		font-size: var(--fs-badge);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: var(--tracking-section);
		color: var(--text-faint);
	}
	.notes-group-toggle:hover {
		color: var(--text-2);
	}
	.notes-num {
		display: inline-flex;
		height: 1rem;
		min-width: 1rem;
		flex: 0 0 auto;
		align-items: center;
		justify-content: center;
		border-radius: 9999px;
		padding: 0 0.2rem;
		font-size: 9px;
		font-weight: 700;
		color: #1c1917; /* tokens-ok: ink on the USER's note colour (data swatch, same in every theme; the pins' contrastOn dark ink) */
	}
	/* description rides the same line, grey and single-line truncated */
	.notes-desc {
		min-width: 0;
		flex: 1 1 auto;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--fs-section);
		color: var(--text-muted);
	}
	.notes-row-active {
		border-color: var(--accent);
		background: var(--accent-soft);
	}
	/* Narrow / folded: a bottom sheet (like the Flow/Explorer dock) with a drag handle. */
	@media (max-width: 640px) {
		#notes-drawer {
			left: 0;
			right: 0;
			top: auto;
			/* background extends behind the Controls HUD; content padded up (see .notes-body) */
			bottom: 0;
			width: 100%;
			height: var(--notes-h, 45vh);
			/* never rise above the Connect bar + top-right chrome (like the Flow/Explorer dock) */
			max-height: calc(100vh - var(--connect-bottom, 54px) - 56px);
			border-radius: var(--radius-window) var(--radius-window) 0 0;
			/* below the Controls HUD in the bottom-sheet layout (not the wide cover-z) */
			z-index: calc(var(--z-bottom) - 1);
		}
		.notes-resize {
			display: flex;
		}
		/* keep the list above the Controls HUD while the sheet bg extends behind it */
		.notes-body {
			padding-bottom: var(--controls-inset, 0px);
		}
	}
</style>

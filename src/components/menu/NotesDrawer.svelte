<script>
	// E2 (roadmap #13): scene-notes drawer — the missing "see every note" surface.
	// Right-docked list of all annotations; a row flies the camera to the pin and
	// opens its note (openAnnotation), and can be deleted inline. Toggled from the
	// notes button in the top-right chrome (Users.svelte).
	// H6 (notes v2): rows are "#n name — description", grouped by LABEL (collapsible,
	// 'General' first) with per-group ‹ › traversal in GLOBAL pin-number order, plus
	// a header toggle for the in-scene pins.
	import { ChevronDown, ChevronRight, ChevronLeft, Pencil, Eye, EyeOff } from '@lucide/svelte';
	import { notesDrawerOpen, inspectorClose } from '../../stores/appStore.js';
	import {
		annotations,
		activeAnnotation,
		openAnnotation,
		deleteAnnotation,
		displayName,
		showNotePins,
		DEFAULT_NOTE_COLOR
	} from '$lib/annotationsHandler';
	import { objectsGroup } from '../../stores/sceneStore.js';

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
		typeof localStorage !== 'undefined' ? parseInt(localStorage.getItem('notesSheetH') || '') : NaN;
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
			localStorage.setItem('notesSheetH', String(sheetH));
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

	/** Step through a group's notes in pin order, wrapping @param {any} group @param {number} dir */
	function step(group, dir) {
		const rows = group.rows;
		if (!rows.length) return;
		const current = $activeAnnotation?.id;
		const at = rows.findIndex((/** @type {any} */ r) => r.a.id === current);
		// continue from the open note when it belongs to this group, else start at the end
		const next = at < 0 ? (dir > 0 ? rows[0] : rows[rows.length - 1]) : rows[(at + dir + rows.length) % rows.length];
		openAnnotation(next.a.id, 'view');
	}
</script>

{#if $notesDrawerOpen}
	<aside id="notes-drawer" class="ui-panel flex flex-col" style="--notes-h: {sheetH}px;">
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
		<div class="ui-panel-header shrink-0 justify-between">
			<span>Scene notes {#if $annotations.length}<span class="text-xs text-gray-400">({$annotations.length})</span>{/if}</span>
			<div class="flex items-center gap-1">
				<button
					class="notes-icon"
					title={$showNotePins ? 'Hide note pins in the viewport' : 'Show note pins in the viewport'}
					aria-label={$showNotePins ? 'Hide note pins' : 'Show note pins'}
					aria-pressed={$showNotePins}
					onclick={() => showNotePins.set(!$showNotePins)}
				>
					{#if $showNotePins}<Eye size={15} aria-hidden="true" />{:else}<EyeOff size={15} aria-hidden="true" />{/if}
				</button>
				<button class="ui-button-quiet" title="Close" aria-label="Close notes" onclick={() => notesDrawerOpen.set(false)}>✕</button>
			</div>
		</div>
		<div class="notes-body min-h-0 flex-1 overflow-y-auto p-2">
			{#if !$annotations.length}
				<p class="px-1 py-6 text-center text-sm text-gray-400">
					No notes yet. Select an object and add a note from its context menu or the object list.
				</p>
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
									<ChevronRight size={14} aria-hidden="true" />
								{:else}
									<ChevronDown size={14} aria-hidden="true" />
								{/if}
								<span class="truncate">{group.label}</span>
								<span class="text-gray-500">({group.rows.length})</span>
							</button>
							<button
								class="notes-icon"
								title="Previous note in this group"
								aria-label={'Previous note in ' + group.label}
								onclick={() => step(group, -1)}
							>
								<ChevronLeft size={14} aria-hidden="true" />
							</button>
							<button
								class="notes-icon"
								title="Next note in this group"
								aria-label={'Next note in ' + group.label}
								onclick={() => step(group, 1)}
							>
								<ChevronRight size={14} aria-hidden="true" />
							</button>
						</div>
						{#if !collapsed[group.label]}
							<ul class="flex flex-col gap-1.5 pb-1">
								{#each group.rows as row (row.a.id)}
									<li
										class="group rounded-sm bg-gray-800/60 hover:bg-gray-700/60"
										class:notes-row-active={$activeAnnotation?.id === row.a.id}
									>
										<div class="flex items-start gap-2 p-2">
											<button
												class="min-w-0 flex-1 text-left"
												title="Fly to this note"
												onclick={() => openAnnotation(row.a.id, 'view')}
											>
												<div class="flex min-w-0 items-baseline gap-1.5">
													<span
														class="notes-num"
														style="background:{row.a.color || DEFAULT_NOTE_COLOR}">{row.n}</span
													>
													<span class="shrink-0 text-sm text-gray-100">{displayName(row.a)}</span>
													{#if (row.a.name || '').trim() && (row.a.text || '').trim()}
														<span class="notes-desc">{row.a.text}</span>
													{/if}
												</div>
												<div class="mt-0.5 flex items-center gap-1.5 truncate text-[10px] text-gray-500">
													<span class="rounded-sm bg-gray-700/70 px-1 text-gray-300">{labelFor(row.a.objectUuid)}</span>
													<span class="truncate">{row.a.author || 'peer'} · {when(row.a.ts)}</span>
												</div>
											</button>
											<button
												class="notes-icon shrink-0"
												title="Edit note"
												aria-label="Edit note"
												onclick={() => openAnnotation(row.a.id, 'edit')}
											>
												<Pencil size={14} aria-hidden="true" />
											</button>
											<button
												class="shrink-0 text-gray-500 hover:text-red-400"
												title="Delete note"
												aria-label="Delete note"
												onclick={() => deleteAnnotation(row.a.id)}
											>✕</button>
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
		bottom: max(var(--bottom-inset, 0px), var(--controls-inset, 0px));
		width: min(320px, 92vw);
		z-index: calc(var(--z-bottom) - 1);
		border-radius: 0.5rem 0 0 0.5rem;
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
		background: rgb(148 163 184 / 0.7);
	}
	/* --- H6 rows + groups --------------------------------------------------- */
	.notes-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border-radius: 0.25rem;
		padding: 0.15rem;
		color: rgb(156 163 175);
	}
	.notes-icon:hover {
		background: rgb(55 65 81 / 0.7);
		color: rgb(243 244 246);
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
		font-size: 10px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: rgb(156 163 175);
	}
	.notes-group-toggle:hover {
		color: rgb(229 231 235);
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
		color: #1c1917;
	}
	/* description rides the same line, grey and single-line truncated */
	.notes-desc {
		min-width: 0;
		flex: 1 1 auto;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 0.75rem;
		color: rgb(156 163 175);
	}
	.notes-row-active {
		outline: 1px solid rgb(249 115 22 / 0.7);
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
			border-radius: 0.75rem 0.75rem 0 0;
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

<script>
	// 105-slots: THE slot list — one row per material slot of an object: swatch, name, a "Shader" / "Off" badge, an
	// eye toggle and a ⋯ menu (Rename · Switch material… · Select its faces · Assign selected faces · Duplicate ·
	// Move up · Move down · Remove…). Used by Inspector ▸ Material (2+ slots) and the UV editor's Materials pane
	// (which adds its image / assign buttons through the `extra` snippet). Every action is materialSlots.js: one
	// `materials` commit, one undo step. Touch (Find N6): rows 44 px, the eye and ⋯ are 44 px targets, the menu is the
	// shared ContextMenu (a bottom sheet on a phone), a long press on a row opens it, Move up / down instead of drag.
	import Icon from '../ui/Icon.svelte';
	import { objectsGroup } from '../../stores/sceneStore';
	import { showToast } from '../../stores/appStore';
	import { fieldMenu } from '$lib/fieldMenu.js';
	import { get } from 'svelte/store';
	import { touchHold } from '$lib/ui/touchHold.js';
	import { mapPreviewUrl } from '$lib/loadGuard.js';
	import {
		slotsOf,
		activeMaterialSlot,
		removeSlot,
		moveSlot,
		renameSlot,
		duplicateSlot,
		setSlotOff,
		makeSlotUnique
	} from '$lib/materialSlots.js';
	import { materialsOf } from '$lib/materialsHandler';

	/**
	 * `extra(index)` renders a host's own row buttons (the UV editor's image / assign / remove); `rowAttrs(index)` adds
	 * attributes to a row (the UV editor's `data-uv-slot`), `rowClass(index)` classes; `ondragover` / `ondragleave` /
	 * `ondrop` make each row a drop target (an Explorer image or a file onto a slot).
	 * @type {{ object: any, idPrefix?: string, onswitch?: (index: number, anchor: HTMLElement) => void, onselectfaces?: (index: number) => void, onassign?: (index: number) => void, canAssign?: boolean, extra?: import('svelte').Snippet<[number]>, rowAttrs?: (index: number) => Record<string, any>, rowClass?: (index: number) => string, ondragover?: (e: DragEvent, index: number) => void, ondragleave?: (index: number) => void, ondrop?: (e: DragEvent, index: number) => void }}
	 */
	let {
		object,
		idPrefix = 'slot',
		onswitch,
		onselectfaces,
		onassign,
		canAssign = false,
		extra,
		rowAttrs,
		rowClass,
		ondragover,
		ondragleave,
		ondrop
	} = $props();

	const rows = $derived.by(() => {
		$objectsGroup; // in-place slot edits poke this store
		const own = materialsOf(object);
		return slotsOf(object).map((s) => {
			const m = own[s.index];
			return {
				...s,
				color: m?.color ? '#' + m.color.getHexString() : null,
				image: mapPreviewUrl(m)
			};
		});
	});
	const active = $derived(Math.min($activeMaterialSlot, Math.max(rows.length - 1, 0)));

	/** inline rename: the row index being renamed */
	let renaming = $state(-1);
	let draft = $state('');
	/** Remove… asking where the faces go: the row index */
	let removing = $state(-1);
	let removeTo = $state(0);

	/** @param {number} i */
	const label = (i) => rows[i]?.name || 'Slot ' + (i + 1);

	/** @param {number} i */
	function choose(i) {
		activeMaterialSlot.set(i);
		// the flash is a lazy helper: loaded on the first tap
		import('$lib/slotFlash.js').then((m) => m.flashSlotFaces(object, i)).catch(() => {});
	}

	/** @param {number} i @param {number} x @param {number} y */
	function openMenu(i, x, y) {
		const row = rows[i];
		if (!row) return;
		const n = rows.length;
		fieldMenu.set({
			x,
			y,
			items: [
				{ label: 'Rename', testid: idPrefix + '-menu-rename', action: () => startRename(i) },
				...(onswitch
					? [
							{
								label: 'Switch material…',
								testid: idPrefix + '-menu-switch',
								action: () => onswitch?.(i, rowEl(i))
							}
						]
					: []),
				...(onselectfaces
					? [
							{
								label: 'Select its faces',
								testid: idPrefix + '-menu-select',
								disabled: !row.faces,
								action: () => onselectfaces?.(i)
							}
						]
					: []),
				...(onassign
					? [
							{
								label: 'Assign selected faces',
								testid: idPrefix + '-menu-assign',
								disabled: !canAssign,
								action: () => onassign?.(i)
							}
						]
					: []),
				// 105-slots LINK: a shared slot can take its own copy back
				...(row.shared > 1
					? [
							{
								label: 'Make unique',
								testid: idPrefix + '-menu-unique',
								action: () => makeSlotUnique(object.uuid, i)
							}
						]
					: []),
				{
					label: 'Duplicate',
					testid: idPrefix + '-menu-duplicate',
					action: () => duplicateSlot(object.uuid, i)
				},
				{
					label: 'Move up',
					testid: idPrefix + '-menu-up',
					disabled: i === 0,
					action: () => moveSlot(object.uuid, i, -1)
				},
				{
					label: 'Move down',
					testid: idPrefix + '-menu-down',
					disabled: i === n - 1,
					action: () => moveSlot(object.uuid, i, 1)
				},
				{
					label: 'Remove…',
					testid: idPrefix + '-menu-remove',
					danger: true,
					disabled: n < 2,
					action: () => askRemove(i)
				}
			]
		});
	}

	/** @param {number} i */
	const rowEl = (i) => /** @type {HTMLElement} */ (document.getElementById(idPrefix + '-row-' + i));

	/** @param {MouseEvent} e @param {number} i */
	function menuFrom(e, i) {
		const r = /** @type {HTMLElement} */ (e.currentTarget).getBoundingClientRect();
		openMenu(i, r.right, r.bottom);
	}

	/** @param {number} i */
	function startRename(i) {
		renaming = i;
		draft = rows[i]?.name ?? '';
		queueMicrotask(() =>
			/** @type {HTMLInputElement | null} */ (
				document.getElementById(idPrefix + '-rename-' + i)
			)?.select()
		);
	}
	function commitRename() {
		if (renaming >= 0) renameSlot(object.uuid, renaming, draft);
		renaming = -1;
	}

	/** @param {number} i */
	function askRemove(i) {
		if (!rows[i]?.faces) {
			removeSlot(object.uuid, i);
			return;
		}
		removing = i;
		removeTo = i === 0 ? 1 : 0;
	}
	function confirmRemove() {
		if (removing >= 0 && removeSlot(object.uuid, removing, removeTo))
			showToast(label(removing) + ' removed');
		removing = -1;
	}

	/** keyboard: arrows move between rows, Enter / Space pick, the context-menu key opens the menu @param {KeyboardEvent} e @param {number} i */
	function onRowKey(e, i) {
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			const next = Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
			/** @type {HTMLElement | null} */ (
				document.querySelector('#' + idPrefix + '-row-' + next + ' .slot-main')
			)?.focus();
		} else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
			e.preventDefault();
			const r = /** @type {HTMLElement} */ (e.currentTarget).getBoundingClientRect();
			openMenu(i, r.left + 24, r.bottom);
		}
	}
</script>

<!-- Escape on the list closes a menu it opened: a menu opened by a CLICK on ⋯ can leave focus on that button (the
     shared menu's own Escape lives in its filter field), measured in material-slots-ui U3.7 -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<ul
	class="slot-list"
	id="{idPrefix}-list"
	aria-label="Material slots"
	onkeydown={(e) => {
		if (e.key === 'Escape' && get(fieldMenu)) {
			e.preventDefault();
			e.stopPropagation();
			fieldMenu.set(null);
		}
	}}
>
	{#each rows as row (row.id)}
		<!-- the row is a drop target when the host asks (the UV editor's image drop); its controls are the buttons -->
		<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
		<li
			id="{idPrefix}-row-{row.index}"
			class="slot-row {row.index === active ? 'slot-row-active' : ''} {rowClass?.(row.index) ?? ''}"
			data-slot-id={row.id}
			{...rowAttrs?.(row.index) ?? {}}
			ondragover={ondragover ? (e) => ondragover(e, row.index) : undefined}
			ondragleave={ondragleave ? () => ondragleave(row.index) : undefined}
			ondrop={ondrop ? (e) => ondrop(e, row.index) : undefined}
		>
			{#if renaming === row.index}
				<input
					id="{idPrefix}-rename-{row.index}"
					class="slot-rename"
					aria-label="Slot name"
					maxlength="80"
					bind:value={draft}
					onkeydown={(e) => {
						if (e.key === 'Enter') commitRename();
						else if (e.key === 'Escape') renaming = -1;
					}}
					onblur={commitRename}
				/>
			{:else}
				<button
					class="slot-main"
					aria-pressed={row.index === active}
					aria-label="{label(row.index)}{row.off ? ', off' : ''}{row.kind === 'shader'
						? ', shader'
						: ''}{row.shared > 1
						? ', shared by ' + row.shared + ' slots'
						: ''}, {row.faces} {row.faces === 1 ? 'face' : 'faces'}"
					title="{label(
						row.index
					)} — {row.faces} face triangles. Right-click or long-press for more."
					onclick={() => choose(row.index)}
					oncontextmenu={(e) => {
						e.preventDefault();
						openMenu(row.index, e.clientX, e.clientY);
					}}
					onkeydown={(e) => onRowKey(e, row.index)}
					use:touchHold={{ onhold: (x, y) => openMenu(row.index, x, y) }}
				>
					<span
						class="slot-swatch"
						style="{row.color ? `background-color:${row.color};` : ''}{row.image
							? `background-image:url(&quot;${row.image}&quot;);`
							: ''}"
					></span>
					<span class="slot-name">{label(row.index)}</span>
					{#if row.shared > 1}<span
							class="slot-badge slot-badge-shared"
							title="This slot shares its material: editing it changes all {row.shared}"
							>Shared · used by {row.shared}</span
						>{/if}
					{#if row.kind === 'shader'}<span class="slot-badge">Shader</span>{/if}
					{#if row.off}<span class="slot-badge slot-badge-off">Off</span>{/if}
				</button>
			{/if}
			{@render extra?.(row.index)}
			{#if rows.length > 1}
				<button
					class="slot-btn"
					id="{idPrefix}-eye-{row.index}"
					aria-pressed={!row.off}
					aria-label={row.off ? `Show ${label(row.index)}` : `Switch ${label(row.index)} off`}
					title={row.off
						? 'Off — it draws the plain default. Click to show its material.'
						: 'Switch this slot off (it draws the plain default)'}
					onclick={() => setSlotOff(object.uuid, row.index, !row.off)}
				>
					<Icon name={row.off ? 'eye-off' : 'eye'} size={16} aria-hidden="true" />
				</button>
			{/if}
			<button
				class="slot-btn"
				id="{idPrefix}-more-{row.index}"
				aria-haspopup="menu"
				aria-label="{label(row.index)} actions"
				title="Slot actions"
				onclick={(e) => menuFrom(e, row.index)}
			>
				<Icon name="ellipsis" size={16} aria-hidden="true" />
			</button>
		</li>
		{#if removing === row.index}
			<li class="slot-remove" id="{idPrefix}-remove-ask">
				<label class="slot-remove-label" for="{idPrefix}-remove-to"
					>Move its {row.faces} {row.faces === 1 ? 'face' : 'faces'} to</label
				>
				<select id="{idPrefix}-remove-to" class="slot-remove-select" bind:value={removeTo}>
					{#each rows.filter((r) => r.index !== removing) as other (other.id)}
						<option value={other.index}>{label(other.index)}</option>
					{/each}
				</select>
				<button
					class="ui-button-quiet slot-remove-go"
					id="{idPrefix}-remove-confirm"
					onclick={confirmRemove}>Remove</button
				>
				<button
					class="ui-button-quiet"
					id="{idPrefix}-remove-cancel"
					onclick={() => (removing = -1)}>Cancel</button
				>
			</li>
		{/if}
	{/each}
</ul>

<style>
	.slot-list {
		display: flex;
		flex-direction: column;
		gap: 2px;
		margin: 0 0 6px;
		padding: 0;
		list-style: none;
	}
	.slot-row {
		display: flex;
		align-items: center;
		min-height: 32px;
		border-radius: var(--radius-button);
		border: 1px solid transparent;
	}
	.slot-row-active {
		border-color: var(--accent);
		background: var(--accent-soft);
	}
	.slot-main {
		display: flex;
		flex: 1;
		min-width: 0;
		align-items: center;
		gap: 8px;
		padding: 4px 6px;
		min-height: 32px;
		text-align: left;
		font-size: var(--fs-body);
		color: var(--text-2);
	}
	.slot-row-active .slot-main {
		color: var(--accent-soft-text);
	}
	.slot-swatch {
		width: 22px;
		height: 22px;
		flex-shrink: 0;
		border-radius: var(--radius-input);
		border: 1px solid var(--border);
		background-size: cover;
		background-position: center;
	}
	.slot-name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.slot-badge {
		flex-shrink: 0;
		padding: 0 5px;
		border-radius: 999px;
		border: 1px solid var(--border);
		font-size: var(--fs-badge);
		color: var(--text-muted);
	}
	.slot-badge-off {
		color: var(--ink-warn, var(--text-muted));
	}
	.slot-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		flex-shrink: 0;
		border-radius: var(--radius-button);
		color: var(--text-2);
	}
	.slot-btn:hover,
	.slot-main:hover {
		background: var(--surface-hover);
	}
	.slot-rename {
		flex: 1;
		min-width: 0;
		margin: 2px;
		padding: 4px 6px;
		font-size: var(--fs-body);
		background: var(--surface-inset);
		color: var(--text);
		border: 1px solid var(--accent);
		border-radius: var(--radius-button);
	}
	.slot-remove {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		padding: 6px;
		border: 1px solid var(--border);
		border-radius: var(--radius-button);
		font-size: var(--fs-body);
		color: var(--text-2);
	}
	.slot-remove-select {
		min-width: 0;
		flex: 1;
		background: var(--surface-inset);
		color: var(--text);
		border: 1px solid var(--border);
		border-radius: var(--radius-button);
		padding: 2px 4px;
	}
	/* 105 touch: Find N6 folded and unfolded — 44 px rows and 44 px targets */
	@media (pointer: coarse) {
		.slot-row,
		.slot-main {
			min-height: 44px;
		}
		.slot-btn {
			width: 44px;
			height: 44px;
		}
		.slot-remove-select,
		.slot-remove button {
			min-height: 44px;
		}
	}
</style>

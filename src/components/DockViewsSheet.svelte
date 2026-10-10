<script>
	// 40 F9 — the dock's "+" on a PHONE (with floating windows off): a sheet listing EVERY
	// window, each with a show/hide switch. On the desktop — and on a phone with floating
	// windows on (Settings ▸ Interface ▸ Allow undocking on touch screens) — "+" keeps its
	// add-a-view menu, which brings views into the dock. Here a window can only ever live in
	// the dock, so "show" opens it there as the visible tab and "hide" closes it.
	//
	// Portaled to <body>: the dock panel is a fixed, z-indexed box, so a sheet left inside it
	// would sit in the dock's stacking context, under the phone bar and the Play button.
	import Sheet from './ui/Sheet.svelte';
	import Toggle from './ui/Toggle.svelte';
	import Icon from './ui/Icon.svelte';
	import { dockSheetRows, setDockViewShown } from '$lib/dockMenu';
	import { dockOccupants, DOCK_ICONS } from '$lib/bottomDock';

	/** @type {{open?: boolean}} */
	let { open = $bindable(false) } = $props();

	// re-read whenever the dock's occupants change (a toggle docks/undocks a view); the
	// arguments are what the derived depends on — dockSheetRows reads them through get()
	/** @param {any} _occupants @param {boolean} _open */
	const rowsFor = (_occupants, _open) => dockSheetRows();
	const rows = $derived(rowsFor($dockOccupants, open));

	/** @param {HTMLElement} node */
	function portal(node) {
		document.body.appendChild(node);
		return { destroy: () => node.remove() };
	}
</script>

<div use:portal>
	<Sheet bind:open title="Windows" detents={['half', 'full']} id="dock-views-sheet" modal topInset={124}>
		<ul class="dvs-list" aria-label="Windows">
			{#each rows as row (row.key)}
				<li class="dvs-row" data-dock-view={row.key}>
					<span class="dvs-ico" aria-hidden="true"><Icon name={DOCK_ICONS[row.key] ?? 'app-window'} size={20} /></span>
					<span class="dvs-text">
						<span class="dvs-title">{row.title}</span>
						<span class="dvs-desc">{row.tooltip}</span>
					</span>
					<Toggle
						id="dock-view-toggle-{row.key}"
						label="Show {row.title}"
						checked={row.open}
						onchange={(/** @type {boolean} */ on) => setDockViewShown(row.key, on)}
					/>
				</li>
			{/each}
		</ul>
	</Sheet>
</div>

<style>
	/* NOTES-38 #32 / 40 F1: a sheet ends at the phone bar — Play stays visible and tappable
	   (the bar's height is the phone shell's --ps-bar-h; 0 when there is no bar) */
	:global(.sh#dock-views-sheet) {
		bottom: var(--ps-bar-h, 0px) !important;
	}
	.dvs-list {
		display: grid;
		/* a track sizes to its widest unwrapped description otherwise, and pushes the switches
		   off the sheet's right edge */
		grid-template-columns: minmax(0, 1fr);
		gap: var(--space-1);
		margin: 0;
		padding: 0 var(--space-2) var(--space-4);
		list-style: none;
	}
	.dvs-row {
		display: flex;
		min-width: 0;
		align-items: center;
		gap: var(--space-3);
		min-height: 52px;
		padding: var(--space-1) var(--space-2);
		border-radius: var(--radius-input);
	}
	.dvs-ico {
		display: inline-flex;
		color: var(--text-muted);
	}
	.dvs-text {
		display: flex;
		flex: 1;
		flex-direction: column;
		min-width: 0;
	}
	.dvs-title {
		color: var(--text);
		font-size: var(--fs-body);
		font-weight: 600;
	}
	.dvs-desc {
		overflow: hidden;
		color: var(--text-muted);
		font-size: var(--fs-desc);
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>

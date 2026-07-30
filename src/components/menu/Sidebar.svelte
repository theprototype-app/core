<script lang="ts">
	import '../../app.css';
	import '../../styles/menu.css';
	import { tick } from 'svelte';
	import { fade } from 'svelte/transition';
	import { save, load, importFile } from '$lib/fileHandler.svelte';
	import {
		settingsOpen,
		inspectorClose,
		inspectorKind,
		closeSelectionInspector,
		showSidebar,
		closeMenu,
		modulesOpen,
		sessionsOpen,
		characterModalOpen,
		profileSettingsOpen,
		showToast,
		connectDocked,
		connectBarHeight
	} from '../../stores/appStore.js';
	import { objectsGroup } from '../../stores/sceneStore';
	import { sceneCommand } from '$lib/commandsHandler.svelte';
	import { whatsNewUnseen, openWhatsNew } from '$lib/whatsNew';

	// 203: redesigned as a compact floating panel — flat list (order preserved,
	// no boxed group / section headers / vertical bar), a fast fade-in (was a
	// slide from the left), narrower than the Properties sidebar so it needs no
	// scrollbar, and floated ABOVE the bottom dock (z-hud) instead of covered.
	// The Files format picker became a segmented control (the old dropdown was
	// fiddly). Themed for light + dark.

	// B3: Scene (.tpscene) is the primary format; JSON is demoted behind the
	// export-settings cog ("Show JSON") since it's rarely used
	const initShowJson = typeof localStorage !== 'undefined' && localStorage.getItem('showJsonFormat') === 'true';
	const initFormat = typeof localStorage !== 'undefined' ? localStorage.getItem('saveFormat') || 'tpscene' : 'tpscene';
	let saveFormat = $state(initFormat === 'json' && !initShowJson ? 'tpscene' : initFormat);
	let showJson = $state(initShowJson);
	let exportSettingsOpen = $state(false);
	// export-settings popup is anchored BELOW-RIGHT of the cog (so its relation is
	// clear), clamped to the viewport when there isn't room
	let exportPos = $state({ top: 0, left: 0 });
	function openExportSettings(e: MouseEvent) {
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const w = 256;
		const h = 240;
		let left = r.left; // top-left of the popup aligns under the cog, extending right
		let top = r.bottom + 6;
		left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
		top = Math.max(8, Math.min(top, window.innerHeight - h - 8));
		exportPos = { top, left };
		exportSettingsOpen = true;
	}
	let tpAssets = $state(typeof localStorage !== 'undefined' && localStorage.getItem('tpsceneAssets') !== 'false');
	let tpPacks = $state(typeof localStorage !== 'undefined' && localStorage.getItem('tpscenePacks') === 'true');
	let tpFlow = $state(typeof localStorage !== 'undefined' && localStorage.getItem('tpsceneFlow') !== 'false');
	function pickFormat(f: string) {
		saveFormat = f;
		localStorage.setItem('saveFormat', f);
	}
	// Clearing value (instead of the old {#key} recreate) lets the same file be
	// re-picked without detaching the input mid-dialog — a detached input's event
	// never reaches Svelte 5's delegated oninput, so the pick was silently dropped.
	function pickFile(id: string) {
		const input = document.getElementById(id) as HTMLInputElement | null;
		if (!input) return;
		input.value = '';
		input.click();
	}

	// A6: clicking the logo while ANY modal is open closes every modal and OPENS the
	// menu in ONE step. (Previously it toggled the menu regardless of state, so a modal
	// opened from the avatar — where the menu was already "open" — flipped the menu shut
	// and only the modal's own outside-click closed it, causing a flicker.)
	async function toggleMenu() {
		if ($settingsOpen || $modulesOpen || $sessionsOpen || $characterModalOpen || $profileSettingsOpen) {
			settingsOpen.set(false);
			modulesOpen.set(false);
			sessionsOpen.set(false);
			characterModalOpen.set(false);
			profileSettingsOpen.set(false);
			// closing a modal fires its restorePanels(), which resets closeMenu to the
			// pre-modal value — open the menu AFTER that flush so it wins (previously the
			// menu flickered open then shut).
			await tick();
			closeMenu.set(false);
			return;
		}
		closeMenu.update((value) => !value);
	}

	function clearScene() {
		const count = $objectsGroup?.children.length ?? 0;
		if (count === 0) {
			sceneCommand('/clear all'); // still clears module content
			return;
		}
		showToast('Clear the scene for everyone? ' + count + ' object' + (count === 1 ? '' : 's') + ' will be removed.', [
			{
				label: 'Clear',
				action: () => {
					closeSelectionInspector();
					sceneCommand('/clear all');
				}
			},
			{ label: 'Cancel', action: () => {} }
		]);
	}
</script>

<!-- 94: the logo IS the menu button. Open state = accent ring. -->
<button
	id="logo-menu"
	class="burger flex items-center justify-center rounded-lg border bg-gray-800/90 shadow-lg backdrop-blur transition-transform hover:scale-105 {$closeMenu
		? 'border-gray-700/60'
		: 'border-primary-500 ring-2 ring-primary-500/50'}"
	style="height: 48px; width: 48px; {$connectDocked ? `top: ${$connectBarHeight + 8}px` : ''}"
	title={$closeMenu ? 'Open menu' : 'Close menu'}
	onclick={toggleMenu}
>
	<img src="logo.svg" alt="menu" class="h-9 w-9" />
	<!-- RW/B4: unseen-update cue. A dot, never a boot dialog — the menu's "What's new"
	     row (and the one update toast) lead to the changelog. Class toggle, not an
	     {#if}, so nothing is destroyed mid-flush when the cue clears (see the row). -->
	<span class="update-dot" class:update-dot-on={$whatsNewUnseen} title="Updated — see what's new"></span>
</button>

{#if !$closeMenu}
	<nav
		id="sidebar70"
		transition:fade={{ duration: 130 }}
		class="app-sidebar fixed rounded-xl border border-gray-200 bg-white/95 p-1.5 text-gray-900 shadow-xl backdrop-blur dark:border-gray-700 dark:bg-gray-800/95 dark:text-gray-100"
		style={$connectDocked ? `top: ${$connectBarHeight + 64}px` : ''}
	>
		<input type="file" id="import-file" style="display: none" oninput={(e: any) => importFile(e.target.files[0])} accept=".gltf, .glb, .obj, .stl, .fbx" />
		<input type="file" id="load-file" style="display: none" oninput={(e: any) => load(e.target.files[0])} accept=".json, .tpscene" />

		<!-- Files -->
		<button class="side-row" onclick={() => pickFile('import-file')}>
			<span class="side-ico"><i class="fa-solid fa-file-import"></i></span><span class="flex-1 whitespace-nowrap">Import</span>
		</button>
		<button class="side-row" onclick={() => pickFile('load-file')}>
			<span class="side-ico"><i class="fa-solid fa-folder-open"></i></span><span class="flex-1 whitespace-nowrap">Load</span>
		</button>
		<button class="side-row" onclick={() => save(saveFormat)}>
			<span class="side-ico"><i class="fa-solid fa-floppy-disk"></i></span><span class="flex-1 whitespace-nowrap">Save</span>
		</button>
		<div class="mb-0.5 mt-0.5 flex gap-1 pl-9 pr-2">
			<button class="side-seg {saveFormat === 'gltf' ? 'on' : ''}" onclick={() => pickFormat('gltf')}>GLTF</button>
			<button id="format-tpscene" class="side-seg {saveFormat === 'tpscene' ? 'on' : ''}" onclick={() => pickFormat('tpscene')}>Scene</button>
			{#if showJson}
				<button class="side-seg {saveFormat === 'json' ? 'on' : ''}" onclick={() => pickFormat('json')}>JSON</button>
			{/if}
			<button id="export-settings-cog" class="side-seg" title="Export settings" onclick={openExportSettings}><i class="fa-solid fa-gear"></i></button>
		</div>

		<div class="side-div"></div>

		<!-- Scene -->
		<button class="side-row" onclick={() => showSidebar('scene')}>
			<span class="side-ico"><i class="fa-solid fa-sliders"></i></span>
			<span class="flex-1 whitespace-nowrap">{!$inspectorClose && $inspectorKind === 'scene' ? '● ' : ''}Configure Scene</span>
		</button>
		<button class="side-row" onclick={clearScene}>
			<span class="side-ico"><i class="fa-solid fa-trash-can"></i></span><span class="flex-1 whitespace-nowrap">Clear Scene</span>
		</button>
		<button id="open-modules-manager" class="side-row" onclick={() => { modulesOpen.set(true); closeMenu.set(true); }}>
			<span class="side-ico"><i class="fa-solid fa-puzzle-piece"></i></span><span class="flex-1 whitespace-nowrap">Modules</span>
		</button>
		<button id="open-sessions-manager" class="side-row" onclick={() => { sessionsOpen.set(true); closeMenu.set(true); }}>
			<span class="side-ico"><i class="fa-solid fa-box-archive"></i></span><span class="flex-1 whitespace-nowrap">Sessions</span>
		</button>

		<div class="side-div"></div>

		<!-- App -->
		<button class="side-row" onclick={() => { settingsOpen.set(!$settingsOpen); closeMenu.set(true); }}>
			<span class="side-ico"><i class="fa-solid fa-gear"></i></span><span class="flex-1 whitespace-nowrap">Settings</span>
		</button>
		<button class="side-row" onclick={() => window.open('https://docs.theprototype.app', '_blank')}>
			<span class="side-ico"><i class="fa-solid fa-book"></i></span><span class="flex-1 whitespace-nowrap">Docs</span>
		</button>
		<!-- the unseen cue is a CLASS toggle, not an {#if}: clicking this row closes the
		     menu, and destroying a nested branch inside the subtree being destroyed in
		     the same flush crashes Svelte's sibling walk (destroy_effect). -->
		<button id="open-whats-new" class="side-row" onclick={() => { openWhatsNew(); closeMenu.set(true); }}>
			<span class="side-ico">✨</span>
			<span class="flex-1 whitespace-nowrap">What's new</span>
			<span class="row-dot" class:row-dot-on={$whatsNewUnseen}></span>
		</button>
	</nav>
{/if}

{#if exportSettingsOpen}
	<!-- B3 export settings. Rendered at the component ROOT (not inside .app-sidebar,
	     whose backdrop-blur would make this fixed panel center on the sidebar and
	     spill off the left edge). Modal tier so it clears the avatar/Connect chrome. -->
	<button
		class="fixed inset-0 cursor-default bg-black/40"
		style="z-index: calc(var(--z-menu) + 1)"
		aria-label="Close export settings"
		onclick={() => (exportSettingsOpen = false)}
	></button>
	<div
		id="export-settings-modal"
		class="fixed w-64 max-w-[92vw] rounded-lg border border-gray-700 bg-gray-800 p-4 text-sm text-gray-100 shadow-2xl"
		style="z-index: calc(var(--z-menu) + 2); top: {exportPos.top}px; left: {exportPos.left}px;"
	>
		<p class="mb-2 font-semibold">Export settings</p>
		<p class="mb-1 text-[11px] text-gray-400">Scene (.tpscene) includes:</p>
		<label class="flex items-center gap-2 py-0.5">
			<input type="checkbox" checked={tpAssets} onchange={(e: any) => { tpAssets = e.target.checked; localStorage.setItem('tpsceneAssets', String(tpAssets)); }} />
			Assets (audio, textures, configs)
		</label>
		<label class="flex items-center gap-2 py-0.5">
			<input id="tpscene-packs" type="checkbox" checked={tpPacks} onchange={(e: any) => { tpPacks = e.target.checked; localStorage.setItem('tpscenePacks', String(tpPacks)); }} />
			Imported packs
		</label>
		<label class="flex items-center gap-2 py-0.5">
			<input id="tpscene-flow" type="checkbox" checked={tpFlow} onchange={(e: any) => { tpFlow = e.target.checked; localStorage.setItem('tpsceneFlow', String(tpFlow)); }} />
			Flow graph (nodes + edges)
		</label>
		<div class="my-2 border-t border-gray-700"></div>
		<label class="flex items-center gap-2 py-0.5">
			<input type="checkbox" checked={showJson} onchange={(e: any) => { showJson = e.target.checked; localStorage.setItem('showJsonFormat', String(showJson)); if (!showJson && saveFormat === 'json') pickFormat('tpscene'); }} />
			Show JSON format
		</label>
		<div class="mt-3 flex justify-end">
			<button class="rounded bg-gray-600 px-2 py-1 text-xs hover:bg-gray-500" onclick={() => (exportSettingsOpen = false)}>Close</button>
		</div>
	</div>
{/if}

<style>
	.burger {
		background-color: var(--color-form);
		top: 8px;
		left: 8px;
		/* .burger is position:absolute in menu.css — that already anchors .update-dot */
	}
	/* unseen-update cue: a small accent dot on the logo corner + on the menu row */
	.update-dot {
		position: absolute;
		top: 5px;
		right: 5px;
		width: 9px;
		height: 9px;
		border-radius: 50%;
		background: #60a5fa;
		box-shadow: 0 0 0 2px var(--color-form, #1f2937);
		visibility: hidden;
	}
	.update-dot-on {
		visibility: visible;
	}
	.row-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: #60a5fa;
		flex: 0 0 auto;
		visibility: hidden;
	}
	.row-dot-on {
		visibility: visible;
	}
	/* the logo menu opens above everything (Connect, toasts) */
	.app-sidebar {
		top: 64px;
		left: 8px;
		z-index: var(--z-menu);
		/* size to the widest row so wider-font themes (e.g. 8-bit) never overflow
		   the panel and overlap the scene; clamped so it stays compact */
		width: max-content;
		min-width: 12.5rem;
		max-width: 17rem;
		/* short viewports: touch-scroll the menu, but with no visible scrollbar */
		max-height: calc(100vh - 72px);
		overflow-y: auto;
		overflow-x: hidden;
		scrollbar-width: none; /* Firefox */
		-webkit-overflow-scrolling: touch;
	}
	.app-sidebar::-webkit-scrollbar {
		display: none; /* Chrome/Safari — scroll, no bar */
	}
	.side-row {
		display: flex;
		width: 100%;
		align-items: center;
		gap: 0.5rem;
		border-radius: 0.375rem;
		padding: 0.4rem 0.5rem;
		text-align: left;
		font-size: 0.875rem;
	}
	.side-row:hover {
		background-color: rgb(0 0 0 / 0.06);
	}
	:global(.dark) .side-row:hover {
		background-color: rgb(255 255 255 / 0.08);
	}
	.side-ico {
		width: 1.25rem;
		flex-shrink: 0;
		text-align: center;
	}
	.side-div {
		margin: 0.35rem 0.25rem;
		border-top: 1px solid rgb(0 0 0 / 0.1);
	}
	:global(.dark) .side-div {
		border-top-color: rgb(255 255 255 / 0.1);
	}
	.side-seg {
		flex: 1;
		border-radius: 0.25rem;
		padding: 0.1rem 0.4rem;
		font-size: 0.625rem;
		font-weight: 600;
		background-color: rgb(0 0 0 / 0.06);
		color: rgb(75 85 99);
	}
	:global(.dark) .side-seg {
		background-color: rgb(255 255 255 / 0.08);
		color: rgb(209 213 219);
	}
	.side-seg.on {
		background-color: var(--color-primary-600, #2563eb);
		color: #fff;
	}
	/* When the Connect bar docks to a full-width top strip, the logo + its menu drop
	   below it — driven dynamically by connectDocked/connectBarHeight (inline `top`),
	   which adapts to the bar's height (incl. its pinned tab strip) at any width. */
</style>

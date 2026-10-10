<script module>
	import { registerSettingsKeywords } from '$lib/settingsSearch';
	// 36 I4 / 37-settings: the words this page answers to beyond its row names — the old labels of the
	// rows this redesign renamed (docs/settings-inventory.md, Decision C) and the words the absorbed
	// section files carried (text selection, avatars, tours).
	const ROW_WORDS = {
		'show others as classic heads': ['show everyone as classic heads', 'avatar', 'avatars', 'character', 'peers', 'body'],
		'your character': ['avatar', 'customize', 'customise', 'outfit', 'hat', 'head', 'ping'],
		'allow text selection everywhere': ['select', 'selection', 'text', 'copy', 'highlight', 'drag'],
		density: ['compact', 'comfortable', 'spacing', 'rows', 'dense', 'size'],
		'welcome card on start': ['welcome on start', 'welcome'],
		'show pop-ups only in the drawer': ['toasts in drawer only', 'toasts', 'notifications'],
		'show tours automatically': ['tour', 'tours', 'tutorial', 'onboarding', 'first run', 'guide'],
		'vr welcome tour': ['vr welcome', 'controllers', 'quest', 'tour', 'tutorial'],
		'editor tour': ['tour', 'tutorial', 'help', 'guide'],
		'offer enter vr in a headset browser': ['offer enter vr', 'enter vr', 'headset browser', 'quest'],
		'reset tours': ['tour', 'tours', 'tutorial'],
		'lift the toolbar above docked panels': ['floating toolbar', 'toolbar'],
		'allow undocking on touch screens': ['allow undocking (touch)', 'undock', 'touch', 'phone'],
		'show system objects in the object list': ['advanced mode', 'advanced', 'system'],
		'show the environment in the object list': ['environment in list', 'environment'],
		'object search in the right-click menu': ['object search in menu', 'search objects', 'context menu'],
		'show fps and draw calls': ['show fps + draw calls', 'fps', 'performance', 'frame rate', 'framerate'],
		'knocked-off idle': ['idle', 'away', 'afk', 'dizzy', 'knocked', 'stars', 'avatar', 'character'],
		'undock button': ['undock', 'dock', 'float', 'floating', 'window', 'tabs', 'tabbed', 'group'],
		'workspace layouts': ['layout', 'layouts', 'workspace', 'windows', 'dock', 'docked', 'panels', 'arrangement', 'save layout', 'restore layout', 'sizes']
	};
	for (const [row, words] of Object.entries(ROW_WORDS)) registerSettingsKeywords(row, words);
</script>

<script>
	// 37-settings (R21) — Settings ▸ Interface on the redesign kit (docs/settings-inventory.md §3.1):
	// cards with one control per row, toggles for every on/off, sliders with a mono readout, scope as
	// a badge. Every row writes the SAME store / key as 1.25.0 (tests/unit/settingsInventory). It
	// absorbs TextSelectionSettings, AvatarSettings and ToursSettings (their rows live here now).
	// NOTES-38 #19: the Density row (new) — the kit's token switch, stored per device.
	import Section from '../../ui/Section.svelte';
	import SettingRow from '../../ui/SettingRow.svelte';
	import Toggle from '../../ui/Toggle.svelte';
	import Segmented from '../../ui/Segmented.svelte';
	import Slider from '../../ui/Slider.svelte';
	import Button from '../../ui/Button.svelte';
	import ThemedSelect from '../../ui/ThemedSelect.svelte';
	import {
		settingsOpen,
		characterModalOpen,
		toastsInDrawerOnly,
		showRoomsButton,
		floatingToolbar,
		toolbarAlwaysOnTop,
		touchTools,
		mobileUndockAllowed,
		advancedMode,
		showEnvInList,
		objectSearchEnabled,
		showToast
	} from '../../../stores/appStore.js';
	import { THEMES, theme, customThemes, exportActiveTheme, importThemeFile, removeCustomTheme } from '$lib/themes';
	import { allowTextSelection } from '$lib/textSelection';
	import { peersAsClassic, knockedAfterSeconds, KNOCKED_AFTER_CHOICES } from '$lib/avatars/avatarState';
	import WorkspaceLayoutsSettings from './WorkspaceLayoutsSettings.svelte'; // 37 R14
	import UndockButtonSettings from './UndockButtonSettings.svelte'; // 40 F8
	import { gameSoundVolume } from '$lib/gameSfx';
	import { gameMusicVolume } from '$lib/gameMusic';
	import { showWelcomeOnStart, showWhatsNewNotice, openWelcome } from '$lib/whatsNew';
	import { tours, tourRecords } from '$lib/tours/index.js';
	import { VR_TOUR, editorTourId, startVRWelcome, startEditorTour, resetAllTours } from '$lib/tours/builtin.js';
	import { xrOfferEnabled } from '$lib/xrOffer';
	import { drawerSlot } from '$lib/cloudHooks';
	import { resetWindowLayout } from '$lib/dragWindow';
	import { perfStatsShown } from '$lib/fpsMeter';
	import { perfReportsOn, perfReportsAvailable } from '$lib/perf/beacon';
	import { viewPrefs, setViewPrefs } from '$lib/viewPrefs';
	import { uiDensity, DENSITIES } from '$lib/uiDensity';

	const pct = (/** @type {number} */ v) => Math.round(v * 100) + '%';
	const themeItems = $derived([...THEMES, ...$customThemes].map((t) => ({ value: t.id, name: t.name })));

	/** @type {HTMLInputElement | null} */
	let themeFileInput = $state(null);
	/** custom theme import (149): a hidden file input + a validating handler @param {Event & {currentTarget: HTMLInputElement}} e */
	async function onThemeFile(e) {
		const input = e.currentTarget;
		const file = input.files?.[0];
		input.value = '';
		if (!file) return;
		const id = await importThemeFile(file);
		showToast(id ? 'Theme imported' : 'Not a valid .theme.json file');
	}

	/** @param {string} id @param {any} _records re-read when a record changes */
	function tourStatus(id, _records) {
		const status = tours.status(id);
		if (status === 'done') return 'Seen';
		if (status === 'progress') return 'Started';
		return 'Not seen yet';
	}
	/** @param {any} _records re-read when a record changes */
	const autoStartOn = (_records) => tours.autoStartEnabled();
	const autoTours = $derived(autoStartOn($tourRecords));
	const editorTouch = editorTourId() === 'editor-touch';

	function close() {
		settingsOpen.set(false);
	}
</script>

<div class="settings-page-body" data-keywords="appearance toolbar menu">
	<Section variant="card" label="Appearance" badge="This device">
		<SettingRow id="row-theme" label="Theme" description="The 3D viewport follows the scene environment, not the theme." keywords="dark light colour color contrast appearance">
			<ThemedSelect id="theme-select" items={themeItems} bind:value={$theme} />
		</SettingRow>
		<SettingRow id="row-density" label="Density" description="Compact tightens rows and controls to 32 px on a desktop screen.">
			<Segmented id="density" label="Density" options={DENSITIES} value={$uiDensity} onchange={(v) => uiDensity.set(v)} />
		</SettingRow>
		<SettingRow id="row-custom-theme" label="Custom theme" wide keywords="colours colors import export theme.json">
			{#snippet desc()}Export the current theme as <code>.theme.json</code>, edit the colours, then load it back.{/snippet}
			<Button id="theme-export" size="sm" variant="outline" onclick={() => exportActiveTheme()}>Export</Button>
			<Button id="theme-browse" size="sm" variant="outline" onclick={() => themeFileInput?.click()}>Load file…</Button>
			<input type="file" accept=".json,application/json" bind:this={themeFileInput} style="display: none" onchange={onThemeFile} />
			{#snippet extra()}
				{#if $customThemes.length}
					<div class="iface-themes" aria-label="Loaded themes">
						{#each $customThemes as ct (ct.id)}
							<span class="iface-theme-chip">
								{ct.name}
								<button type="button" class="iface-theme-x" title="Remove theme" aria-label={'Remove ' + ct.name} onclick={() => removeCustomTheme(ct.id)}>✕</button>
							</span>
						{/each}
					</div>
				{/if}
			{/snippet}
		</SettingRow>
		<SettingRow id="row-text-select" label="Allow text selection everywhere" description="When off, only fields, code, chat and logs are selectable, so dragging across panels never highlights text.">
			<Toggle id="allow-text-select" label="Allow text selection everywhere" bind:checked={$allowTextSelection} />
		</SettingRow>
	</Section>

	<Section variant="card" label="Avatars">
		<SettingRow id="row-character" label="Your character" description="Character, head, hat, outfit colour and ping.">
			<Button
				id="settings-customize-character"
				size="sm"
				variant="outline"
				onclick={() => {
					close();
					characterModalOpen.set(true);
				}}>Customize</Button
			>
		</SettingRow>
		<SettingRow id="row-classic-heads" label="Show others as classic heads" badge="This device" description="Lighter on headsets in busy rooms. Others still see your full character.">
			<Toggle id="avatars-peers-classic" label="Show others as classic heads" bind:checked={$peersAsClassic} />
		</SettingRow>
		<!-- 37 R22 (37-avatar-fix) -->
		<SettingRow
			id="avatars-knocked-row"
			label="Knocked-off idle"
			description="After this long with no input, people see stars circling your character's head and its eyes spin. Any key, click or move wakes you."
			badge="This device"
			wide
		>
			<Segmented
				id="avatars-knocked-after"
				label="Knocked-off idle after"
				options={KNOCKED_AFTER_CHOICES.map((s) => ({ value: String(s), label: s ? s + ' s' : 'Off' }))}
				value={String($knockedAfterSeconds)}
				onchange={(v) => knockedAfterSeconds.set(Number(v))}
			/>
		</SettingRow>
	</Section>

	<Section variant="card" label="Sound" badge="This device">
		<SettingRow id="row-game-sounds" label="Game sounds" description="Coins, goals, hits and clicks." keywords="sfx audio volume">
			<Slider id="setting-game-sound-volume" label="Game sounds volume" min={0} max={1} step={0.05} value={$gameSoundVolume} format={pct} onchange={(v) => gameSoundVolume.set(v)} />
		</SettingRow>
		<SettingRow id="row-music" label="Music" description="Plays in Interact and Play, stops when you edit." keywords="audio volume">
			<Slider id="setting-game-music-volume" label="Game music volume" min={0} max={1} step={0.05} value={$gameMusicVolume} format={pct} onchange={(v) => gameMusicVolume.set(v)} />
		</SettingRow>
	</Section>

	<Section variant="card" label="Notifications">
		<SettingRow id="row-welcome" label="Welcome card on start">
			{#snippet desc()}Normally shown only on your first visit. <button
					type="button"
					class="iface-link"
					onclick={() => {
						close();
						openWelcome();
					}}>Open it now</button
				>{/snippet}
			<Toggle id="welcome-on-start" label="Welcome card on start" bind:checked={$showWelcomeOnStart} />
		</SettingRow>
		<SettingRow id="row-announce" label="Announce new versions" description="After an update, show one toast and a dot on the logo menu.">
			<Toggle id="announce-versions" label="Announce new versions" bind:checked={$showWhatsNewNotice} />
		</SettingRow>
		<SettingRow id="row-toasts-drawer" label="Show pop-ups only in the drawer" description="Pop-ups, connection requests included, go to the connection drawer’s Toasts tab instead of the viewport.">
			<Toggle id="toasts-in-drawer" label="Show pop-ups only in the drawer" bind:checked={$toastsInDrawerOnly} />
		</SettingRow>
	</Section>

	<Section variant="card" label="Tours">
		<SettingRow id="row-tours-auto" label="Show tours automatically" description="Starts the editor tour after the welcome card, and the VR welcome on your first VR visit.">
			<Toggle id="setting-tours-auto" label="Show tours automatically" checked={autoTours} onchange={(on) => tours.setAutoStart(on)} />
		</SettingRow>
		<SettingRow id="row-tour-vr" label="VR welcome tour">
			{#snippet desc()}Controllers, moving, grabbing, the radial menu and leaving VR. <span class="iface-status">{tourStatus(VR_TOUR, $tourRecords)}</span>{/snippet}
			<Button
				id="setting-tour-vr"
				size="sm"
				variant="outline"
				onclick={() => {
					close();
					startVRWelcome();
				}}>Start</Button
			>
		</SettingRow>
		<SettingRow id="row-tour-editor" label="Editor tour">
			{#snippet desc()}Six steps around the editor ({editorTouch ? 'the touch-screen version' : 'mouse and keyboard'}). <span class="iface-status">{tourStatus(editorTourId(), $tourRecords)}</span>{/snippet}
			<Button
				id="setting-tour-editor"
				size="sm"
				variant="outline"
				onclick={() => {
					close();
					startEditorTour();
				}}>Start</Button
			>
		</SettingRow>
		<SettingRow id="row-xr-offer" label="Offer Enter VR in a headset browser" description="Lets the Quest browser show its own Enter VR button, once per visit.">
			<Toggle id="setting-xr-offer" label="Offer Enter VR in a headset browser" bind:checked={$xrOfferEnabled} />
		</SettingRow>
		<SettingRow id="row-tours-reset" label="Reset tours" description="Forgets which tours you have seen and turns automatic tours back on.">
			<Button id="setting-tours-reset" size="sm" variant="outline" onclick={resetAllTours}>Reset</Button>
		</SettingRow>
	</Section>

	<Section variant="card" label="Windows & chrome">
		{#if $drawerSlot}
			<SettingRow id="row-rooms-button" label="Show Rooms button" description="A Rooms shortcut in the Connect bar. Rooms stay in the connection drawer either way.">
				<Toggle id="show-rooms-button" label="Show Rooms button" bind:checked={$showRoomsButton} />
			</SettingRow>
		{/if}
		<SettingRow id="row-floating-toolbar" label="Lift the toolbar above docked panels" description="The bottom toolbar moves up when the Node editor or Explorer is docked.">
			<Toggle id="floating-toolbar" label="Lift the toolbar above docked panels" bind:checked={$floatingToolbar} />
		</SettingRow>
		<SettingRow id="row-toolbar-top" label="Toolbar always on top" description="The toolbar draws over panels and windows, so it is always reachable.">
			<Toggle id="toolbar-on-top" label="Toolbar always on top" bind:checked={$toolbarAlwaysOnTop} />
		</SettingRow>
		<SettingRow id="row-window-positions" label="Window positions" description="Brings back floating windows that drifted off-screen.">
			<Button
				id="reset-windows"
				size="sm"
				variant="outline"
				onclick={() => {
					resetWindowLayout();
					showToast('Window positions reset');
				}}>Reset</Button
			>
		</SettingRow>
		<WorkspaceLayoutsSettings />
		<UndockButtonSettings />
		<SettingRow id="row-touch-tools" label="Touch tools" description="Undo, Redo and Multi-select buttons beside the logo. On by default on phones.">
			<Toggle id="setting-touch-tools" label="Touch tools" bind:checked={$touchTools} />
		</SettingRow>
		<SettingRow id="row-undock-touch" label="Allow undocking on touch screens" description="Lets the Node editor and Explorer float as windows on a phone.">
			<Toggle id="mobile-undock" label="Allow undocking on touch screens" bind:checked={$mobileUndockAllowed} />
		</SettingRow>
	</Section>

	<Section variant="card" label="Lists & menus">
		<SettingRow id="row-advanced-mode" label="Show system objects in the object list" description="Adds a System filter for module content and the environment rig.">
			<Toggle id="advanced-mode" label="Show system objects in the object list" bind:checked={$advancedMode} />
		</SettingRow>
		<SettingRow id="row-env-in-list" label="Show the environment in the object list" description="Adds an Environment filter to the object list.">
			<Toggle id="env-in-list" label="Show the environment in the object list" bind:checked={$showEnvInList} />
		</SettingRow>
		<SettingRow id="row-object-search" label="Object search in the right-click menu" description="Find a scene object and fly the camera to it.">
			<Toggle id="setting-object-search" label="Object search in the right-click menu" bind:checked={$objectSearchEnabled} />
		</SettingRow>
	</Section>

	<Section variant="card" label="Viewport">
		<SettingRow id="row-perf-stats" label="Show FPS and draw calls" description="A corner counter (a strip in a headset). Draw calls turn amber past 120 and red past 150.">
			<Toggle id="show-perf-stats" label="Show FPS and draw calls" bind:checked={$perfStatsShown} />
		</SettingRow>
		{#if $perfReportsAvailable}
			<SettingRow id="row-perf-reports" label="Send performance reports" description="Every 10 s, sends frame times and draw calls — no account, no scene content — so slow devices get fixed." keywords="beacon telemetry profiler">
				<Toggle id="send-perf-reports" label="Send performance reports" bind:checked={$perfReportsOn} />
			</SettingRow>
		{/if}
		<SettingRow id="row-dock-viewport" label="Dock resizes the viewport" description="The 3D view ends where a docked panel begins, so nothing hides behind it.">
			<Toggle id="dock-pushes-viewport" label="Dock resizes the viewport" checked={$viewPrefs.dockPushesViewport} onchange={(on) => setViewPrefs({ dockPushesViewport: on })} />
		</SettingRow>
	</Section>
</div>

<style>
	.settings-page-body {
		display: contents;
	}
	.iface-themes {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.iface-theme-chip {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 2px 4px 2px 10px;
		border: 1px solid var(--border-strong);
		border-radius: 999px;
		font-size: var(--fs-desc);
		color: var(--text-2);
	}
	.iface-theme-x {
		width: 22px;
		height: 22px;
		border: 0;
		border-radius: 50%;
		background: transparent;
		color: var(--text-faint);
		cursor: pointer;
	}
	.iface-theme-x:hover {
		background: var(--surface-hover);
		color: var(--warn-text);
	}
	.iface-link {
		padding: 0;
		border: 0;
		background: transparent;
		font: inherit;
		color: var(--accent-text);
		text-decoration: underline;
		text-underline-offset: 2px;
		cursor: pointer;
	}
	.iface-status {
		color: var(--text-faint);
		font-style: italic;
	}
</style>

<script>
	// 92 (GC1 / GC2 / GC5 / GC8) — Configure Scene ▸ Game menus: the game's title screen, whether its pause
	// menu pauses, its three save slots and "Auto-admit while playing". Scene data (the play block's
	// `menus`): saved with the scene, replicated with the scene-settings singleton, exported with the game.
	// A LAZY chunk (the Inspector line awaits it). The agent's game_setup {title, pause, saves} writes the
	// same block.
	import UiButton from '../../ui/Button.svelte';
	import Segmented from '../../ui/Segmented.svelte';
	import InsToggle from '../inspector/InsToggle.svelte';
	import HudImagePicker from '../../hud/HudImagePicker.svelte';
	import { scenePhysicsState_ } from '$lib/scenePhysics';
	import { setGameMenus } from '$lib/gameMenusPlan.js';
	import { menusNewer, normalizeTitle } from '$lib/gameMenusCore.js';
	import { isViewer } from '$lib/objectPermissions';
	import { titleHintOnce } from '$lib/gameMenusHint.js';
	import { showToastById } from '../../../stores/appStore';
	import { requestPlay } from '$lib/playMode';

	const raw = $derived($scenePhysicsState_.play?.menus ?? null);
	const newer = $derived(menusNewer(raw));
	const disabled = $derived(isViewer() || newer);
	const title = $derived(normalizeTitle(raw?.title));
	const titleOn = $derived(!!title && title.on);
	// effective value: a game without a menus block keeps the 1.74 menu, which never paused
	const pauseOn = $derived(!!raw && raw?.pause?.on !== false);
	const savesOn = $derived(raw?.saves?.on === true);
	const autoAdmit = $derived(raw?.autoAdmit === true);

	const BACKGROUNDS = [
		{ value: 'scene', label: 'The scene', title: 'The game’s own scene behind the title, dimmed' },
		{ value: 'color', label: 'Colour', title: 'A plain colour' },
		{ value: 'image', label: 'Image', title: 'A picture from your library' }
	];
	const START_COLOR = '#0b0e14'; // tokens-ok: colour-picker starting value (author data)

	/** @param {any} patch */
	function setTitle(patch) {
		const next = { ...(raw?.title ?? {}), on: true, ...patch };
		for (const [k, v] of Object.entries(patch)) if (v === '' || v === null) delete next[k];
		setGameMenus({ title: next });
	}
</script>

<div id="scene-game-menus" class="flex flex-col gap-2" data-keywords="title screen start screen pause menu save slots continue load game auto admit late join">
	{#if newer}
		<p class="text-[length:var(--fs-desc)] text-ink-warn" id="game-menus-newer">These menus were made with a newer version of theprototype.app. Update to change them here.</p>
	{/if}

	<InsToggle id="game-menus-title" checked={titleOn} {disabled} onchange={(e) => {
		const on = e.currentTarget.checked;
		setGameMenus({ title: on ? { ...(raw?.title ?? {}), on: true } : null });
		// the release's first-use hint: once per device, the first time a title screen is turned on
		if (on) titleHintOnce({ show: showToastById, play: () => requestPlay({ flat: true }) });
	}}>
		Title screen
	</InsToggle>
	{#if titleOn}
		<div class="flex flex-col gap-2 rounded border border-border p-2">
			<label class="flex items-center gap-2 text-xs text-text-muted">
				<span class="w-20 shrink-0">Title</span>
				<input id="game-menus-title-text" class="ui-input min-w-0 flex-1 px-1 py-0.5 text-xs" placeholder="The scene's name" value={title?.title ?? ''} {disabled} onchange={(e) => setTitle({ title: e.currentTarget.value.trim() || null })} />
			</label>
			<label class="flex items-center gap-2 text-xs text-text-muted">
				<span class="w-20 shrink-0">Subtitle</span>
				<input id="game-menus-subtitle" class="ui-input min-w-0 flex-1 px-1 py-0.5 text-xs" placeholder="None" value={title?.subtitle ?? ''} {disabled} onchange={(e) => setTitle({ subtitle: e.currentTarget.value.trim() || null })} />
			</label>
			<Segmented id="game-menus-background" label="Background" full options={BACKGROUNDS} value={title?.background ?? 'scene'} {disabled} onchange={(v) => setTitle({ background: v })} />
			{#if title?.background === 'color'}
				<label class="flex items-center gap-2 text-xs text-text-muted">
					<span class="w-20 shrink-0">Colour</span>
					<input id="game-menus-color" type="color" value={title?.color ?? START_COLOR} {disabled} onchange={(e) => setTitle({ color: e.currentTarget.value })} />
				</label>
			{/if}
			{#if title?.background === 'image'}
				<div class="flex items-center gap-2 text-xs text-text-muted">
					<span class="w-20 shrink-0">Picture</span>
					<HudImagePicker hash={title?.image ?? ''} onpick={(h) => setTitle({ image: h || null })} />
				</div>
			{/if}
			<InsToggle id="game-menus-title-editor" checked={title?.editor !== false} {disabled} onchange={(e) => setTitle({ editor: e.currentTarget.checked })}>
				Show it when I press Play here
			</InsToggle>
			<p class="text-[length:var(--fs-desc)] text-text-muted">Play links and exported games always open on it.</p>
		</div>
	{/if}

	<InsToggle id="game-menus-pause" checked={pauseOn} {disabled} onchange={(e) => setGameMenus({ pause: { on: e.currentTarget.checked } })}>
		The menu pauses the game
	</InsToggle>
	<p class="text-[length:var(--fs-desc)] text-text-muted">Only when nobody else is playing — a shared game keeps running for the others.</p>

	<InsToggle id="game-menus-saves" checked={savesOn} {disabled} onchange={(e) => setGameMenus({ saves: e.currentTarget.checked ? { on: true } : null })}>
		Three save slots
	</InsToggle>
	{#if savesOn}
		<p class="text-[length:var(--fs-desc)] text-text-muted">Players save and load from the menu; a checkpoint saves into the slot in use. Saved on the player's device.</p>
	{/if}

	<InsToggle id="game-menus-auto-admit" checked={autoAdmit} {disabled} onchange={(e) => setGameMenus({ autoAdmit: e.currentTarget.checked })}>
		Auto-admit while playing
	</InsToggle>
	<p class="text-[length:var(--fs-desc)] text-text-muted">While you host and play, people who ask to join are let in. AI agents and blocked people still ask.</p>

	{#if raw && !newer}
		<UiButton id="game-menus-reset" size="sm" variant="ghost" {disabled} onclick={() => setGameMenus({ title: null, pause: null, saves: null, autoAdmit: false })}>Remove the game menus</UiButton>
	{/if}
</div>

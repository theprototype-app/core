<script>
	// 92-int (claude:9 boot ruling) — THE PAUSE MENU ON FIRST NEED. GameShellMenu (the pause menu, its
	// Settings / Accessibility / Controls / Save / Load pages, the corner Menu button, the in-game join
	// card and the title over editor Play) is not part of either boot: it is fetched the moment a game
	// can want it — Play or Interact entered, the menu or a title asked for — so the first Escape finds
	// it loaded. An editor that never plays never pays for it.
	import { isLocked, editorMode } from '../../stores/sceneStore';
	import { shellMenu } from '$lib/gameShell';
	import { titleScreen } from '$lib/gameMenus';
	import { retryImport } from '$lib/chunkReload';

	const load = () => import('./GameShellMenu.svelte').catch((e) => retryImport(() => import('./GameShellMenu.svelte'), e));
	/** @param {any} error */
	const failed = (error) => (console.error('game shell: the pause menu did not load', error), '');

	/** @type {ReturnType<typeof load> | null} */
	let menu = $state(null);
	$effect(() => {
		if (menu) return;
		if ($isLocked === true || $editorMode === 'interact' || $shellMenu.open || $titleScreen.open) menu = load();
	});
</script>

{#if menu}
	{#await menu then m}<m.default />{:catch error}{failed(error)}{/await}
{/if}

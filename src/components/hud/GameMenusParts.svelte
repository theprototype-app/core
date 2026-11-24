<script>
	// 92 (GC1 / GC5 / GC8) — THE LAZY HALF of the game menus, ONE chunk: the title screen, the save-slot
	// page, the join-requests page and the in-game join card. GameShellMenu / EmbedChrome import this file
	// alone (one preload list in the boot chunk, not four).
	import TitleScreen from './TitleScreen.svelte';
	import SaveSlotList from './SaveSlotList.svelte';
	import JoinRequestsList from './JoinRequestsList.svelte';
	import PlayJoinCard from './PlayJoinCard.svelte';

	/** @type {{part: 'title' | 'saves' | 'joins' | 'joincard', mode?: any, ondone?: () => void}} */
	let { part, mode = undefined, ondone = undefined } = $props();
</script>

{#if part === 'title'}
	<TitleScreen {mode} />
{:else if part === 'saves'}
	<SaveSlotList {mode} {ondone} />
{:else if part === 'joins'}
	<JoinRequestsList />
{:else}
	<PlayJoinCard />
{/if}

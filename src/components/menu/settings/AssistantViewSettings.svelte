<script module>
	/** 104 C2: what the settings search matches beyond the row names */
	export const keywords = ['claude', 'assistant', 'ai', 'show', 'move my view', 'camera', 'panels', 'open code', 'connector', 'privacy', 'permission', 'revoke', 'granted'];
</script>

<script>
	// 104 C2 — Settings ▸ Privacy ▸ Assistant on your screen: what `show` may do here without asking. Each
	// switch is the "Always" answer to the first-use question, stored on THIS DEVICE (safeStorage
	// `show:allow:<kind>`, read on every call, so turning one off asks again next time). All off by default.
	import Section from '../../ui/Section.svelte';
	import SettingRow from '../../ui/SettingRow.svelte';
	import Toggle from '../../ui/Toggle.svelte';
	import Button from '../../ui/Button.svelte';
	// 107 (permissions): the answers live in showGrants, so This time (this page) shows here too, with Revoke
	import { grantsVersion, alwaysAllowed, setAlways, showGrants, revokeGrant, revokeAllGrants } from '$lib/ai/showGrants.js';

	const ROWS = [
		{ kind: 'panel', label: 'Open and close my panels', desc: 'The Explorer, Objects, Inspector, Flow editor, Code, Timeline, Assets, Preview and Chat.' },
		{ kind: 'camera', label: 'Move my view', desc: 'Frame objects, go to a spot or look through a scene camera. Never in a VR headset, never while you drag or type.' },
		{ kind: 'code', label: 'Open code for me', desc: 'Open a file or a node’s code at a line and select it. It never changes the text.' }
	];
	const allow = $derived(($grantsVersion, Object.fromEntries(ROWS.map((r) => [r.kind, alwaysAllowed(r.kind)]))));
	/** the grants that last until this page reloads (This time), per app */
	const thisPage = $derived(($grantsVersion, showGrants().filter((g) => g.answer === 'this time')));
	const anyGranted = $derived(($grantsVersion, showGrants().some((g) => g.answer !== 'no')));
	/** @param {string} kind @param {boolean} on */
	function set(kind, on) {
		if (on) setAlways(kind, true);
		else revokeGrant(kind);
	}
</script>

<div class="contents" data-keywords={keywords.join(' ')}>
	<Section variant="card" label="Assistant on your screen" badge="This device">
		{#each ROWS as row (row.kind)}
			<SettingRow id={'row-show-allow-' + row.kind} label={row.label} keywords="assistant claude show permission">
				{#snippet desc()}{row.desc} When off, the assistant asks first (Always / This time / No).{/snippet}
				<Toggle id={'show-allow-' + row.kind} label={row.label} checked={allow[row.kind]} onchange={(/** @type {boolean} */ next) => set(row.kind, next)} />
			</SettingRow>
		{/each}
		{#each thisPage as g (g.kind + (g.app ?? ''))}
			<SettingRow id={'row-show-grant-' + g.kind} label={(g.app ?? 'The assistant') + ' may ' + g.what} keywords="assistant claude permission granted revoke">
				{#snippet desc()}Until this page reloads (you answered This time).{/snippet}
				<Button id={'show-grant-revoke-' + g.kind} size="sm" variant="outline" onclick={() => revokeGrant(g.kind, g.app)}>Revoke</Button>
			</SettingRow>
		{/each}
		{#if anyGranted}
			<SettingRow id="row-show-revoke-all" label="Take back everything" keywords="assistant claude permission revoke all">
				{#snippet desc()}The assistant asks again the next time it wants to change your screen.{/snippet}
				<Button id="show-grant-revoke-all" size="sm" variant="outline" onclick={() => revokeAllGrants()}>Revoke all</Button>
			</SettingRow>
		{/if}
	</Section>
</div>

<style>
	.contents {
		display: contents;
	}
</style>

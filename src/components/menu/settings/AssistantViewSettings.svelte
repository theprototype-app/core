<script module>
	/** 104 C2: what the settings search matches beyond the row names */
	export const keywords = ['claude', 'assistant', 'ai', 'show', 'move my view', 'camera', 'panels', 'select', 'open code', 'connector', 'privacy', 'permission', 'revoke', 'granted'];
</script>

<script>
	// 104 C2 + 107 — Settings ▸ Privacy ▸ Assistant on your screen: what `show` may do here without asking. Permissions
	// are kept per app (showGrants.js). The three switches are Claude's "Always" on THIS DEVICE (off asks again next
	// time); every other grant, any app's and any "This time", is a row of its own with Revoke. All off by default.
	import Section from '../../ui/Section.svelte';
	import SettingRow from '../../ui/SettingRow.svelte';
	import Toggle from '../../ui/Toggle.svelte';
	import Button from '../../ui/Button.svelte';
	// the grants module loads when this page is shown, not with the editor (this component is in a boot chunk)
	/** @type {typeof import('$lib/ai/showGrants.js') | null} */
	let G = $state(null);
	let version = $state(0);
	$effect(() => {
		let off = () => {};
		let gone = false;
		import('$lib/ai/showGrants.js').then((m) => {
			if (gone) return;
			G = m;
			off = m.grantsVersion.subscribe((v) => (version = v));
		});
		return () => {
			gone = true;
			off();
		};
	});

	/** the app the three switches stand for (showGrants.OLD_GRANTS_APP) */
	const APP = 'Claude';
	const ROWS = [
		{ kind: 'panel', label: 'Open and close my panels', desc: 'The Explorer, Objects, Inspector, Flow editor, Code, Timeline, Assets, Preview and Chat; show a file in the Explorer or a node in the Flow editor, and select objects (the view does not move).' },
		{ kind: 'camera', label: 'Move my view', desc: 'Frame objects, go to a spot or look through a scene camera. Never in a VR headset, never while you drag or type.' },
		{ kind: 'code', label: 'Open code for me', desc: 'Open a file or a node’s code at a line and select it. It never changes the text.' }
	];
	/** every grant, re-read whenever one changes (the version is the dependency) */
	const grants = $derived.by(() => {
		void version;
		const g = G;
		if (!g) return { claude: /** @type {Record<string, boolean>} */ ({}), list: /** @type {any[]} */ ([]) };
		return { claude: Object.fromEntries(ROWS.map((r) => [r.kind, g.alwaysAllowed(r.kind, APP)])), list: g.showGrants() };
	});
	const allow = $derived(grants.claude);
	/** every grant the switches do not show: another app's, and any "This time" */
	const others = $derived(grants.list.filter((g) => g.answer !== 'no' && !(g.answer === 'always' && g.app === APP)));
	const anyGranted = $derived(grants.list.some((g) => g.answer !== 'no'));
	/** an app name as an id part @param {string} app */
	const slug = (app) => String(app || 'assistant').toLowerCase().replace(/[^a-z0-9]+/g, '-');
	/** @param {string} kind @param {boolean} on */
	async function set(kind, on) {
		const g = G ?? (await import('$lib/ai/showGrants.js'));
		if (on) g.setAlways(kind, true, APP);
		else g.revokeGrant(kind, APP);
	}
</script>

<div class="contents" data-keywords={keywords.join(' ')}>
	<Section variant="card" label="Assistant on your screen" badge="This device">
		{#each ROWS as row (row.kind)}
			<SettingRow id={'row-show-allow-' + row.kind} label={row.label} keywords="assistant claude show permission">
				{#snippet desc()}{row.desc} On: Claude does this without asking. Off: it asks first (Always / This time / No). Each app is asked for itself.{/snippet}
				<Toggle id={'show-allow-' + row.kind} label={row.label} checked={!!allow[row.kind]} onchange={(/** @type {boolean} */ next) => set(row.kind, next)} />
			</SettingRow>
		{/each}
		{#each others as g (g.kind + '\n' + g.app + '\n' + g.answer)}
			<SettingRow id={'row-show-grant-' + g.kind + '-' + slug(g.app)} label={(g.app || 'The assistant') + ' may ' + g.what} keywords="assistant claude permission granted revoke">
				{#snippet desc()}{g.answer === 'always' ? 'Always, on this device.' : 'Until this page reloads (you answered This time).'}{/snippet}
				<Button id={'show-grant-revoke-' + g.kind + '-' + slug(g.app)} size="sm" variant="outline" onclick={() => G?.revokeGrant(g.kind, g.app)}>Revoke</Button>
			</SettingRow>
		{/each}
		{#if anyGranted}
			<SettingRow id="row-show-revoke-all" label="Take back everything" keywords="assistant claude permission revoke all">
				{#snippet desc()}Every app asks again the next time it wants to change your screen.{/snippet}
				<Button id="show-grant-revoke-all" size="sm" variant="outline" onclick={() => G?.revokeAllGrants()}>Revoke all</Button>
			</SettingRow>
		{/if}
	</Section>
</div>

<style>
	.contents {
		display: contents;
	}
</style>

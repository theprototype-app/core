<script>
	// 41b H14 — "Save options": every save setting in one place, opened by the burger's Save ▾ (Compact)
	// and its ⚙ (List). It replaced the cog's small export-settings popup (B3 / 21-H1 / 21-I5), whose
	// rows it keeps under the same ids: what to save (Project / Scene, plus GLTF / JSON once shown),
	// what a .tpscene and a .tp carry, and the two optional formats. The rows edit a DRAFT: the primary
	// "Save" remembers the options AND saves with them; Cancel (Esc, the close button) forgets the draft.
	// The width: ModalDialog's `width="sm"` loses to ui.css's !important 1200 px frame cap on desktop
	// (pre-existing, every sm/md ModalDialog measures 1200 px), so it asks for `desktopWidth` — 42 I13:
	// the inline `max-width … !important` it used before also beat the phone sheet's full width and left
	// a gap on the right of a folded phone.
	import ModalDialog from '../ui/ModalDialog.svelte';
	import Section from '../ui/Section.svelte';
	import SettingRow from '../ui/SettingRow.svelte';
	import Segmented from '../ui/Segmented.svelte';
	import Toggle from '../ui/Toggle.svelte';
	import Button from '../ui/Button.svelte';
	import { get } from 'svelte/store';
	import { saveOptions, saveOptionsOpen, setSaveOptions, visibleFormat, SAVE_FORMATS, EXPORT_PRESET_OPTIONS } from '$lib/saveOptions';
	import { save } from '$lib/fileHandler.svelte';

	/** @type {import('$lib/saveOptions').SaveOptions} */
	let draft = $state({ ...get(saveOptions) });
	// a fresh draft every time the dialog opens
	let wasOpen = false;
	$effect(() => {
		const open = $saveOptionsOpen;
		if (open && !wasOpen) draft = { ...get(saveOptions) };
		wasOpen = open;
	});

	const formats = $derived(
		SAVE_FORMATS.filter((f) => (f.value === 'gltf' ? draft.showGltf : f.value === 'json' ? draft.showJson : true)).map((f) => ({
			value: f.value,
			label: f.label,
			title: f.title
		}))
	);

	/** @param {Partial<import('$lib/saveOptions').SaveOptions>} patch */
	function edit(patch) {
		const next = { ...draft, ...patch };
		// a format switched off cannot stay picked
		next.format = visibleFormat(next.format, next.showJson, next.showGltf);
		draft = next;
	}

	function cancel() {
		saveOptionsOpen.set(false);
	}

	function saveNow() {
		const opts = setSaveOptions(draft);
		saveOptionsOpen.set(false);
		// 56 C13: a Project save with several libraries open asks which (Settings ▸ Save options)
		if (opts.format === 'tp') void import('$lib/saveProject').then((m) => m.saveProjectPressed('burger', () => save(opts.format)));
		else save(opts.format);
	}
</script>

<ModalDialog
	id="save-options-modal"
	title="Save options"
	bind:open={$saveOptionsOpen}
	width="sm"
	desktopWidth="min(520px, 94vw)"
	onkeydown={(/** @type {KeyboardEvent} */ e) => {
		if (e.key === 'Escape') cancel();
	}}
>
	<div class="so-body">
		<Section variant="card" label="Save as">
			<SettingRow id="row-save-format" label="Format" description="Project keeps everything (.tp); Scene is the open scene alone (.tpscene).">
				<Segmented id="save-format" label="Format" options={formats} value={draft.format} onchange={(v) => edit({ format: v })} />
			</SettingRow>
		</Section>
		<!-- 46 P3: the export presets (the last choice is remembered on this device) -->
		<Section variant="card" label="Scene and GLTF files are made for">
			<SettingRow id="row-export-preset" label="Optimize for" description="For Quest / web: KTX2-compressed textures at most 2048 px and an LOD chain (GLTF adds meshopt geometry) — much smaller, loads on a headset." wide>
				<Segmented id="export-preset" label="Optimize for" options={EXPORT_PRESET_OPTIONS} value={draft.exportPreset} onchange={(v) => edit({ exportPreset: /** @type {any} */ (v) })} />
			</SettingRow>
		</Section>
		<Section variant="card" label="A scene (.tpscene) includes">
			<SettingRow id="row-tpscene-assets" label="Assets" description="Audio, textures and configs the scene uses.">
				<Toggle id="tpscene-assets" label="Assets" checked={draft.tpAssets} onchange={(v) => edit({ tpAssets: v })} />
			</SettingRow>
			<SettingRow id="row-tpscene-packs" label="Imported packs">
				<Toggle id="tpscene-packs" label="Imported packs" checked={draft.tpPacks} onchange={(v) => edit({ tpPacks: v })} />
			</SettingRow>
			<SettingRow id="row-tpscene-flow" label="Flow graph" description="Nodes and edges.">
				<Toggle id="tpscene-flow" label="Flow graph" checked={draft.tpFlow} onchange={(v) => edit({ tpFlow: v })} />
			</SettingRow>
		</Section>
		<Section variant="card" label="A project (.tp) includes">
			<SettingRow id="row-tp-project-versions" label="Scene version history" description="Every kept version of every scene. Off exports each scene's current version only.">
				<Toggle id="tp-project-versions" label="Scene version history" checked={draft.tpProjectVersions} onchange={(v) => edit({ tpProjectVersions: v })} />
			</SettingRow>
		</Section>
		<Section variant="card" label="More formats">
			<SettingRow id="row-show-gltf" label="Offer GLTF" description="Exports the selection for other tools — not a way to keep your work.">
				<Toggle id="show-gltf-format" label="Offer GLTF" checked={draft.showGltf} onchange={(v) => edit({ showGltf: v })} />
			</SettingRow>
			<SettingRow id="row-show-json" label="Offer JSON" description="The scene as raw JSON.">
				<Toggle id="show-json-format" label="Offer JSON" checked={draft.showJson} onchange={(v) => edit({ showJson: v })} />
			</SettingRow>
		</Section>
	</div>
	{#snippet footer()}
		<Button id="save-options-cancel" variant="outline" onclick={cancel}>Cancel</Button>
		<Button id="save-options-save" variant="primary" onclick={saveNow}>Save</Button>
	{/snippet}
</ModalDialog>

<style>
	.so-body {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}
</style>

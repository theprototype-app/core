<script>
	// 72 LK1: Inspector ▸ Material ▸ Maps. One row per map slot, the strengths that belong to them, then
	// tiling / offset / rotation for the whole material. Own file so the Inspector carries one line for it.
	// Every write goes through materialMaps.js, which replicates it and makes it one undo step over the set.
	import UiButton from '../ui/Button.svelte';
	import PropRow from '../ui/PropRow.svelte';
	import SliderRow from '../ui/SliderRow.svelte';
	import { showToast } from '../../stores/appStore';
	import { MAP_SLOTS, NORMAL_STRENGTH_MAX } from '$lib/materialParamRules.js';
	import { hasAnyMap, mapSlotFilled, mapSlotThumb, normalStrengthOf, texTransformOf } from '$lib/materialMapTextures.js';
	import { removeObjectsMapSlot, setNormalStrength, setObjectsMapSet, setObjectsMapSlot, setTexTransform } from '$lib/materialMaps';
	import { applyExplorerImageToMapSlot } from '$lib/explorerDrop';
	import { setMaterialParam } from '$lib/materialsHandler';
	import { beginHistoryBatch, endHistoryBatch } from '$lib/history';
	import { withWireBatch, withWireBatchAsync } from '$lib/wireBatch';

	const ACCEPT = 'image/png, image/jpeg, image/webp, image/heic, image/heif, .heic, .heif';
	const EXPLORER_ITEM = 'application/x-explorer-item';
	const DEG = 180 / Math.PI;

	/** @type {{ material: any, targets: any[], matMixed: (read: (object: any) => any) => boolean, refresh: () => void }} */
	let { material, targets, matMixed, refresh } = $props();

	// `live` keeps one identity while its maps change. `material` is the Inspector's fresh snapshot, made on
	// every scene poke, so everything read off the live material below goes through it.
	const slots = $derived(
		MAP_SLOTS.filter((slot) => material?.ref && slot.key in material.ref).map((slot) => {
			const filled = mapSlotFilled(material.ref, slot.key);
			return { ...slot, filled, thumb: filled ? mapSlotThumb(material.ref, slot.key) : null };
		})
	);
	const uuids = $derived(targets.map((/** @type {any} */ object) => object.uuid));
	const transform = $derived(texTransformOf(material?.ref));
	const showTransform = $derived(hasAnyMap(material?.ref) || slots.some((slot) => slot.filled));
	const normalStrength = $derived(normalStrengthOf(material?.ref));
	const aoStrength = $derived(material?.ref?.aoMapIntensity ?? 1);
	const many = $derived(targets.length > 1);

	/** @type {string | null} */
	let dropKey = $state(null);

	/** @param {string} key */
	function pick(key) {
		document.getElementById('map-file-' + key)?.click();
	}

	/** @param {() => Promise<any>} write */
	async function run(write) {
		await withWireBatchAsync(write);
		refresh();
	}

	/** @param {string} key @param {File} file */
	const setFile = (key, file) => run(() => setObjectsMapSlot(uuids, key, file));

	/** @param {FileList | null} list */
	async function setFromFiles(list) {
		const files = [...(list ?? [])].map((file) => ({ file, name: file.name }));
		if (!files.length) return;
		const result = await withWireBatchAsync(() => setObjectsMapSet(uuids, files));
		refresh();
		if (result.unknown.length) showToast('Could not tell which map these are: ' + result.unknown.join(', ') + '. Set them on their own row.');
		else showToast(result.placed.length + (result.placed.length === 1 ? ' map set' : ' maps set'));
	}

	/** @param {DragEvent} event @param {string} key */
	async function drop(event, key) {
		dropKey = null;
		event.preventDefault();
		event.stopPropagation();
		const raw = event.dataTransfer?.getData(EXPLORER_ITEM);
		if (raw) {
			await run(() => applyExplorerImageToMapSlot(uuids, JSON.parse(raw), key));
			return;
		}
		const file = event.dataTransfer?.files?.[0];
		if (file) await setFile(key, file);
	}

	/** one write per object as ONE undo step and ONE wire batch @param {string} label @param {(uuid: string) => void} write */
	function fan(label, write) {
		if (uuids.length === 1) {
			write(uuids[0]);
		} else {
			beginHistoryBatch();
			try {
				withWireBatch(() => uuids.forEach(write));
			} finally {
				endHistoryBatch(`${label} (${uuids.length})`);
			}
		}
		refresh();
	}

	/** @param {any} patch */
	const patchTransform = (patch) => fan('Tiling', (uuid) => setTexTransform(uuid, patch));
	/** @param {number} index @param {number} value */
	const setTiling = (index, value) => patchTransform({ repeat: index === 0 ? [value, transform.repeat[1]] : [transform.repeat[0], value] });
	/** @param {number} index @param {number} value */
	const setOffset = (index, value) => patchTransform({ offset: index === 0 ? [value, transform.offset[1]] : [transform.offset[0], value] });
	/** @param {(t: any) => any} read */
	const transformMixed = (read) => matMixed((object) => read(texTransformOf(object.material)));
</script>

{#if slots.length}
	<div id="material-maps" class="flex flex-col gap-1">
		<p class="ui-section-label">Maps{many ? ` — applies to all ${targets.length}` : ''}</p>
		{#each slots as slot (slot.key)}
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				id={'map-slot-' + slot.key}
				class="map-row rounded-sm border border-dashed {dropKey === slot.key ? 'ins-drop-on' : 'border-transparent'}"
				title={slot.hint}
				ondragover={(event) => {
					if (event.dataTransfer?.types.includes(EXPLORER_ITEM) || event.dataTransfer?.types.includes('Files')) {
						event.preventDefault();
						event.stopPropagation();
						dropKey = slot.key;
					}
				}}
				ondragleave={() => (dropKey = null)}
				ondrop={(event) => drop(event, slot.key)}
			>
				<input
					type="file"
					id={'map-file-' + slot.key}
					accept={ACCEPT}
					style="display: none"
					onchange={(event) => {
						const file = event.currentTarget.files?.[0];
						if (file) setFile(slot.key, file);
						event.currentTarget.value = '';
					}}
				/>
				<span class="map-label text-xs text-text-muted">{slot.label}</span>
				{#if slot.filled}
					{#if slot.thumb}
						<button type="button" class="map-thumb" title={'Replace the ' + slot.label + ' map'} aria-label={'Replace the ' + slot.label + ' map'} onclick={() => pick(slot.key)}>
							<img src={slot.thumb} alt="" class="h-full w-full rounded-sm object-cover" />
						</button>
					{:else}
						<span class="text-[length:var(--fs-badge)] text-text-faint">From the model</span>
					{/if}
					<UiButton id={'map-remove-' + slot.key} size="sm" variant="outline" onclick={() => run(() => removeObjectsMapSlot(uuids, slot.key))}>Remove</UiButton>
				{:else}
					<UiButton id={'map-set-' + slot.key} size="sm" variant="outline" aria-label={'Set the ' + slot.label + ' map'} onclick={() => pick(slot.key)}>Set...</UiButton>
				{/if}
			</div>
			{#if slot.key === 'normalMap' && slot.filled}
				<SliderRow
					id="map-normal-strength"
					label="Normal strength"
					resetValue={1}
					min={0}
					max={NORMAL_STRENGTH_MAX}
					step={0.05}
					value={normalStrength}
					mixed={matMixed((object) => normalStrengthOf(object.material))}
					onchange={(value) => fan('Normal strength', (uuid) => setNormalStrength(uuid, value))}
				/>
			{/if}
			{#if slot.key === 'aoMap' && slot.filled}
				<SliderRow
					id="map-ao-strength"
					label="AO strength"
					resetValue={1}
					min={0}
					max={1}
					step={0.05}
					value={aoStrength}
					mixed={matMixed((object) => object.material.aoMapIntensity)}
					onchange={(value) => fan('AO strength', (uuid) => setMaterialParam(uuid, 'aoMapIntensity', value))}
				/>
			{/if}
		{/each}
		<input
			type="file"
			id="map-set-files"
			accept={ACCEPT}
			multiple
			style="display: none"
			onchange={(event) => {
				setFromFiles(event.currentTarget.files);
				event.currentTarget.value = '';
			}}
		/>
		<UiButton
			id="map-set-load"
			size="sm"
			variant="outline"
			title="Pick several images at once. Each goes to the slot its file name says: wood_normal.png, wood_rough.png, wood_color.png"
			onclick={() => document.getElementById('map-set-files')?.click()}
		>
			Load a set of maps...
		</UiButton>

		{#if showTransform}
			<div id="map-transform" class="flex flex-col gap-1">
				<p class="ui-section-label">Tiling</p>
				<PropRow id="map-tile-u" label="Tile U" value={transform.repeat[0]} step={0.1} snap={1} decimals={2} resetValue={1} ariaLabel="Tile U" mixed={transformMixed((t) => t.repeat[0])} onchange={(/** @type {number} */ v) => setTiling(0, v)} />
				<PropRow id="map-tile-v" label="Tile V" value={transform.repeat[1]} step={0.1} snap={1} decimals={2} resetValue={1} ariaLabel="Tile V" mixed={transformMixed((t) => t.repeat[1])} onchange={(/** @type {number} */ v) => setTiling(1, v)} />
				<PropRow id="map-offset-u" label="Offset U" value={transform.offset[0]} step={0.01} snap={0.1} decimals={3} resetValue={0} ariaLabel="Offset U" mixed={transformMixed((t) => t.offset[0])} onchange={(/** @type {number} */ v) => setOffset(0, v)} />
				<PropRow id="map-offset-v" label="Offset V" value={transform.offset[1]} step={0.01} snap={0.1} decimals={3} resetValue={0} ariaLabel="Offset V" mixed={transformMixed((t) => t.offset[1])} onchange={(/** @type {number} */ v) => setOffset(1, v)} />
				<PropRow id="map-rotation" label="Rotation °" value={transform.rotation * DEG} step={1} snap={15} decimals={1} resetValue={0} ariaLabel="Rotation in degrees" mixed={transformMixed((t) => t.rotation)} onchange={(/** @type {number} */ v) => patchTransform({ rotation: v / DEG })} />
			</div>
		{/if}
	</div>
{/if}

<style>
	.map-row {
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: 32px;
	}
	.map-label {
		width: 5rem;
		flex-shrink: 0;
	}
	.map-thumb {
		height: 28px;
		width: 28px;
		flex-shrink: 0;
		cursor: pointer;
		border-radius: var(--radius-sm, 2px);
		border: 1px solid var(--border-strong);
		background: transparent;
		padding: 0;
	}
</style>

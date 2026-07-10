<script>
	// Unified inspector (phase 64): one drawer serves every target — mesh, group,
	// light (from the selection) and the scene itself ($inspectorKind = 'scene').
	// Replication messages are byte-identical to the old three panels.
	import * as THREE from 'three';
	import { Drawer, Select, Checkbox, Button, Tooltip } from 'flowbite-svelte';
	import PanelHeader from '../ui/PanelHeader.svelte';
	import Section from '../ui/Section.svelte';
	import SliderRow from '../ui/SliderRow.svelte';
	import DragRow from '../ui/DragRow.svelte';
	import ColorPicker, { ChromeVariant } from 'svelte-awesome-color-picker';
	import CustomWrapper from '$lib/ColorWrapper.svelte';
	import { sineIn } from 'svelte/easing';
	import {
		setObjectTexture,
		removeObjectTexture,
		setMaterialParam,
		switchMaterialType,
		recordMaterialChange
	} from '$lib/materialsHandler';
	import { animatedObjects, setAnimationState } from '$lib/animatedImports';
	import { moveObjectToGroup } from '$lib/objectActions';
	import { showLightHelpers } from '$lib/lightHelpers';
	import { environment, ENVIRONMENT_PRESETS, setEnvironment } from '$lib/environment';
	import {
		globalScene,
		objectsGroup,
		selectedObject,
		backgroundColor,
		globalCamera
	} from '../../stores/sceneStore';
	import { peers, chatHidden, inspectorClose, inspectorKind } from '../../stores/appStore.js';

	const hexColor = /^#[0-9A-F]{6}$/i;
	const RAD_SNAP = Math.PI / 12; // Ctrl-snap rotations to 15°

	let transitionParamsRight = { x: 320, duration: 200, easing: sineIn };

	// drawer sits above the chat when the chat is open
	let drawerStyle = $state('');
	$effect(() => {
		drawerStyle =
			$chatHidden === ''
				? 'bottom: 350px; z-index: 48; border-bottom-left-radius: 0.5rem;'
				: 'bottom: 0px; z-index: 48';
	});

	const isLight = $derived($selectedObject?.type?.endsWith?.('Light') ?? false);
	const isGroup = $derived($selectedObject?.type === 'Group');
	const material = $derived(
		!isLight && !isGroup && $selectedObject?.material && !Array.isArray($selectedObject.material)
			? $selectedObject.material
			: null
	);

	let materials = [
		{ value: 'MeshBasicMaterial', name: 'Basic' },
		{ value: 'MeshStandardMaterial', name: 'Standard' },
		{ value: 'MeshPhongMaterial', name: 'Phong' },
		{ value: 'MeshToonMaterial', name: 'Toon' },
		{ value: 'ShadowMaterial', name: 'Shadow' }
	];

	// color swatches mirror the target when the selection changes
	/** @type {any} */
	let color = $state('#ffffff');
	/** @type {any} */
	let groundColor = $state('#ffffff');
	$effect(() => {
		const obj = $selectedObject;
		if (!obj) return;
		if (obj.material?.color && !Array.isArray(obj.material))
			color = '#' + obj.material.color.getHexString();
		else if (obj.color?.getHexString) color = '#' + obj.color.getHexString();
		if (obj.groundColor?.getHexString) groundColor = '#' + obj.groundColor.getHexString();
	});

	// one undo entry per color-drag gesture: remember where it started,
	// record 600ms after the last input
	/** @type {any} */
	let colorGestureStart = null;
	/** @type {any} */
	let colorGestureTimer;
	/** @param {string} uuid @param {any} hex */
	function trackColorGesture(uuid, hex) {
		if (colorGestureStart == null)
			colorGestureStart = '#' + $selectedObject.material.color.getHexString();
		clearTimeout(colorGestureTimer);
		colorGestureTimer = setTimeout(() => {
			recordMaterialChange(uuid, 'color', null, colorGestureStart, hex);
			colorGestureStart = null;
		}, 600);
	}

	// ---- replication (identical messages to the retired panels) -------------
	function sendMove() {
		const obj = $selectedObject;
		if (!obj?.uuid) return;
		$peers.send({
			type: 'move',
			uuid: obj.uuid,
			pos: obj.position.toArray(),
			rot: obj.rotation.toArray(),
			scale: obj.scale.toArray()
		});
	}

	/** @param {'position'|'rotation'|'scale'} field @param {'x'|'y'|'z'} axis @param {number} next */
	function setTransform(field, axis, next) {
		$selectedObject[field][axis] = next;
		selectedObject.update((v) => v); // refresh rows + object list
		sendMove();
	}

	/** lights resend their whole object — same as the old light panel */
	function sendLightUpdate() {
		$peers.send({ type: 'object', element: $selectedObject.toJSON(), override: true });
	}

	/** @param {string} parameter */
	function sendParam(parameter) {
		$peers.send({
			type: 'objectParameters',
			parameter,
			uuid: $selectedObject.uuid,
			[parameter]: $selectedObject[parameter]
		});
	}

	function sendName() {
		objectsGroup.update((value) => value); // refresh the object list
		$peers.send({ type: 'name', name: $selectedObject.name, uuid: $selectedObject.uuid });
	}

	// ---- move to group (shared by mesh and light targets) -------------------
	let groups = $state([{ value: 'none', name: 'None' }]);
	let rerenderSelectGroup = $state(false);
	function refreshGroups() {
		groups = $selectedObject.parent.children
			.map((/** @type {any} */ item) =>
				item.type === 'Group' ? { name: item.name, value: item.uuid } : null
			)
			.filter(Boolean);
		if ($selectedObject.parent.parent.parent !== null)
			groups.push({ name: 'Level Up', value: $selectedObject.parent.parent.uuid });
		groups = groups.filter((/** @type {any} */ item) => item.value !== $selectedObject.uuid);
	}

	/** total objects in a subtree (group summary) @param {any} obj @returns {number} */
	function countTree(obj) {
		return obj.children.reduce(
			(/** @type {number} */ sum, /** @type {any} */ child) => sum + 1 + countTree(child),
			0
		);
	}

	// ---- scene target (fog state is local, like the old scene panel) --------
	/** @type {any} */
	let fogColor = $state();
	/** @type {any} */
	let fogNear = $state(0);
	/** @type {any} */
	let fogFar = $state(50);
	function sendBackgroundColor() {
		$peers.send({ type: 'color', uuid: 'background', color: $backgroundColor });
	}
	function sendFogColor() {
		$peers.send({ type: 'color', uuid: 'fog', color: fogColor, near: fogNear, far: fogFar });
	}
	function applyFog() {
		$globalScene.fog = new THREE.Fog(fogColor ?? '#ffffff', fogNear, fogFar);
		sendFogColor();
	}
</script>

<Drawer
	style={drawerStyle}
	activateClickOutside={false}
	backdrop={false}
	placement="right"
	position="fixed"
	rightOffset="end-0 top-16"
	leftOffset="start-0 "
	topOffset="top-16"
	transitionType="fly"
	transitionParams={transitionParamsRight}
	bind:hidden={$inspectorClose}
	class="rounded-tl-lg"
	id="inspector"
>
	{#if $inspectorKind === 'scene'}
		<div id="drawer-label">
			<PanelHeader title="Scene" badge="Scene" onclose={() => inspectorClose.set(true)} />
		</div>

		<div class="flex flex-col gap-3">
			<Section label="Environment">
				<div id="environment-presets" class="flex flex-wrap gap-1">
					{#each Object.entries(ENVIRONMENT_PRESETS) as [key, preset]}
						<button
							class={'ui-chip ' +
								($environment.preset === key
									? 'bg-primary-600 text-white'
									: 'bg-gray-600 text-gray-200 hover:bg-gray-500')}
							onclick={() => setEnvironment(key)}
						>
							{preset.label}
						</button>
					{/each}
				</div>
				<SliderRow
					label="Exposure"
					min={0.4}
					max={2}
					step={0.05}
					value={$environment.exposure}
					onchange={(v) => setEnvironment($environment.preset, v)}
				/>
				<p class="text-[10px] italic text-gray-400">
					Presets replicate to peers; your own lights automatically dim the default rig.
				</p>
			</Section>

			<Section label="View">
				<Checkbox bind:checked={$showLightHelpers}>Show light helpers</Checkbox>
				<SliderRow
					label="Camera FOV"
					min={15}
					max={120}
					step={1}
					decimals={0}
					value={$globalCamera?.fov ?? 60}
					onchange={(v) => {
						$globalCamera.fov = v;
						$globalCamera.updateProjectionMatrix();
					}}
				/>
			</Section>

			<Section label="Background">
				<ColorPicker
					isAlpha={false}
					isTextInput={false}
					isDialog={false}
					components={{ ...ChromeVariant, wrapper: CustomWrapper }}
					isOpen={true}
					sliderDirection="horizontal"
					--picker-indicator-size="20px"
					--cp-bg-color="#1f2937"
					--cp-border-color="#353f4e"
					--picker-height="70px"
					--picker-width="50px"
					--slider-width="10px"
					bind:hex={$backgroundColor}
					on:input={(event) => {
						$backgroundColor = event.detail.hex;
						$globalScene.background = new THREE.Color($backgroundColor);
						sendBackgroundColor();
					}}
				/>
				<input
					type="text"
					class="ui-input w-full"
					value={$backgroundColor}
					onchange={(e) => {
						if (hexColor.test(e.currentTarget.value)) {
							$backgroundColor = e.currentTarget.value;
							$globalScene.background = new THREE.Color($backgroundColor);
							sendBackgroundColor();
						}
					}}
				/>
			</Section>

			<Section label="Fog">
				<ColorPicker
					isAlpha={false}
					isTextInput={false}
					isDialog={false}
					components={{ ...ChromeVariant, wrapper: CustomWrapper }}
					isOpen={true}
					sliderDirection="horizontal"
					--picker-indicator-size="20px"
					--cp-bg-color="#1f2937"
					--cp-border-color="#353f4e"
					--picker-height="70px"
					--picker-width="50px"
					--slider-width="10px"
					bind:hex={fogColor}
					on:input={(event) => {
						fogColor = event.detail.hex;
						applyFog();
					}}
				/>
				<input
					type="text"
					class="ui-input w-full"
					value={fogColor ?? ''}
					onchange={(e) => {
						if (hexColor.test(e.currentTarget.value)) {
							fogColor = e.currentTarget.value;
							applyFog();
						}
					}}
				/>
				<SliderRow label="Near" min={0} max={10} step={0.1} decimals={1} value={fogNear ?? 0}
					onchange={(v) => { fogNear = v; applyFog(); }} />
				<SliderRow label="Far" min={0} max={100} step={0.1} decimals={1} value={fogFar ?? 0}
					onchange={(v) => { fogFar = v; applyFog(); }} />
				<Button
					size="xs"
					color="alternative"
					on:click={() => {
						$globalScene.fog = null;
						fogNear = null;
						fogFar = null;
						sendFogColor();
					}}>Remove Fog</Button
				>
			</Section>
		</div>
	{:else if $selectedObject?.name !== undefined}
		<div id="drawer-label">
			<PanelHeader
				title="Properties"
				badge={$selectedObject.type}
				onclose={() => inspectorClose.set(true)}
			/>
		</div>

		<div class="flex flex-col gap-3">
			<div class="flex flex-col gap-1">
				<input
					id="name"
					type="text"
					class="ui-input w-full"
					value={$selectedObject.name}
					onchange={(e) => {
						$selectedObject.name = e.currentTarget.value;
						sendName();
					}}
				/>
				<Tooltip placement="top" arrow={false} triggeredBy="#name">Name</Tooltip>
				<p id="uuid" class="truncate px-1 text-[10px] text-gray-500" title={$selectedObject.uuid}>
					{$selectedObject.uuid}
				</p>
				<div onclick={refreshGroups} role="presentation">
					{#key rerenderSelectGroup}
						<Select
							id="select-group"
							underline
							items={groups}
							placeholder="Move to group"
							on:change={(/** @type {any} */ event) => {
								const selected = groups.find((item) => item.value === event.srcElement.value);
								moveObjectToGroup(
									$selectedObject.uuid,
									selected?.name === 'Level Up' ? 'up' : event.srcElement.value
								);
								objectsGroup.update((v) => v);
								rerenderSelectGroup = !rerenderSelectGroup;
							}}
						/>
					{/key}
				</div>
			</div>

			{#if $animatedObjects[$selectedObject.uuid]}
				{@const anim = $animatedObjects[$selectedObject.uuid]}
				<Section label="Animation">
					<div id="animation-controls">
						<Select
							underline
							class="mb-1"
							value={anim.clip}
							items={anim.clips.map((clip) => ({ value: clip, name: clip }))}
							on:change={(/** @type {any} */ e) =>
								setAnimationState($selectedObject.uuid, { clip: e.srcElement.value })}
						/>
						<div class="flex items-center gap-2">
							<button
								class="rounded bg-primary-700 px-2 py-0.5 text-sm text-white"
								onclick={() => setAnimationState($selectedObject.uuid, { playing: !anim.playing })}
							>
								{anim.playing ? '⏸ Pause' : '▶ Play'}
							</button>
							<span class="text-xs text-gray-400">speed {anim.speed.toFixed(1)}×</span>
							<input
								type="range"
								class="flex-1 accent-primary-600"
								min="0.1"
								max="3"
								step="0.1"
								value={anim.speed}
								oninput={(e) => setAnimationState($selectedObject.uuid, { speed: +e.currentTarget.value })}
							/>
						</div>
						<p class="pt-1 text-[10px] italic text-gray-400">
							Clips run on the synced clock — peers see the same pose.
						</p>
					</div>
				</Section>
			{/if}

			<Section label="Transform">
				<div class="grid grid-cols-[3.2rem_1fr] items-center gap-1">
					<span class="text-[11px] text-gray-400">Position</span>
					<div id="inspector-position" class="grid grid-cols-3 gap-1">
						<DragRow label="X" accent="text-red-400" step={0.02} value={$selectedObject.position.x}
							onchange={(v) => setTransform('position', 'x', v)} />
						<DragRow label="Y" accent="text-green-400" step={0.02} value={$selectedObject.position.y}
							onchange={(v) => setTransform('position', 'y', v)} />
						<DragRow label="Z" accent="text-blue-400" step={0.02} value={$selectedObject.position.z}
							onchange={(v) => setTransform('position', 'z', v)} />
					</div>
					{#if !isLight}
						<span class="text-[11px] text-gray-400">Rotation</span>
						<div id="inspector-rotation" class="grid grid-cols-3 gap-1">
							<DragRow label="X" accent="text-red-400" step={0.01} snap={RAD_SNAP} value={$selectedObject.rotation.x}
								onchange={(v) => setTransform('rotation', 'x', v)} />
							<DragRow label="Y" accent="text-green-400" step={0.01} snap={RAD_SNAP} value={$selectedObject.rotation.y}
								onchange={(v) => setTransform('rotation', 'y', v)} />
							<DragRow label="Z" accent="text-blue-400" step={0.01} snap={RAD_SNAP} value={$selectedObject.rotation.z}
								onchange={(v) => setTransform('rotation', 'z', v)} />
						</div>
						<span class="text-[11px] text-gray-400">Scale</span>
						<div id="inspector-scale" class="grid grid-cols-3 gap-1">
							<DragRow label="X" accent="text-red-400" step={0.01} snap={0.1} value={$selectedObject.scale.x}
								onchange={(v) => setTransform('scale', 'x', v)} />
							<DragRow label="Y" accent="text-green-400" step={0.01} snap={0.1} value={$selectedObject.scale.y}
								onchange={(v) => setTransform('scale', 'y', v)} />
							<DragRow label="Z" accent="text-blue-400" step={0.01} snap={0.1} value={$selectedObject.scale.z}
								onchange={(v) => setTransform('scale', 'z', v)} />
						</div>
					{/if}
				</div>
				<p class="text-[10px] text-gray-500">Drag to scrub — Shift fine, Ctrl snap, click to type.</p>
			</Section>

			{#if isGroup}
				<Section label="Group">
					<p class="px-1 text-xs text-gray-400">
						{$selectedObject.children.length} direct child{$selectedObject.children.length === 1 ? '' : 'ren'},
						{countTree($selectedObject)} object{countTree($selectedObject) === 1 ? '' : 's'} in total.
					</p>
				</Section>
			{/if}

			{#if isLight}
				<Section label="Light">
					<ColorPicker
						isAlpha={false}
						isTextInput={false}
						isDialog={false}
						components={{ ...ChromeVariant, wrapper: CustomWrapper }}
						isOpen={true}
						sliderDirection="horizontal"
						--picker-indicator-size="20px"
						--cp-bg-color="#1f2937"
						--cp-border-color="#353f4e"
						--picker-height="70px"
						--picker-width="50px"
						--slider-width="10px"
						bind:hex={color}
						on:input={(event) => {
							$selectedObject.color.set(event.detail.hex);
							color = event.detail.hex;
							sendLightUpdate();
						}}
					/>
					<input
						type="text"
						class="ui-input w-full"
						value={color}
						oninput={(e) => {
							if (hexColor.test(e.currentTarget.value)) {
								color = e.currentTarget.value;
								$selectedObject.color.set(color);
								sendLightUpdate();
							}
						}}
					/>
					{#if $selectedObject.type === 'HemisphereLight'}
						<p class="ui-section-label">Ground color</p>
						<ColorPicker
							isAlpha={false}
							isTextInput={false}
							isDialog={false}
							components={{ ...ChromeVariant, wrapper: CustomWrapper }}
							isOpen={true}
							sliderDirection="horizontal"
							--picker-indicator-size="20px"
							--cp-bg-color="#1f2937"
							--cp-border-color="#353f4e"
							--picker-height="70px"
							--picker-width="50px"
							--slider-width="10px"
							bind:hex={groundColor}
							on:input={(event) => {
								$selectedObject.groundColor.set(event.detail.hex);
								groundColor = event.detail.hex;
								sendLightUpdate();
							}}
						/>
					{/if}
					<div class="grid grid-cols-[3.2rem_1fr] items-center gap-1">
						<span class="text-[11px] text-gray-400">Intensity</span>
						<div id="inspector-intensity">
							<DragRow label="I" accent="text-yellow-300" step={0.02} min={0} snap={0.5}
								value={$selectedObject.intensity}
								onchange={(v) => {
									$selectedObject.intensity = v;
									selectedObject.update((s) => s);
									sendLightUpdate();
								}} />
						</div>
					</div>
					{#if $selectedObject.type === 'DirectionalLight'}
						<Checkbox bind:checked={$selectedObject.castShadow} onchange={() => sendLightUpdate()}>
							Cast Shadow
						</Checkbox>
						<SliderRow label="Shadow" min={0} max={5} step={0.1} decimals={1}
							value={$selectedObject.shadow.intensity}
							onchange={(v) => {
								$selectedObject.shadow.intensity = v;
								sendLightUpdate();
							}} />
					{/if}
					<Checkbox bind:checked={$selectedObject.visible} onchange={() => sendLightUpdate()}>
						Visible
					</Checkbox>
				</Section>
			{/if}

			{#if material}
				<Section label="Material">
					<Checkbox bind:checked={$selectedObject.visible} onchange={() => sendParam('visible')}>
						Visible
					</Checkbox>
					<Select
						id="select-material"
						underline
						items={materials}
						value={material.type}
						on:change={(/** @type {any} */ event) => {
							// switches type but keeps color/texture/opacity, locally and on peers
							switchMaterialType($selectedObject.uuid, event.srcElement.value);
							selectedObject.update((s) => s);
						}}
					/>

					{#if material.color && material.type !== 'MeshNormalMaterial'}
						<ColorPicker
							isAlpha={false}
							isTextInput={false}
							isDialog={false}
							components={{ ...ChromeVariant, wrapper: CustomWrapper }}
							isOpen={true}
							sliderDirection="horizontal"
							--picker-indicator-size="20px"
							--cp-bg-color="#1f2937"
							--cp-border-color="#353f4e"
							--picker-height="70px"
							--picker-width="50px"
							--slider-width="10px"
							bind:hex={color}
							on:input={(event) => {
								trackColorGesture($selectedObject.uuid, event.detail.hex);
								$selectedObject.material.color.set(event.detail.hex);
								$peers.send({ type: 'color', uuid: $selectedObject.uuid, color: event.detail.hex });
							}}
						/>
						<input
							type="text"
							class="ui-input w-full"
							value={color}
							onchange={(e) => {
								if (hexColor.test(e.currentTarget.value)) {
									color = e.currentTarget.value;
									$selectedObject.material.color.set(color);
									$peers.send({ type: 'color', uuid: $selectedObject.uuid, color });
								}
							}}
						/>
					{/if}

					<!-- materials supporting textures initialize map to null; ShadowMaterial has no map at all -->
					{#if typeof material.map !== 'undefined'}
						<p class="ui-section-label">Texture</p>
						<input
							type="file"
							id="texture-file"
							accept="image/png, image/jpeg, image/webp"
							style="display: none"
							onchange={(e) => {
								const file = e.currentTarget.files?.[0];
								if (file)
									setObjectTexture($selectedObject.uuid, file).then(() =>
										selectedObject.update((s) => s)
									);
								e.currentTarget.value = '';
							}}
						/>
						<div class="flex items-center gap-3">
							{#if material.userData?.mapDataUrl}
								<img
									src={material.userData.mapDataUrl}
									alt="texture"
									class="h-10 w-10 cursor-pointer rounded border border-gray-500 object-cover"
									role="presentation"
									onclick={() => document.getElementById('texture-file')?.click()}
								/>
								<Button
									size="xs"
									color="alternative"
									onclick={() => {
										removeObjectTexture($selectedObject.uuid);
										selectedObject.update((s) => s);
									}}>Remove</Button
								>
							{:else}
								<Button
									size="xs"
									color="alternative"
									onclick={() => document.getElementById('texture-file')?.click()}
								>
									Set texture...
								</Button>
							{/if}
						</div>
					{/if}

					{#if material.type === 'MeshStandardMaterial'}
						<SliderRow label="Roughness" min={0} max={1} step={0.05} value={material.roughness}
							onchange={(v) => setMaterialParam($selectedObject.uuid, 'roughness', v)} />
						<SliderRow label="Metalness" min={0} max={1} step={0.05} value={material.metalness}
							onchange={(v) => setMaterialParam($selectedObject.uuid, 'metalness', v)} />
					{/if}
					{#if material.type === 'MeshPhongMaterial'}
						<SliderRow label="Shininess" min={0} max={100} step={1} decimals={0} value={material.shininess}
							onchange={(v) => setMaterialParam($selectedObject.uuid, 'shininess', v)} />
					{/if}
					{#if typeof material.opacity !== 'undefined' && material.type !== 'ShadowMaterial'}
						<SliderRow label="Opacity" min={0} max={1} step={0.05} value={material.opacity}
							onchange={(v) => {
								setMaterialParam($selectedObject.uuid, 'transparent', v < 1);
								setMaterialParam($selectedObject.uuid, 'opacity', v);
							}} />
					{/if}
					{#if typeof material.wireframe !== 'undefined'}
						<Checkbox
							checked={material.wireframe}
							onchange={(/** @type {any} */ e) =>
								setMaterialParam($selectedObject.uuid, 'wireframe', e.target.checked)}
						>
							Wireframe
						</Checkbox>
					{/if}

					<p class="ui-section-label">Shadow</p>
					<div class="flex gap-4 px-1">
						<Checkbox bind:checked={$selectedObject.castShadow} onchange={() => sendParam('castShadow')}>
							Cast
						</Checkbox>
						<Checkbox
							bind:checked={$selectedObject.receiveShadow}
							onchange={() => sendParam('receiveShadow')}
						>
							Receive
						</Checkbox>
					</div>
				</Section>
			{/if}
		</div>
	{/if}
</Drawer>

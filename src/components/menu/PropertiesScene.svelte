<script>
	import * as THREE from 'three';
	import { Drawer, Button, CloseButton, NumberInput, Input, Range, Checkbox } from 'flowbite-svelte';
	import { globalScene, objectsGroup, TControls, selectedObject, backgroundColor, globalCamera } from '../../stores/sceneStore';
	import { peers, chatHidden, scenePropertiesClose } from '../../stores/appStore.js';
	import { showLightHelpers } from '$lib/lightHelpers';
	import ColorPicker, { ChromeVariant } from 'svelte-awesome-color-picker';
	import CustomWrapper from '$lib/ColorWrapper.svelte';
	import { sineIn } from 'svelte/easing';

    const hexColor = /^#[0-9A-F]{6}$/i;
	let fogColor = $state();
	let near = $state(0);
	let far = $state(50);

    let transitionParamsRight = {
		x: 320,
		duration: 200,
		easing: sineIn
	};

	let st = $state(0);

	// Drawer show full screen
	let drawerStyle = $state();

	$effect(() => {
		if ($chatHidden === '') {
            drawerStyle="bottom: 350px; z-index: 48; border-bottom-left-radius: 0.5rem;"
		} else {
			drawerStyle = 'bottom: 0px; z-index: 48';
		}
	});

    function sendBackgroundColor() {
        $peers.send({
				type: 'color',
				uuid: 'background',
				color: $backgroundColor
			});
    }
    function sendFogColor() {
        $peers.send({
				type: 'color',
				uuid: 'fog',
				color: fogColor,
                near: near,
                far: far
			});
    }
</script>

<Drawer 
	style={drawerStyle}
	activateClickOutside={false}
	backdrop={false}
	placement="right"
	height="full"
	position="fixed"
	rightOffset="end-0 top-16"
	leftOffset="start-0 "
	topOffset="top-16"
	transitionType="fly"
	transitionParams={transitionParamsRight}
	bind:hidden={$scenePropertiesClose}
    class="rounded-tl-lg"
	id="sidebar6"
>
	<div class="flex items-center">
		<h5
			id="drawer-label"
			class="mb-4 inline-flex items-center text-base font-semibold text-gray-500 dark:text-gray-400"
		>
			Scene Settings
		</h5>
		<CloseButton
			on:click={() => {
				scenePropertiesClose.set(true);
				st = 0;
			}}
			class="mb-4 dark:text-white"
		/>
	</div>

	<p class="mb-4 text-white dark:text-slate-200">
		<Checkbox bind:checked={$showLightHelpers}>Show light helpers</Checkbox>
	</p>

	<p class="text-white dark:text-slate-200">Camera Field of View:</p>
	<Range id="near" step="1" min="15" max="120" 
		bind:value={$globalCamera.fov}
		oninput={() => {
			$globalCamera.fov = parseFloat($globalCamera.fov);
			$globalCamera.updateProjectionMatrix();
		}}
	/>
	<br />
	<br />
	<p class="text-white dark:text-slate-200">Background Color:</p>
	<br />
	<ColorPicker
		label="test"
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
		bind:value={$backgroundColor}
		on:input={(event) => {
			$globalScene.background = new THREE.Color($backgroundColor);
			$backgroundColor = event.detail.hex;
            sendBackgroundColor();
		}}
	/>
    <Input
    type="text"
    bind:value={$backgroundColor}
    onchange={() => {
        $globalScene.fog = new THREE.Fog($backgroundColor, near, far);
        sendBackgroundColor();
    }}
    />
    <br />
	<p class="text-white dark:text-slate-200">Fog Color:</p>
	<br />
	<ColorPicker
		label="test"
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
		bind:value={fogColor}
		on:input={(event) => {
			$globalScene.fog = new THREE.Fog(event.detail.hex, near, far);
			fogColor = event.detail.hex;
            sendFogColor();
		}}
	/>
	<Input
		type="text"
		bind:value={fogColor}
		oninput={() => {
			if (hexColor.test(fogColor)) {
				$globalScene.fog = new THREE.Fog(fogColor, near, far);
				sendFogColor();
			}
		}}
	/>

	<div class="flex items-center space-x-2 p-1">
		<span class="w-2/3 truncate pr-2 text-right">
			<Range id="near" step="0.1" min="0" max="10" bind:value={near}
				oninput={() => {
					$globalScene.fog = new THREE.Fog(fogColor, near, far);
					sendFogColor();
				}}
			/>
		</span>
		<span class="w-1/3">
			<NumberInput
				bind:value={near}
				oninput={() => {
					$globalScene.fog = new THREE.Fog(fogColor, near, far);
					sendFogColor();
				}}
			/>
		</span>
	</div>
	<div class="flex items-center space-x-2 p-1">
		<span class="w-2/3 truncate pr-2 text-right">
			<Range id="far" step="0.1" min="0" max="100" bind:value={far}
				oninput={() => {
					$globalScene.fog = new THREE.Fog(fogColor, near, far);
					sendFogColor();
				}}
			/>
		</span>
		<span class="w-1/3">
			<NumberInput
				bind:value={far}
				oninput={() => {
					$globalScene.fog = new THREE.Fog(fogColor, near, far);
					sendFogColor();
				}}
			/>
		</span>
	</div>

    <Button
    on:click={() => {
        $globalScene.fog = null;
        near = null; far = null;
        sendFogColor();
    }}>Remove Fog</Button
>
</Drawer>

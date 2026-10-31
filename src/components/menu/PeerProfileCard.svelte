<script lang="ts">
	// Roadmap 55 A9 — the peer menu's View profile / View character card. LOCAL: it reads what
	// this machine already knows about the person (the roster row, the handshake's app version
	// and device, the live connection quality, how they came in) and draws their avatar on a
	// small turntable. Nothing is asked of the other peer.
	import * as THREE from 'three';
	import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
	import { onDestroy } from 'svelte';
	import ModalDialog from '../ui/ModalDialog.svelte';
	import { userdata, showToast } from '../../stores/appStore.js';
	import { globalScene, peerHands } from '../../stores/sceneStore.js';
	import { peerQuality } from '$lib/networkQuality';
	import { peerFacts } from '$lib/peerFacts';
	import { sessionHost } from '$lib/connectionState';
	import { rolesInfo } from '$lib/cloudHooks';
	import { resolveAvatar } from '$lib/avatarModel';

	let {
		peerId,
		focus = 'profile',
		joinedVia = '',
		onclose
	}: { peerId: string; focus?: 'profile' | 'character'; joinedVia?: string; onclose: () => void } = $props();

	let open = $state(true);
	$effect(() => {
		if (!open) onclose();
	});

	const row = $derived(($userdata as any[]).find((u) => u[0] === peerId) ?? null);
	const name = $derived(row?.[1] || String(peerId).slice(0, 6).toUpperCase());
	const look = $derived(resolveAvatar(row?.[5]));
	const facts = $derived($peerFacts[peerId] ?? {});
	const inVR = $derived(!!$peerHands[peerId]?.active);
	const device = $derived(inVR ? 'VR headset' : facts.device === 'phone' ? 'Phone or tablet' : facts.device === 'vr' ? 'VR headset' : facts.device === 'desktop' ? 'Desktop' : '');
	const q = $derived($peerQuality[peerId]);
	const quality = $derived(
		q ? (q.level === 'good' ? 'Good' : q.level === 'ok' ? 'Fair' : q.level === 'bad' ? 'Poor' : 'Measuring…') + (q.rtt != null ? ` · ${Math.round(q.rtt)} ms` : '') + (q.relayed ? ' · relayed' : '') : ''
	);
	const joined = $derived(
		$sessionHost === peerId
			? 'They host this session'
			: joinedVia === 'invite'
				? 'By an invite link'
				: joinedVia === 'guest'
					? 'As a guest (joined automatically)'
					: joinedVia === 'approval'
						? 'Approved by the host'
						: ''
	);
	const role = $derived($rolesInfo ? $rolesInfo.roleOf(peerId) : '');
	const kind = $derived(row?.[6]?.kind === 'agent' ? 'AI agent' : '');

	function copyId() {
		try {
			void navigator.clipboard?.writeText(peerId);
			showToast('Peer id copied');
		} catch {
			showToast(peerId);
		}
	}

	// --- the turntable: a CLONE of their avatar as it stands in our scene, on its own small
	// renderer (one context, disposed with the card). No clone (not drawn here: another scene,
	// hidden, not arrived) = their picture instead.
	let hasTurntable = $state(false);
	let renderer: THREE.WebGLRenderer | null = null;
	let raf = 0;
	function turntable(canvas: HTMLCanvasElement) {
		const source = ($globalScene as any)?.getObjectByName?.(peerId);
		if (!source) return;
		let model: THREE.Object3D;
		try {
			model = cloneSkinned(source);
		} catch {
			return;
		}
		model.position.set(0, 0, 0);
		model.rotation.set(0, 0, 0);
		model.traverse((o: any) => {
			// the nameplate faces the viewer's camera and the speaking ring is a status: not the character
			if (/-label$|-speaking$/.test(o.name)) o.visible = false;
		});
		const scene = new THREE.Scene();
		scene.add(new THREE.HemisphereLight(0xffffff, 0x444466, 2.2));
		const sun = new THREE.DirectionalLight(0xffffff, 1.6);
		sun.position.set(2, 4, 3);
		scene.add(sun);
		scene.add(model);
		const box = new THREE.Box3().setFromObject(model);
		if (box.isEmpty() || !Number.isFinite(box.min.x)) return;
		const centre = box.getCenter(new THREE.Vector3());
		const size = box.getSize(new THREE.Vector3());
		model.position.sub(centre);
		const h = Math.max(size.y, size.x, size.z, 0.5);
		const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
		camera.position.set(0, h * 0.15, h * 2.1);
		camera.lookAt(0, 0, 0);
		try {
			renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
		} catch {
			return;
		}
		renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
		renderer.setSize(canvas.clientWidth || 200, canvas.clientHeight || 200, false);
		renderer.outputColorSpace = THREE.SRGBColorSpace;
		hasTurntable = true;
		const pivot = new THREE.Group();
		scene.remove(model);
		pivot.add(model);
		scene.add(pivot);
		const loop = (t: number) => {
			pivot.rotation.y = (t / 4000) * Math.PI * 2;
			renderer?.render(scene, camera);
			raf = requestAnimationFrame(loop);
		};
		raf = requestAnimationFrame(loop);
		return {
			destroy() {
				cancelAnimationFrame(raf);
				renderer?.dispose();
				renderer?.forceContextLoss();
				renderer = null;
			}
		};
	}
	onDestroy(() => cancelAnimationFrame(raf));
</script>

<ModalDialog bind:open title={focus === 'character' ? name + '’s character' : name} width="sm" outsideclose onkeydown={(e: KeyboardEvent) => { if (e.key === 'Escape') open = false; }}>
	<div id="peer-profile-card" class="ppc" data-peer-id={peerId} data-focus={focus}>
		<div class="ppc-stage" class:ppc-stage-big={focus === 'character'}>
			<canvas class="ppc-turntable" class:ppc-hidden={!hasTurntable} use:turntable aria-label={name + '’s character, turning'}></canvas>
			{#if !hasTurntable}
				{#if row?.[2]}
					<img class="ppc-picture" src={row[2]} alt="" />
				{:else}
					<div class="ppc-picture ppc-initial" aria-hidden="true">{name.slice(0, 1)}</div>
				{/if}
			{/if}
		</div>
		<dl class="ppc-facts">
			<dt>Name</dt><dd>{name}{#if kind}<span class="ppc-badge">{kind}</span>{/if}</dd>
			<dt>Peer id</dt>
			<dd><code>{peerId}</code> <button type="button" class="ppc-copy" onclick={copyId}>Copy</button></dd>
			{#if role}<dt>Role</dt><dd class="ppc-cap">{role}</dd>{/if}
			{#if device}<dt>Device</dt><dd>{device}</dd>{/if}
			{#if facts.appVersion}<dt>App version</dt><dd>{facts.appVersion}</dd>{/if}
			{#if quality}<dt>Connection</dt><dd>{quality}</dd>{/if}
			{#if joined}<dt>Joined</dt><dd>{joined}</dd>{/if}
			<dt>Character</dt>
			<dd class="ppc-cap">{look.character === 'auto' ? 'Picked for them' : look.character}{#if look.outfit} · <span class="ppc-swatch" style="background: {look.outfit}"></span>{/if}</dd>
		</dl>
	</div>
</ModalDialog>

<style>
	.ppc { display: flex; flex-direction: column; gap: 12px; padding: 4px 2px; }
	.ppc-stage { position: relative; height: 180px; display: flex; align-items: center; justify-content: center; border-radius: 10px; background: var(--surface-2); }
	.ppc-stage-big { height: 260px; }
	.ppc-turntable { position: absolute; inset: 0; width: 100%; height: 100%; }
	.ppc-hidden { visibility: hidden; }
	.ppc-picture { width: 96px; height: 96px; border-radius: 50%; object-fit: cover; }
	.ppc-initial { display: flex; align-items: center; justify-content: center; background: var(--surface-active); color: var(--text-2); font-size: 40px; }
	.ppc-facts { display: grid; grid-template-columns: auto 1fr; gap: 6px 14px; margin: 0; font-size: 13px; }
	.ppc-facts dt { color: var(--text-muted); }
	.ppc-facts dd { margin: 0; color: var(--text); min-width: 0; overflow-wrap: anywhere; }
	.ppc-cap { text-transform: capitalize; }
	.ppc-badge { margin-left: 6px; padding: 0 6px; border-radius: 999px; background: var(--accent-soft); color: var(--text); font-size: 11px; }
	.ppc-copy { margin-left: 6px; padding: 0 6px; border-radius: 6px; border: 1px solid var(--border); background: transparent; color: var(--text); font-size: 11px; cursor: pointer; }
	.ppc-copy:hover { background: var(--surface-hover); }
	.ppc-swatch { display: inline-block; width: 12px; height: 12px; border-radius: 3px; vertical-align: middle; border: 1px solid var(--border); }
</style>

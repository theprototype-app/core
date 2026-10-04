// Phase 74: VR radial menu v2 — pure sector-hit math, the entry registry with
// the confirmed 8-sector base ring, ring navigation through the action
// dispatcher, the rendered radial structure (sector meshes + context hub) and
// object-ring actions. On-device feel (haptics, damped follow, hold mode) is
// the user's manual check.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// --- pure math (99 geometry: ring 0.028-0.105, hub 0.024) ---
	const math = await A.page.evaluate(() => {
		const m = window.__stores.vrRadialMenu;
		const THREE = window.__stores.THREE;
		// anchored pose: offset rides the controller rotation, tilt composes
		const pos = new THREE.Vector3(1, 1.5, -2);
		const quat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
		const pose = m.menuPoseFromController(THREE, pos, quat);
		return {
			top: m.sectorFromPoint(0, 0.065, 8),
			right: m.sectorFromPoint(0.065, 0, 8),
			bottom: m.sectorFromPoint(0, -0.065, 8),
			diag: m.sectorFromPoint(0.045, 0.045, 8),
			hub: m.sectorFromPoint(0.008, 0.008, 8),
			outside: m.sectorFromPoint(0.2, 0, 8),
			stickUp: m.sectorFromStick(0, -1, 8),
			stickRight: m.sectorFromStick(1, 0, 8),
			stickDead: m.sectorFromStick(0.1, 0.1, 8),
			layout: m.sectorLayout(0, 8),
			pose: {
				pos: [pose.position.x, pose.position.y, pose.position.z],
				quatW: pose.quaternion.w
			}
		};
	});
	h.check(
		math.top === 0 && math.right === 2 && math.bottom === 4 && math.diag === 1,
		`sectors count clockwise from 12 o'clock (${math.top}/${math.right}/${math.bottom}/${math.diag})`
	);
	h.check(math.hub === 'hub' && math.outside === null, 'center hits the hub, misses hit nothing');
	h.check(
		math.stickUp === 0 && math.stickRight === 2 && math.stickDead === null,
		`stick deflection picks sectors with a deadzone (${math.stickUp}/${math.stickRight}/${math.stickDead})`
	);
	h.check(
		Math.abs(math.layout.labelX) < 0.001 && math.layout.labelY > 0.05 && math.layout.labelY < 0.11,
		'sector 0 label sits at 12 o clock inside the smaller ring'
	);
	// controller yawed 90°: local -Z offset lands along world -X, y offset up
	h.check(
		Math.abs(math.pose.pos[0] - (1 - 0.05)) < 0.001 &&
			Math.abs(math.pose.pos[1] - 1.514) < 0.001 &&
			Math.abs(math.pose.pos[2] - -2) < 0.02,
		`anchor offset rides the controller pose (${math.pose.pos.map((v) => v.toFixed(3))})`
	);

	// --- registry: confirmed base ring + sub-rings + context hub ---
	const registry = await A.page.evaluate(() => {
		const m = window.__stores.vrRadialMenu;
		return {
			root: m.ringEntries('root').map((e) => e.id),
			system: m.ringEntries('system').map((e) => e.id),
			settings: m.ringEntries('settings').map((e) => e.id),
			addCount: m.ringEntries('add').length,
			tools: m.ringEntries('tools').map((e) => e.id),
			// PFX-C follow-up: presets moved into the nested Environment ▸ ring;
			// the Scene ring gained the nav entry + the Physics sim toggle
			sceneHasEnv: m.ringEntries('environment').some((e) => e.id === 'env:night'),
			sceneRing: m.ringEntries('scene').map((e) => e.id),
			micModes: m.ringEntries('mic').map((e) => e.id),
			objectOps: m.ringEntries('object').map((e) => e.id),
			faces: m.ringEntries('faces').map((e) => e.id),
			hubClose: m.hubEntry('root', false).id,
			hubObject: m.hubEntry('root', true).id,
			hubBack: m.hubEntry('add', true).id,
			...(() => {
				// 36: icons + depth over every ring reachable from root (BFS over ▸ sectors)
				const depth = { root: 0 };
				const queue = ['root'];
				const missing = [];
				for (let i = 0; i < queue.length; i++) {
					for (const e of m.ringEntries(queue[i])) {
						if (!e.icon && !e.id.startsWith('env:') && !e.id.startsWith('colo:') && !e.id.includes(':possess')) missing.push(e.id);
						if (e.ring && depth[e.ring] === undefined) {
							depth[e.ring] = depth[queue[i]] + 1;
							queue.push(e.ring);
						}
					}
				}
				return { allIconed: missing.length === 0, missingIcons: missing, maxDepth: Math.max(...Object.values(depth)) };
			})()
		};
	});
	// 36 (U3): the revised rings — desktop names/order, Settings ▸ replaces System ▸, every entry at most
	// two rings deep
	h.check(
		registry.root.join(',') === 'objects,nav:add,nav:scene,nav:tools,redo,undo,chat,nav:settings',
		`base ring: Settings ▸ replaces System ▸ (${registry.root.join(',')})`
	);
	h.check(
		registry.tools.join(',') === 'tool:select,tool:box,tool:draw,ping,physics,nav:profile',
		`Tools: Select / Box select / Draw mode / Ping / Simulate physics / Profile ▸ (${registry.tools.join(',')})`
	);
	h.check(
		registry.settings.slice(0, 5).join(',') === 'nav:settings:comfort,nav:settings:body,nav:settings:controls,nav:settings:display,nav:settings:editing' &&
			registry.settings.includes('set:mic') &&
			registry.settings.includes('settings') &&
			registry.settings.includes('exitvr'),
		`Settings ring: the five pages, Microphone, All settings, Exit VR (${registry.settings.join(',')})`
	);
	h.check(registry.system.length === 0, 'no System ring is left (a module filing under "system" lands in Settings)');
	h.check(registry.objectOps.includes('snap'), 'Selected ring keeps Snapping');
	h.check(registry.addCount === 7 && registry.sceneHasEnv, 'Add ring: 6 primitives + Prefabs (115)');
	h.check(
		registry.sceneRing.includes('nav:environment') &&
			registry.sceneRing.includes('grid') &&
			registry.sceneRing.includes('world') &&
			!registry.sceneRing.includes('physics') &&
			!registry.sceneRing.some((id) => id.startsWith('env:')),
		`Scene ring: Environment ▸ + Grid + World 1:1; Physics moved to Tools like the desktop (${registry.sceneRing.join(',')})`
	);
	h.check(registry.micModes.join(',') === 'mic:ptt,mic:open,mic:off', 'mic mode ids still resolve');
	// D4: modules may append entries (avatar:possess from the default-on avatar
	// module) — assert the built-in prefix, not an exact list. 36: the desktop object menu's order
	h.check(
		registry.objectOps.slice(0, 8).join(',') ===
			'obj:duplicate,obj:editmesh,obj:props,obj:color,snap,wireframe,obj:prefab,obj:delete' &&
			!registry.objectOps.includes('obj:visible') &&
			!registry.objectOps.includes('obj:vertices') &&
			!registry.objectOps.includes('nav:faces'),
		`Selected ring in the desktop order, Delete last (${registry.objectOps.join(',')})`
	);
	h.check(
		registry.faces.join(',') === 'face:extrude,face:inset,face:move,face:delete',
		`Faces sub-ring has the four blockout ops (${registry.faces.join(',')})`
	);
	h.check(
		registry.hubClose === 'close' && registry.hubObject === 'nav:object' && registry.hubBack === 'back',
		'hub is context-aware (close / Selected / back)'
	);
	h.check(registry.allIconed, `every built-in sector has a desktop icon (${registry.missingIcons.join(',') || 'none missing'})`);
	h.check(registry.maxDepth <= 2, `no entry is deeper than two rings (deepest ${registry.maxDepth})`);
	const hubLabel = await A.page.evaluate(() => window.__stores.vrRadialMenu.hubEntry('root', true).label);
	h.check(hubLabel === 'Selected', `selection hub reads Selected, the desktop menu's word (${hubLabel})`);

	// 109: nav STACK — System ▸ Mic ▸ Back pops to System, then to root; the
	// Chat sector opens its panel store and closes the ring
	const stack = await A.page.evaluate(
		() =>
			new Promise((resolve) => {
				const v = window.__stores.vrControls;
				const ring = () => {
					let r;
					window.__stores.vrRadialMenu.activeRing.subscribe((x) => (r = x))();
					return r;
				};
				window.__stores.vrMenuOpen.set(true);
				v.executeVRMenuAction('nav:settings');
				v.executeVRMenuAction('nav:settings:comfort');
				const inMic = ring();
				v.executeVRMenuAction('back');
				const afterBack = ring();
				v.executeVRMenuAction('back');
				const atRoot = ring();
				v.executeVRMenuAction('chat');
				let chatOpen, menuOpen;
				window.__stores.vrChatPanelOpen.subscribe((x) => (chatOpen = x))();
				window.__stores.vrMenuOpen.subscribe((x) => (menuOpen = x))();
				window.__stores.vrChatPanelOpen.set(false);
				resolve({ inMic, afterBack, atRoot, chatOpen, menuOpen });
			})
	);
	h.check(
		stack.inMic === 'settings:comfort' && stack.afterBack === 'settings' && stack.atRoot === 'root',
		`Back pops one nav level (${stack.inMic} → ${stack.afterBack} → ${stack.atRoot})`
	);
	h.check(stack.chatOpen === true && stack.menuOpen === false, 'Chat sector opens the panel store and closes the ring');

	// --- rendered structure + navigation ---
	const meshNames = () =>
		A.page.evaluate(
			() =>
				new Promise((resolve) => {
					window.__stores.globalScene.subscribe((scene) => {
						const menu = scene?.getObjectByName('vr-quick-menu');
						const names = [];
						menu?.traverse((o) => {
							if (o.name?.startsWith('vrmenu-')) names.push(o.name.slice(7));
						});
						resolve(names);
					})();
				})
		);
	await A.page.evaluate(() => window.__stores.vrMenuOpen.set(true));
	await A.page.waitForTimeout(400);
	let names = await meshNames();
	h.check(
		names.length === 9 && names.includes('objects') && names.includes('close'),
		`base ring renders 8 sectors + close hub (${names.length})`
	);
	await A.page.evaluate(() => window.__stores.vrControls.executeVRMenuAction('nav:add'));
	await A.page.waitForTimeout(300);
	names = await meshNames();
	h.check(
		names.includes('box') && names.includes('torus') && names.includes('back'),
		'nav:add opens the Add ring with a back hub'
	);
	await A.page.evaluate(() => window.__stores.vrControls.executeVRMenuAction('back'));
	await A.page.waitForTimeout(300);
	names = await meshNames();
	h.check(names.includes('objects'), 'back returns to the base ring');

	// closing the menu resets navigation to root
	await A.page.evaluate(() => {
		window.__stores.vrControls.executeVRMenuAction('nav:settings');
		window.__stores.vrMenuOpen.set(false);
	});
	const ringAfterClose = await A.page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.vrRadialMenu.activeRing.subscribe((r) => resolve(r))();
			})
	);
	h.check(ringAfterClose === 'root', 'closing the menu resets to the base ring');

	// --- object ring actions run through the dispatcher ---
	await A.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		const group = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		const box = group.children[group.children.length - 1];
		window.__stores.objectActions.selectObject(box);
		window.__box = box;
	});
	await A.page.waitForTimeout(400);
	const objectRing = await A.page.evaluate(() => {
		const read = (store) => {
			let v;
			store.subscribe((x) => (v = x))();
			return v;
		};
		window.__stores.vrMenuOpen.set(true);
		// Color opens the continuous palette (110) instead of painting directly
		window.__stores.vrControls.executeVRMenuAction('obj:color');
		const paletteOpen = read(window.__stores.vrPaletteOpen);
		const menuAfterColor = read(window.__stores.vrMenuOpen);
		window.__stores.vrPaletteOpen.set(false);
		// 137: Edit Mesh toggles mesh-edit mode + the side-menu
		window.__stores.vrMenuOpen.set(true);
		window.__stores.vrControls.executeVRMenuAction('obj:editmesh');
		const editOpen = read(window.__stores.vrEditMenuOpen);
		window.__stores.vrControls.executeVRMenuAction('obj:editmesh');
		const editClosed = read(window.__stores.vrEditMenuOpen) === false;
		window.__stores.vrMenuOpen.set(false);
		return { paletteOpen, menuAfterColor, editOpen, editClosed };
	});
	h.check(
		objectRing.paletteOpen === true && objectRing.menuAfterColor === false,
		'Color opens the palette panel and closes the ring'
	);
	h.check(objectRing.editOpen && objectRing.editClosed, 'Edit Mesh toggles the side-menu on/off (137)');

	// --- environment sector replicates through the normal env path ---
	await A.page.evaluate(() => window.__stores.vrControls.executeVRMenuAction('env:night'));
	await A.page.waitForTimeout(300);
	const preset = await A.page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.environment.environment.subscribe((e) => resolve(e.preset))();
			})
	);
	h.check(preset === 'night', `Scene ring switches the environment preset (${preset})`);

	// 99: Objects sector opens the (101) panel store and closes the ring
	await A.page.evaluate(() => {
		window.__stores.vrMenuOpen.set(true);
		window.__stores.vrControls.executeVRMenuAction('objects');
	});
	const objPanel = await A.page.evaluate(
		() =>
			new Promise((resolve) => {
				let open, menu;
				window.__stores.vrObjectsPanelOpen.subscribe((v) => (open = v))();
				window.__stores.vrMenuOpen.subscribe((v) => (menu = v))();
				resolve({ open, menu });
			})
	);
	h.check(objPanel.open === true && objPanel.menu === false, 'Objects sector opens the panel and closes the ring');
	await A.page.evaluate(() => window.__stores.vrObjectsPanelOpen.set(false));
	// 99: Statistics toggle persists (the 102 card re-attaches next session)
	await A.page.evaluate(() => window.__stores.vrControls.executeVRMenuAction('stats'));
	const statsPref = await A.page.evaluate(() => localStorage.getItem('vrStats'));
	h.check(statsPref === 'true', 'Statistics toggle persists its preference');
	await A.page.evaluate(() => window.__stores.vrControls.executeVRMenuAction('stats'));

	// --- registry is open: a 9th root entry re-fits the ring ---
	const extended = await A.page.evaluate(() => {
		const m = window.__stores.vrRadialMenu;
		m.registerVRMenuEntry({ id: 'test:extra', group: 'root', label: 'Extra', order: 99 });
		return { count: m.ringEntries('root').length, layout: m.sectorLayout(0, 9).thetaLength };
	});
	h.check(
		extended.count === 9 && extended.layout < (Math.PI * 2) / 8,
		'registered entries auto-fit the sector count'
	);

	await h.finish(browser);
});

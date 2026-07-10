// Phase 74: VR radial menu v2 — pure sector-hit math, the entry registry with
// the confirmed 8-sector base ring, ring navigation through the action
// dispatcher, the rendered radial structure (sector meshes + context hub) and
// object-ring actions. On-device feel (haptics, damped follow, hold mode) is
// the user's manual check.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// --- pure math ---
	const math = await A.page.evaluate(() => {
		const m = window.__stores.vrRadialMenu;
		return {
			top: m.sectorFromPoint(0, 0.13, 8),
			right: m.sectorFromPoint(0.13, 0, 8),
			bottom: m.sectorFromPoint(0, -0.13, 8),
			diag: m.sectorFromPoint(0.09, 0.09, 8),
			hub: m.sectorFromPoint(0.01, 0.01, 8),
			outside: m.sectorFromPoint(0.4, 0, 8),
			stickUp: m.sectorFromStick(0, -1, 8),
			stickRight: m.sectorFromStick(1, 0, 8),
			stickDead: m.sectorFromStick(0.1, 0.1, 8),
			layout: m.sectorLayout(0, 8)
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
		Math.abs(math.layout.labelX) < 0.001 && math.layout.labelY > 0.1,
		'sector 0 label sits at 12 o clock'
	);

	// --- registry: confirmed base ring + sub-rings + context hub ---
	const registry = await A.page.evaluate(() => {
		const m = window.__stores.vrRadialMenu;
		return {
			root: m.ringEntries('root').map((e) => e.id),
			system: m.ringEntries('system').map((e) => e.id),
			addCount: m.ringEntries('add').length,
			sceneHasEnv: m.ringEntries('scene').some((e) => e.id === 'env:night'),
			micModes: m.ringEntries('mic').map((e) => e.id),
			objectOps: m.ringEntries('object').map((e) => e.id),
			hubClose: m.hubEntry('root', false).id,
			hubObject: m.hubEntry('root', true).id,
			hubBack: m.hubEntry('add', true).id
		};
	});
	h.check(
		registry.root.join(',') === 'move,rotate,nav:add,nav:scene,draw,undo,nav:mic,nav:system',
		`base ring is the confirmed 8 sectors (${registry.root.join(',')})`
	);
	h.check(
		registry.system.includes('snap') && registry.system.includes('passthru') && registry.system.includes('exitvr'),
		'System ring carries the toggles + session controls'
	);
	h.check(registry.addCount === 6 && registry.sceneHasEnv, 'Add + Scene rings populated');
	h.check(registry.micModes.join(',') === 'mic:ptt,mic:open,mic:off', 'Mic ring lists explicit modes');
	h.check(
		registry.objectOps.slice(0, 3).join(',') === 'obj:visible,obj:duplicate,obj:delete' &&
			registry.objectOps.length === 11,
		`Object ring has ops + 8 color swatches (${registry.objectOps.length})`
	);
	h.check(
		registry.hubClose === 'close' && registry.hubObject === 'nav:object' && registry.hubBack === 'back',
		'hub is context-aware (close / Object / back)'
	);

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
		names.length === 9 && names.includes('move') && names.includes('close'),
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
	h.check(names.includes('move'), 'back returns to the base ring');

	// closing the menu resets navigation to root
	await A.page.evaluate(() => {
		window.__stores.vrControls.executeVRMenuAction('nav:system');
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
		window.__stores.vrMenuOpen.set(true);
		window.__stores.vrControls.executeVRMenuAction('color:e63946');
		const color = '#' + window.__box.material.color.getHexString();
		window.__stores.vrControls.executeVRMenuAction('obj:visible');
		const hidden = window.__box.visible === false;
		window.__stores.vrControls.executeVRMenuAction('obj:visible');
		window.__stores.vrMenuOpen.set(false);
		return { color, hidden };
	});
	h.check(objectRing.color === '#e63946', `color swatch paints the selection (${objectRing.color})`);
	h.check(objectRing.hidden, 'Show/Hide toggles the selection');

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

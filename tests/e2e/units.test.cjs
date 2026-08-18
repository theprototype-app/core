// #20 P3 — display units.
//
// The claim being tested is narrow and worth stating precisely: a unit changes what a
// FIELD shows and accepts, and NOTHING else. The scene stays metres and radians, so the
// strongest checks here are the ones that read the object's real transform after a unit
// change and demand it did not move.
//
// The other half is the parser. `12cm` typed into a metres field must store 0.12
// whatever unit is on display, because that is the whole reason one global setting is
// enough and per-input pickers were not needed.
const h = require('./helpers.cjs');

/** Read the selected object's real, internal transform. */
const XFORM = () => {
	let g, sel;
	window.__stores.objectsGroup.subscribe((v) => (g = v))();
	window.__stores.selectedObject.subscribe((v) => (sel = v))();
	const o = g.getObjectByProperty('uuid', sel.uuid);
	return {
		pos: [o.position.x, o.position.y, o.position.z],
		rot: [o.rotation.x, o.rotation.y, o.rotation.z]
	};
};

/** The text and unit chip showing in an Inspector row. */
const ROW = (sel) => {
	const wrap = document.querySelector(sel)?.closest('.dn-wrap');
	const input = document.querySelector(sel);
	return {
		text: input ? input.value : null,
		unit: wrap ? (wrap.querySelector('.dn-unit')?.textContent ?? null) : null
	};
};

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// ---- 1. the pure module, no browser chrome involved ------------------------
	// Parsing and conversion are pure, so assert them exactly rather than through
	// a field: a wrong factor here is a wrong scene everywhere.
	const pure = await A.page.evaluate(() => {
		const u = window.__stores.units;
		return {
			// a SUFFIX wins over whatever is on display
			cmInMetres: u.parseValue('12cm', 'length', 'm'),
			inchInMetres: u.parseValue('4in', 'length', 'm'),
			footTick: u.parseValue("2'", 'length', 'm'),
			inchTick: u.parseValue('6"', 'length', 'm'),
			mmInMetres: u.parseValue('250mm', 'length', 'm'),
			// a BARE number means the unit on display
			bareInCm: u.parseValue('12', 'length', 'cm'),
			bareInMetres: u.parseValue('12', 'length', 'm'),
			// angle, both internal conventions
			degToRad: u.parseValue('90deg', 'angle', 'rad'),
			radToRad: u.parseValue('1.5708rad', 'angle', 'rad'),
			degToDeg: u.parseValue('90deg', 'angleDeg', 'deg'),
			radToDeg: u.parseValue('3.14159rad', 'angleDeg', 'deg'),
			// a lone suffix is not zero of it, and an exponent is not eaten by `d`/`r`
			loneSuffix: u.parseValue('cm', 'length', 'm'),
			exponent: u.parseValue('1e3', 'length', 'm'),
			// display decimals shift with magnitude, and never drop below 1 for angles
			decCm: u.displayDecimals(3, 'length', 'cm'),
			decMm: u.displayDecimals(3, 'length', 'mm'),
			decM: u.displayDecimals(3, 'length', 'm'),
			decDeg: u.displayDecimals(3, 'angle', 'deg'),
			// CEIL, not round: a unit whose magnitude is not a round power of ten must
			// come out FINER than the field asked for, never coarser. Whole inches would
			// be 2.5cm steps on a row that gives cm control in metres.
			decIn: u.displayDecimals(2, 'length', 'in'),
			decFt: u.displayDecimals(2, 'length', 'ft'),
			// an unrecognised unit degrades to a plain number rather than scaling
			junk: u.factorFor('length', 'furlong')
		};
	});
	h.check(Math.abs(pure.cmInMetres - 0.12) < 1e-9, `12cm is 0.12 m (got ${pure.cmInMetres})`);
	h.check(Math.abs(pure.inchInMetres - 0.1016) < 1e-9, `4in is 0.1016 m (got ${pure.inchInMetres})`);
	h.check(Math.abs(pure.footTick - 0.6096) < 1e-9, `2' is 0.6096 m (got ${pure.footTick})`);
	h.check(Math.abs(pure.inchTick - 0.1524) < 1e-9, `6" is 0.1524 m (got ${pure.inchTick})`);
	h.check(Math.abs(pure.mmInMetres - 0.25) < 1e-9, `250mm is 0.25 m (got ${pure.mmInMetres})`);
	h.check(Math.abs(pure.bareInCm - 0.12) < 1e-9, `a bare 12 in a cm field is 0.12 m (got ${pure.bareInCm})`);
	h.check(pure.bareInMetres === 12, `a bare 12 in a metres field is 12 m (got ${pure.bareInMetres})`);
	h.check(Math.abs(pure.degToRad - Math.PI / 2) < 1e-6, `90deg is pi/2 rad (got ${pure.degToRad})`);
	h.check(Math.abs(pure.radToRad - 1.5708) < 1e-6, `1.5708rad stays itself (got ${pure.radToRad})`);
	h.check(pure.degToDeg === 90, `90deg into a DEGREE-internal field is 90 (got ${pure.degToDeg})`);
	h.check(Math.abs(pure.radToDeg - 180) < 0.01, `3.14159rad into a degree field is 180 (got ${pure.radToDeg})`);
	h.check(Number.isNaN(pure.loneSuffix), `a lone "cm" is not zero centimetres (got ${pure.loneSuffix})`);
	h.check(pure.exponent === 1000, `1e3 parses as 1000, not mangled by an alias (got ${pure.exponent})`);
	h.check(pure.decCm === 1, `3 decimals of metres is 1 of cm (got ${pure.decCm})`);
	h.check(pure.decMm === 0, `3 decimals of metres is 0 of mm (got ${pure.decMm})`);
	h.check(pure.decM === 3, `metres keeps its own count (got ${pure.decM})`);
	h.check(pure.decDeg >= 1, `an angle never drops below 1 decimal (got ${pure.decDeg})`);
	h.check(pure.decIn >= 1, `inches stay FINER than the metre baseline, not coarser (got ${pure.decIn})`);
	h.check(pure.decFt >= 1, `so do feet (got ${pure.decFt})`);
	h.check(pure.junk === 1, `an unknown unit is a factor of 1, never a scene rescale (got ${pure.junk})`);

	// ---- 2. an Inspector row RE-RENDERS without moving the object ---------------
	const uuid = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.commandsHandler.sceneCommand('/create box 1 1 1');
		await new Promise((r) => setTimeout(r, 900));
		let g;
		w.objectsGroup.subscribe((v) => (g = v))();
		const o = g.children[g.children.length - 1];
		o.position.set(1.5, 0.25, -2);
		o.rotation.set(0, Math.PI / 2, 0);
		w.objectsGroup.update((v) => v);
		w.objectActions.applySelectionSet([o.uuid], true);
		await new Promise((r) => setTimeout(r, 700));
		return o.uuid;
	});
	h.check(!!uuid, 'a box at (1.5, 0.25, -2) rotated 90deg about Y, selected (premise)');

	const inM = await A.page.evaluate(ROW, '#inspector-position .dn-input');
	h.check(inM.text === '1.50', `position X shows 1.50 in metres, unchanged by units (got ${inM.text})`);
	h.check(inM.unit === 'm', `the row is labelled m (got ${inM.unit})`);

	const rotFirst = await A.page.evaluate(ROW, '#inspector-rotation .dn-input');
	h.check(rotFirst.unit === '°', `the rotation row is labelled in degrees by default (got ${rotFirst.unit})`);

	const beforeSwitch = await A.page.evaluate(XFORM);
	await A.page.evaluate(() => window.__stores.units.lengthUnit.set('cm'));
	await A.page.waitForTimeout(400);
	const inCm = await A.page.evaluate(ROW, '#inspector-position .dn-input');
	h.check(inCm.text === '150', `switching to cm shows 150 (got ${inCm.text})`);
	h.check(inCm.unit === 'cm', `and the chip follows (got ${inCm.unit})`);

	const afterSwitch = await A.page.evaluate(XFORM);
	h.check(
		JSON.stringify(beforeSwitch) === JSON.stringify(afterSwitch),
		`the object did NOT move when the unit changed (${JSON.stringify(afterSwitch.pos)})`
	);

	// ---- 3. typing in the display unit, and typing a SUFFIX ---------------------
	// In cm, a bare 250 means 2.5m. A typed `4in` means 0.1016m even though cm is shown.
	const typedBare = await A.page.evaluate(async () => {
		const input = document.querySelector('#inspector-position .dn-input');
		input.focus();
		input.value = '250';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		await new Promise((r) => setTimeout(r, 300));
		let g, sel;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		window.__stores.selectedObject.subscribe((v) => (sel = v))();
		return g.getObjectByProperty('uuid', sel.uuid).position.x;
	});
	h.check(Math.abs(typedBare - 2.5) < 1e-6, `250 typed into a cm field stored 2.5 m (got ${typedBare})`);

	const typedSuffix = await A.page.evaluate(async () => {
		const input = document.querySelector('#inspector-position .dn-input');
		input.focus();
		input.value = '4in';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		await new Promise((r) => setTimeout(r, 300));
		let g, sel;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		window.__stores.selectedObject.subscribe((v) => (sel = v))();
		return g.getObjectByProperty('uuid', sel.uuid).position.x;
	});
	h.check(
		Math.abs(typedSuffix - 0.1016) < 1e-6,
		`4in typed while cm is on display stored 0.1016 m (got ${typedSuffix})`
	);

	// ---- 4. a scrub covers the same DISTANCE whatever the unit ------------------
	// `step` is internal, so the same pixel travel must move the object identically in
	// metres and in cm. This is the check that would catch a factor applied twice.
	const scrub = await A.page.evaluate(async () => {
		const w = window.__stores;
		let g, sel;
		w.objectsGroup.subscribe((v) => (g = v))();
		w.selectedObject.subscribe((v) => (sel = v))();
		const o = g.getObjectByProperty('uuid', sel.uuid);

		const run = async (unit) => {
			w.units.lengthUnit.set(unit);
			await new Promise((r) => setTimeout(r, 250));
			o.position.x = 0;
			w.objectsGroup.update((v) => v);
			await new Promise((r) => setTimeout(r, 250));
			const wrap = document.querySelector('#inspector-position .dn-wrap');
			const r = wrap.getBoundingClientRect();
			const y = r.y + r.height / 2;
			const x0 = r.x + 8;
			wrap.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, buttons: 1, clientX: x0, clientY: y, pointerId: 1 }));
			for (let dx = 10; dx <= 60; dx += 10)
				wrap.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, buttons: 1, clientX: x0 + dx, clientY: y, pointerId: 1 }));
			wrap.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, buttons: 0, clientX: x0 + 60, clientY: y, pointerId: 1 }));
			await new Promise((r) => setTimeout(r, 250));
			return o.position.x;
		};
		const inMetres = await run('m');
		const inCm = await run('cm');
		return { inMetres, inCm };
	});
	h.check(
		Math.abs(scrub.inMetres) > 0.01,
		`the scrub actually moved the object (premise: ${scrub.inMetres})`
	);
	h.check(
		Math.abs(scrub.inMetres - scrub.inCm) < 1e-6,
		`the same 60px scrub moves the same DISTANCE in m and cm (${scrub.inMetres} vs ${scrub.inCm})`
	);

	// ---- 5. the angle rows, both internal conventions --------------------------
	// The Inspector holds RADIANS and the snap step holds DEGREES; one shared setting
	// must render both correctly, which is exactly what two kinds buy. The object's Y
	// rotation is pi/2, so the VALUE is the check — a label alone would pass with the
	// conversion missing.
	const angles = await A.page.evaluate(async () => {
		const w = window.__stores;
		// snapSettings lives on the snapping MODULE, not the store spread
		w.snapping.snapSettings.update((s) => ({ ...s, rotateDeg: 45 }));
		w.units.angleUnit.set('deg');
		await new Promise((r) => setTimeout(r, 400));
		const read = (i) => {
			const el = document.querySelectorAll('#inspector-rotation .dn-input')[i];
			const wrap = el?.closest('.dn-wrap');
			return { text: el?.value ?? null, unit: wrap?.querySelector('.dn-unit')?.textContent ?? null };
		};
		const snapRead = () => {
			const el = document.querySelector('#snap-rotate');
			const wrap = el?.closest('.dn-wrap');
			return { text: el?.value ?? null, unit: wrap?.querySelector('.dn-unit')?.textContent ?? null };
		};
		const degY = read(1);
		w.units.angleUnit.set('rad');
		await new Promise((r) => setTimeout(r, 400));
		const radY = read(1);
		w.units.angleUnit.set('deg');
		await new Promise((r) => setTimeout(r, 250));
		let snap, g, sel;
		w.snapping.snapSettings.subscribe((v) => (snap = v))();
		w.objectsGroup.subscribe((v) => (g = v))();
		w.selectedObject.subscribe((v) => (sel = v))();
		const rotY = g.getObjectByProperty('uuid', sel.uuid).rotation.y;
		return { degY, radY, snapDeg: snap.rotateDeg, rotY };
	});
	h.check(
		angles.degY.unit === '°' && Math.abs(parseFloat(angles.degY.text) - 90) < 0.05,
		`a pi/2 radian rotation shows 90 degrees (got ${angles.degY.text} ${angles.degY.unit})`
	);
	h.check(
		angles.radY.unit === 'rad' && Math.abs(parseFloat(angles.radY.text) - Math.PI / 2) < 0.01,
		`and 1.571 in radians (got ${angles.radY.text} ${angles.radY.unit})`
	);
	h.check(
		Math.abs(angles.rotY - Math.PI / 2) < 1e-9,
		`the stored rotation never left radians (got ${angles.rotY})`
	);
	h.check(
		angles.snapDeg === 45,
		`the stored snap step is still 45 degrees (got ${angles.snapDeg})`
	);

	// ---- 5b. the SAME setting on a field whose internal unit is DEGREES ---------
	// snapSettings.rotateDeg is degrees, object.rotation is radians, and one shared
	// preference has to render both — which is the entire reason there are two angle
	// kinds rather than one. The snap step lives in the SCENE inspector, a different
	// panel from the rotation rows, so it needs its own deep link and its own read.
	const snapRow = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.openSceneSection('Snapping');
		await new Promise((r) => setTimeout(r, 900));
		const read = () => {
			const el = document.querySelector('#snap-rotate');
			const wrap = el?.closest('.dn-wrap');
			return { text: el?.value ?? null, unit: wrap?.querySelector('.dn-unit')?.textContent ?? null };
		};
		const deg = read();
		w.units.angleUnit.set('rad');
		await new Promise((r) => setTimeout(r, 400));
		const rad = read();
		w.units.angleUnit.set('deg');
		await new Promise((r) => setTimeout(r, 250));
		let snap;
		w.snapping.snapSettings.subscribe((v) => (snap = v))();
		return { deg, rad, stored: snap.rotateDeg };
	});
	h.check(snapRow.deg.text !== null, `the Snapping section opened (premise: ${JSON.stringify(snapRow.deg)})`);
	h.check(
		snapRow.deg.unit === '°' && Math.abs(parseFloat(snapRow.deg.text) - 45) < 0.05,
		`the degree-internal snap step reads 45 in degrees (got ${snapRow.deg.text} ${snapRow.deg.unit})`
	);
	h.check(
		snapRow.rad.unit === 'rad' && Math.abs(parseFloat(snapRow.rad.text) - Math.PI / 4) < 0.01,
		`...and 0.785 in radians, from the same stored 45 (got ${snapRow.rad.text} ${snapRow.rad.unit})`
	);
	h.check(snapRow.stored === 45, `the stored step never left degrees (got ${snapRow.stored})`);

	// ---- 6. nothing crashed --------------------------------------------------
	const errs = h.pageErrors(A);
	h.check(errs.length === 0, `no page errors (${JSON.stringify(errs.slice(0, 2))})`);

	await h.finish(browser);
});

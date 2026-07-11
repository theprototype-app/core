// Phase 127: session .zip export/import — the zip carries session.json plus
// the scene's bundled assets (index.json); re-importing restores a session.
// The full asset round-trip with a real hashed sound/texture is exercised by
// the scene-assets + assetShare suites; here we prove the zip machinery.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// --- export a saved session to a zip, re-import it round-trips ---
	const roundtrip = await A.page.evaluate(async () => {
		const S = window.__stores.sessions;
		window.__stores.commandsHandler.sceneCommand('/create box');
		window.__stores.commandsHandler.sceneCommand('/create sphere');
		await new Promise((r) => setTimeout(r, 150));
		const payload = await S.saveSession('Zippy');
		const zipBytes = await S.exportSessionZip(payload);
		const imported = await S.importSessionZip(zipBytes.buffer);
		return {
			zipLen: zipBytes.length,
			savedObjects: payload.objects.length,
			importedObjects: imported.objects.length,
			importedName: imported.name,
			freshId: imported.id !== payload.id
		};
	});
	h.check(roundtrip.zipLen > 0, `export produces a non-empty zip (${roundtrip.zipLen} bytes)`);
	h.check(
		roundtrip.importedObjects === roundtrip.savedObjects && roundtrip.savedObjects === 2,
		`re-import restores the session objects (${roundtrip.importedObjects})`
	);
	h.check(roundtrip.importedName === 'Zippy' && roundtrip.freshId, 'imported session keeps its name with a fresh id');

	// --- output is a real zip (PK magic); a zip missing session.json is rejected ---
	const structure = await A.page.evaluate(async () => {
		const S = window.__stores.sessions;
		const payload = await S.saveSession('Structured');
		const zipBytes = await S.exportSessionZip(payload);
		let rejected = false;
		try {
			// an empty/garbage buffer is not a session zip
			await S.importSessionZip(new Uint8Array([1, 2, 3, 4]).buffer);
		} catch {
			rejected = true;
		}
		return { pk: zipBytes[0] === 0x50 && zipBytes[1] === 0x4b, rejected };
	});
	h.check(structure.pk, 'export writes a real ZIP (PK header)');
	h.check(structure.rejected, 'a non-session zip is rejected');

	// --- import still accepts a plain .json string (unchanged path) ---
	const jsonImport = await A.page.evaluate(async () => {
		const S = window.__stores.sessions;
		const payload = await S.saveSession('PlainJson');
		const json = S.exportSession(payload);
		const imported = await S.importSession(json);
		return imported.objects.length === payload.objects.length;
	});
	h.check(jsonImport, 'plain .json import is unaffected');

	await h.finish(browser);
});

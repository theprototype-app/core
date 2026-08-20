// 21-E7 — HUD CONTENT: authorable rows, a drivable option list, rich text, module and
// user-scripted element kinds, the two packs, and style presets.
//
// What each section is really proving, because several of these could pass vacuously:
//
// * ROWS had NO authoring path at all. `setHudRows` lived in flowRuntime, reachable from
//   neither the editor nor the SDK, so the List kind shipped with a summary promising an
//   API that did not exist. Three doors are checked, and the NODE door is checked for
//   GOLDEN RULE 8 as well: the peer's rows must converge with NO new message type, which
//   is asserted by recording every `send` and reading what actually went out.
// * RICH TEXT is a whitelist parser and not a sanitizer, so the counterfactual is the
//   point: a hostile string must produce no <img> node at all while keeping its text.
// * A MODULE KIND and a USER-SCRIPTED kind both run foreign code inside the layer, so the
//   containment is asserted — a throwing render function renders a chip and the layer
//   SURVIVES with its other elements intact.
// * THE PACKS are looped from the REGISTRY rather than listed here, which is what makes
//   this a drift-proof check: a kind added later is covered without editing this file, and
//   a kind whose renderer branch is missing fails immediately.
//
// Run: $env:APP_URL='https://localhost:5204/'; PEER_CONFIG=...; npm run e2e -- hud-content
const h = require('./helpers.cjs');

/** the document every section works against */
const HUD = () => {
	window.__stores.hudDocs.clearHudDocs();
	window.__stores.hudDocs.setHudDocFor('scene', {
		screens: [
			{
				id: 'main',
				name: 'Main',
				elements: [
					{ id: 'board', kind: 'list', title: 'Scores', rowsText: '', anchor: 'top-left', x: 20, y: 20, w: 200, h: 140 },
					{ id: 'note', kind: 'richtext', label: '', anchor: 'top-right', x: 20, y: 20, w: 300, h: 90 },
					{ id: 'diff', kind: 'dropdown', label: '', options: 'Easy, Normal, Hard', value: 'Normal', anchor: 'middle-left', x: 20, y: 0, w: 200, h: 30 },
					{ id: 'anchorpoint', kind: 'text', label: 'anchor', anchor: 'bottom-left', x: 20, y: 20, w: 120, h: 24 }
				]
			}
		],
		active: 'main'
	});
};

const elText = (peer, id) =>
	peer.page.evaluate(
		(elId) => document.querySelector(`[data-hud-id="${elId}"] .hud-el`)?.textContent?.trim() ?? null,
		id
	);

const rowsOf = (peer, id) =>
	peer.page.evaluate(
		(elId) => [...document.querySelectorAll(`[data-hud-id="${elId}"] .hud-list-row`)].map((r) => r.textContent.trim()),
		id
	);

h.run(async () => {
	// GPU args: a software-rendered page runs at ~2.5fps and the ~10Hz hudRuntime throttle
	// cannot engage below that, so a throttled read would be measuring the renderer.
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const page = A.page;
	await page.waitForFunction(() => !!window.__stores?.hudRichText && !!window.__stores?.moduleHudKinds, {
		timeout: 30000
	});
	await page.evaluate(HUD);
	await page.waitForTimeout(1200);

	// =====================================================================
	// 1. E7.1 — ROWS, DOOR ONE: the properties pane
	// =====================================================================
	const field = await page.evaluate(() => {
		const K = window.__stores.hudKinds;
		return {
			fields: K.fieldsForKind('list').map((f) => f.key + ':' + f.kind),
			// the 'list' field kind has been DECLARED in the HudField typedef since 21-D1 and
			// nothing rendered it — it fell through to the single-line text input, which cannot
			// hold a newline, which is the entire point of the kind
			declared: K.HUD_KIND_DEFS.some((d) => d.fields.some((f) => f.kind === 'list'))
		};
	});
	h.check(
		field.fields.includes('rowsText:list'),
		`the list kind declares an authored row field (${field.fields.join(' ')})`
	);
	h.check(field.declared, 'and the registry uses the previously-unrendered `list` field kind');

	const authored = await page.evaluate(async () => {
		const H = window.__stores.hudDocs;
		H.updateHudElement('scene', 'main', 'board', { rowsText: 'Ada 12\nGrace 9\nAlan 7' });
		await new Promise((r) => setTimeout(r, 700));
		return [...document.querySelectorAll('[data-hud-id="board"] .hud-list-row')].map((r) => r.textContent.trim());
	});
	h.check(
		authored.length === 3 && authored[0] === 'Ada 12' && authored[2] === 'Alan 7',
		`typed rows render, one per line (${JSON.stringify(authored)})`
	);
	// blank lines are not rows — a trailing newline is how a textarea ends, not an empty row
	const trimmed = await page.evaluate(async () => {
		window.__stores.hudDocs.updateHudElement('scene', 'main', 'board', { rowsText: 'One\n\n  \nTwo\n' });
		await new Promise((r) => setTimeout(r, 700));
		return [...document.querySelectorAll('[data-hud-id="board"] .hud-list-row')].map((r) => r.textContent.trim());
	});
	h.check(
		trimmed.length === 2 && trimmed[0] === 'One' && trimmed[1] === 'Two',
		`blank lines are not rows (${JSON.stringify(trimmed)})`
	);

	// the PANE really renders a textarea for it (the widget, not just the schema)
	const paneWidget = await page.evaluate(async () => {
		const s = window.__stores;
		s.hudEditorClose.set(false);
		await new Promise((r) => setTimeout(r, 900));
		s.hudDocs.hudSelection.set({});
		// select the list element the way the editor does
		const item = document.querySelector('[data-hud-item="board"]');
		item?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
		window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
		await new Promise((r) => setTimeout(r, 900));
		const area = document.querySelector('[data-hud-list="rowsText"]');
		const codeBtn = document.querySelector('[data-hud-code="code"]');
		return {
			tag: area?.tagName ?? null,
			multiline: area ? Number(area.getAttribute('rows')) : 0,
			value: area?.value ?? null,
			codeRow: !!codeBtn
		};
	});
	h.check(
		paneWidget.tag === 'TEXTAREA' && paneWidget.multiline >= 2,
		`the pane renders a real multi-line editor for it (${paneWidget.tag}, rows=${paneWidget.multiline})`
	);
	h.check(paneWidget.value === 'One\n\n  \nTwo\n', 'holding the authored string verbatim');

	// and typing in it writes the document (through the ONE update path)
	const typed = await page.evaluate(async () => {
		const area = document.querySelector('[data-hud-list="rowsText"]');
		area.value = 'Row A\nRow B';
		area.dispatchEvent(new Event('change', { bubbles: true }));
		await new Promise((r) => setTimeout(r, 700));
		const el = window.__stores.hudDocs.elementById('scene', 'board');
		return { stored: el?.rowsText ?? null };
	});
	h.check(typed.stored === 'Row A\nRow B', `editing it writes the document (${JSON.stringify(typed.stored)})`);
	await page.evaluate(async () => {
		window.__stores.hudEditorClose.set(true);
		await new Promise((r) => setTimeout(r, 700));
	});

	// =====================================================================
	// 2. E7.1 — ROWS, DOOR TWO: the `hudrows` node, on stamp EDGES
	// =====================================================================
	const nodeReg = await page.evaluate(() => {
		const C = window.__stores.nodeCatalog;
		const S = window.__stores.flowSockets;
		const spec = C.findNodeSpec ? C.findNodeSpec('hudrows') : null;
		return {
			inCatalog: !!spec,
			params: (spec?.params ?? []).map((p) => p.key).join(','),
			trigger: S.inputType('hudrows', 'trigger'),
			text: S.inputType('hudrows', 'text'),
			// a sink, like hudtext/hudlist
			out: S.outputType('hudrows'),
			// E7.2: hudset gained the options handle, additively
			options: S.inputType('hudset', 'options'),
			value: S.inputType('hudset', 'value')
		};
	});
	h.check(nodeReg.inCatalog, `HUD Rows is in the catalog (params ${nodeReg.params})`);
	h.check(
		nodeReg.trigger === 'event' && nodeReg.text === 'number',
		`its trigger is an event and its row is a value handle (${nodeReg.trigger}/${nodeReg.text})`
	);
	h.check(nodeReg.out === 'effect', `it is a SINK, like every other write-into-an-element node (${nodeReg.out})`);
	h.check(
		nodeReg.options === 'number' && nodeReg.value === 'number',
		`hudset's options handle is declared beside value, additively (${nodeReg.options})`
	);

	await page.evaluate(() => {
		const s = window.__stores;
		s.flowNodes.set([
			{ id: 'tick', type: 'onclick', position: { x: 0, y: 0 }, data: { type: 'onclick', pulse: 0.3 } },
			{ id: 'n', type: 'counter', position: { x: 200, y: 0 }, data: { type: 'counter', step: 1, op: 'up' } },
			{
				id: 'rows',
				type: 'hudrows',
				position: { x: 400, y: 0 },
				data: { type: 'hudrows', element: 'board', op: 'append', text: '' }
			}
		]);
		s.flowEdges.set([
			{ id: 'e1', source: 'tick', target: 'n', targetHandle: 'pulse' },
			{ id: 'e2', source: 'tick', target: 'rows', targetHandle: 'trigger' },
			{ id: 'e3', source: 'n', target: 'rows', targetHandle: 'text' }
		]);
	});
	await page.waitForTimeout(1200);

	// APPEND, three times. The point of the stamp edge is that a live pulse lasts many
	// frames: acting per frame would append the same row sixty times a second, so the
	// count here IS the edge test.
	const appended = await page.evaluate(async () => {
		for (let i = 0; i < 3; i++) {
			window.__stores.flowRuntime.applyNodeTrigger('tick', (Date.now() % 86400000) / 1000, true);
			await new Promise((r) => setTimeout(r, 350));
		}
		await new Promise((r) => setTimeout(r, 700));
		return {
			store: window.__stores.flowRuntime.hudRowsOf('board'),
			dom: [...document.querySelectorAll('[data-hud-id="board"] .hud-list-row')].map((r) => r.textContent.trim())
		};
	});
	h.check(
		appended.store.length === 3,
		`three pulses append exactly three rows — one per stamp EDGE, not one per frame (${JSON.stringify(appended.store)})`
	);
	h.check(
		appended.dom.length === 3 && appended.dom[2] === '3',
		`and the pushed rows beat the authored ones in the DOM (${JSON.stringify(appended.dom)})`
	);

	const setOp = await page.evaluate(async () => {
		window.__stores.nodesHandler.setNodeData('rows', { op: 'set' });
		await new Promise((r) => setTimeout(r, 600));
		window.__stores.flowRuntime.applyNodeTrigger('tick', (Date.now() % 86400000) / 1000, true);
		await new Promise((r) => setTimeout(r, 800));
		return window.__stores.flowRuntime.hudRowsOf('board');
	});
	h.check(setOp.length === 1, `\`set\` REPLACES the list (${JSON.stringify(setOp)})`);

	const cleared = await page.evaluate(async () => {
		window.__stores.nodesHandler.setNodeData('rows', { op: 'clear' });
		await new Promise((r) => setTimeout(r, 600));
		window.__stores.flowRuntime.applyNodeTrigger('tick', (Date.now() % 86400000) / 1000, true);
		await new Promise((r) => setTimeout(r, 900));
		return {
			store: window.__stores.flowRuntime.hudRowsOf('board'),
			dom: [...document.querySelectorAll('[data-hud-id="board"] .hud-list-row')].map((r) => r.textContent.trim())
		};
	});
	h.check(cleared.store.length === 0, `\`clear\` empties it (${JSON.stringify(cleared.store)})`);
	h.check(
		cleared.dom.length === 2 && cleared.dom[0] === 'Row A',
		`and the AUTHORED rows come back — a param is the fallback, not a second source of truth (${JSON.stringify(cleared.dom)})`
	);

	// =====================================================================
	// 3. E7.1 — ROWS, DOOR THREE: api.hud.rows, and its journal teardown
	// =====================================================================
	const sdkRows = await page.evaluate(async () => {
		await window.__stores.moduleSDK.initModules([
			{
				id: 'rowsmod',
				name: 'Rows module',
				version: '1.0.0',
				description: 'proves api.hud.rows',
				register(api) {
					window.__rowsApi = api;
					api.hud.rows('board', ['from a module', 'second']);
				}
			}
		]);
		await new Promise((r) => setTimeout(r, 900));
		return {
			store: window.__stores.flowRuntime.hudRowsOf('board'),
			dom: [...document.querySelectorAll('[data-hud-id="board"] .hud-list-row')].map((r) => r.textContent.trim()),
			hasApi: typeof window.__rowsApi?.hud?.rows === 'function'
		};
	});
	h.check(sdkRows.hasApi, 'api.hud.rows exists on the module api');
	h.check(
		sdkRows.dom.length === 2 && sdkRows.dom[0] === 'from a module',
		`a module fills a list with no node at all (${JSON.stringify(sdkRows.dom)})`
	);

	const afterTeardown = await page.evaluate(async () => {
		window.__stores.moduleSDK.deactivateModule('rowsmod');
		await new Promise((r) => setTimeout(r, 900));
		return {
			store: window.__stores.flowRuntime.hudRowsOf('board'),
			dom: [...document.querySelectorAll('[data-hud-id="board"] .hud-list-row')].map((r) => r.textContent.trim())
		};
	});
	h.check(
		afterTeardown.store.length === 0,
		`the module JOURNAL clears its rows at teardown (${JSON.stringify(afterTeardown.store)})`
	);
	h.check(
		afterTeardown.dom.length === 2 && afterTeardown.dom[0] === 'Row A',
		`so disabling it shows the authored rows rather than freezing the last push (${JSON.stringify(afterTeardown.dom)})`
	);

	// =====================================================================
	// 4. E7.1 — api.peerNames()
	// =====================================================================
	const names = await page.evaluate(async () => {
		// a roster with a nickname in slot 1, which is where the Users popover reads it
		window.__stores.userdata.set([
			[window.__stores.peers && 'self-id', 'Ada', ''],
			['peer-2', 'Grace', ''],
			['peer-3', '', '']
		]);
		await new Promise((r) => setTimeout(r, 300));
		let api = null;
		await window.__stores.moduleSDK.initModules([
			{
				id: 'namesmod',
				name: 'Names',
				version: '1.0.0',
				description: 'peerNames',
				register(a) {
					api = a;
				}
			}
		]);
		const list = api.peerNames();
		window.__stores.moduleSDK.deactivateModule('namesmod');
		return list;
	});
	h.check(
		names.length === 3 && names[0].name === 'Ada' && names[1].name === 'Grace',
		`peerNames returns the roster NAMES, not just ids (${JSON.stringify(names.map((n) => n.name))})`
	);
	h.check(
		names[2].name === '' && /^peer /.test(names[2].label),
		`and a peer with no nickname still gets a usable label (${JSON.stringify(names[2].label)})`
	);
	h.check(
		names.every((n) => typeof n.id === 'string' && n.id.length > 0),
		'every entry carries its peer id, so a caller can key state by it'
	);

	// =====================================================================
	// 5. E7.2 — the OPTIONS channel, and the index read that follows it
	// =====================================================================
	const optBefore = await page.evaluate(() => ({
		dom: [...document.querySelectorAll('[data-hud-id="diff"] option')].map((o) => o.value),
		live: window.__stores.flowRuntime.hudOptionsOf('diff', window.__stores.hudDocs.elementById('scene', 'diff'))
	}));
	h.check(
		optBefore.dom.join(',') === 'Easy,Normal,Hard',
		`premise: the dropdown offers its AUTHORED options (${optBefore.dom.join(',')})`
	);

	const driven = await page.evaluate(async () => {
		const s = window.__stores;
		// the roster the dropdown is going to offer
		s.userdata.set([['id-1', 'Ada', ''], ['id-2', 'Grace', ''], ['id-3', 'Alan', ''], ['id-4', 'Edsger', '']]);
		await window.__stores.moduleSDK.initModules([
			{
				id: 'rostermod',
				name: 'Roster',
				version: '1.0.0',
				description: 'the peer roster as an option list',
				register(api) {
					// a module VALUE NODE is the practical source of an option list: there is no
					// string socket type, so a `number` node would COERCE the list to 0 (measured -
					// the dropdown then offered one option called '0'). Pure function of its inputs,
					// the script-node rule; every peer derives the same list from the same roster.
					api.registerValueNode('peerlist', () => api.peerNames().map((p) => p.label).join(', '), {
						vtype: 'number'
					});
				}
			}
		]);
		await new Promise((r) => setTimeout(r, 400));
		let nodes;
		s.flowNodes.subscribe((v) => (nodes = v))();
		s.flowNodes.set([
			...nodes,
			{ id: 'list', type: 'peerlist', position: { x: 0, y: 200 }, data: { type: 'peerlist' } },
			{ id: 'setter', type: 'hudset', position: { x: 260, y: 200 }, data: { type: 'hudset', element: 'diff', value: 0 } }
		]);
		let edges;
		s.flowEdges.subscribe((v) => (edges = v))();
		s.flowEdges.set([...edges, { id: 'e4', source: 'list', target: 'setter', targetHandle: 'options' }]);
		await new Promise((r) => setTimeout(r, 1100));
		return {
			dom: [...document.querySelectorAll('[data-hud-id="diff"] option')].map((o) => o.value),
			live: s.flowRuntime.hudOptionsOf('diff', s.hudDocs.elementById('scene', 'diff')),
			authored: s.hudDocs.elementById('scene', 'diff').options
		};
	});
	h.check(
		driven.dom.join(',') === 'Ada,Grace,Alan,Edsger',
		`a wired list REPLACES the rendered options (${driven.dom.join(',')})`
	);
	h.check(
		driven.authored === 'Easy, Normal, Hard',
		`while the DOCUMENT keeps the authored list untouched (${JSON.stringify(driven.authored)})`
	);

	// the index read must follow the LIVE list, or a Switcher acts on a stale position
	const indexRead = await page.evaluate(async () => {
		const s = window.__stores;
		s.hudDocs.setHudValue('diff', 'Alan');
		let nodes;
		s.flowNodes.subscribe((v) => (nodes = v))();
		s.flowNodes.set([
			...nodes,
			{ id: 'read', type: 'hudinput', position: { x: 520, y: 200 }, data: { type: 'hudinput', element: 'diff', read: 'index', fallback: -1 } }
		]);
		await new Promise((r) => setTimeout(r, 1000));
		let values;
		s.flowValues.subscribe((v) => (values = v))();
		return { index: values.read, held: s.hudDocs.hudValueOf('diff') };
	});
	h.check(
		indexRead.index === 2,
		`hudinput's index read indexes into the LIVE list (Alan is 2 of the driven list, read ${indexRead.index})`
	);

	// a tabs element HOLDS the index, so the same read must answer it directly rather
	// than looking a number up in a list of words
	const tabsIndex = await page.evaluate(async () => {
		const s = window.__stores;
		s.hudDocs.addHudElement('scene', 'main', {
			id: 'pager',
			kind: 'tabs',
			options: 'Video, Audio, Controls',
			value: 0,
			anchor: 'bottom-right',
			x: 20,
			y: 20,
			w: 280,
			h: 30
		});
		s.hudDocs.setHudValue('pager', 2);
		let nodes;
		s.flowNodes.subscribe((v) => (nodes = v))();
		s.flowNodes.set([
			...nodes,
			{ id: 'ptab', type: 'hudinput', position: { x: 520, y: 340 }, data: { type: 'hudinput', element: 'pager', read: 'index', fallback: -1 } }
		]);
		await new Promise((r) => setTimeout(r, 1000));
		let values;
		s.flowValues.subscribe((v) => (values = v))();
		const on = document.querySelector('[data-hud-id="pager"] .hud-tab-on');
		return { index: values.ptab, selected: on?.textContent?.trim() ?? null, indexValued: s.hudKinds.isIndexValuedKind('tabs') };
	});
	h.check(tabsIndex.indexValued, 'the registry declares tabs index-valued, so nothing here lists kinds');
	h.check(
		tabsIndex.index === 2,
		`a tabs element's index read answers its held number directly (${tabsIndex.index})`
	);
	h.check(tabsIndex.selected === 'Controls', `and the right tab is drawn selected (${JSON.stringify(tabsIndex.selected)})`);

	// clicking a tab writes the index
	const tabClick = await page.evaluate(async () => {
		const btns = [...document.querySelectorAll('[data-hud-id="pager"] .hud-tab')];
		btns[0]?.click();
		await new Promise((r) => setTimeout(r, 500));
		return window.__stores.hudDocs.hudValueOf('pager');
	});
	h.check(tabClick === 0, `clicking a tab writes its index (${tabClick})`);

	// =====================================================================
	// 6. E7.3 — RICH TEXT, and the hostile string
	// =====================================================================
	const rich = await page.evaluate(async () => {
		const H = window.__stores.hudDocs;
		H.updateHudElement('scene', 'main', 'note', {
			label: 'plain **bold** *slanted* {color:#ff0000}red{/color} {icon:heart} end'
		});
		await new Promise((r) => setTimeout(r, 800));
		const root = document.querySelector('[data-hud-id="note"] .hud-rich');
		const bold = root?.querySelector('.hud-rich-b');
		const italic = root?.querySelector('.hud-rich-i');
		const coloured = [...(root?.querySelectorAll('.hud-rich-run') ?? [])].find((s) => s.textContent === 'red');
		const icon = root?.querySelector('.hud-rich-icon svg');
		return {
			text: root?.textContent?.trim() ?? null,
			boldWeight: bold ? getComputedStyle(bold).fontWeight : null,
			boldText: bold?.textContent ?? null,
			italicStyle: italic ? getComputedStyle(italic).fontStyle : null,
			colour: coloured ? getComputedStyle(coloured).color : null,
			icon: !!icon
		};
	});
	h.check(rich.boldText === 'bold' && Number(rich.boldWeight) >= 700, `**bold** renders bold (${rich.boldWeight})`);
	h.check(rich.italicStyle === 'italic', `*italic* renders italic (${rich.italicStyle})`);
	h.check(rich.colour === 'rgb(255, 0, 0)', `a {color:} span paints (${rich.colour})`);
	h.check(rich.icon, 'an {icon:} token renders a real lucide glyph');
	h.check(
		rich.text === 'plain bold slanted red  end' || /plain bold slanted red/.test(rich.text ?? ''),
		`and the markers themselves are gone from the text (${JSON.stringify(rich.text)})`
	);

	// THE COUNTERFACTUAL. This is the section that matters: the guard is not "the string
	// was cleaned up", it is "there is no HTML path at all", so the assertion is that NO
	// element was created and the characters survived verbatim.
	const hostile = await page.evaluate(async () => {
		const H = window.__stores.hudDocs;
		const payload = '<img src=x onerror="window.__pwned=1"> <b>bee</b> {color:javascript:alert(1)}x{/color} {icon:../../etc}';
		H.updateHudElement('scene', 'main', 'note', { label: payload });
		await new Promise((r) => setTimeout(r, 900));
		const root = document.querySelector('[data-hud-id="note"] .hud-rich');
		return {
			payload,
			text: root?.textContent ?? null,
			imgs: root?.querySelectorAll('img').length ?? -1,
			bolds: root?.querySelectorAll('b').length ?? -1,
			svgs: root?.querySelectorAll('svg').length ?? -1,
			pwned: !!window.__pwned,
			// a colour that is not a #hex or a plain token name must not reach a style
			styled: [...(root?.querySelectorAll('[style]') ?? [])].map((n) => n.getAttribute('style')).join('|')
		};
	});
	h.check(hostile.imgs === 0, `a hostile string creates NO <img> node (${hostile.imgs})`);
	h.check(hostile.bolds === 0, `and no <b> either — the markup is never parsed as HTML (${hostile.bolds})`);
	h.check(!hostile.pwned, 'nothing executed');
	h.check(
		(hostile.text ?? '').includes('<img src=x onerror="window.__pwned=1">') && (hostile.text ?? '').includes('<b>bee</b>'),
		`the characters are preserved as TEXT (${JSON.stringify((hostile.text ?? '').slice(0, 60))})`
	);
	h.check(
		hostile.svgs === 0 && !hostile.styled.includes('javascript'),
		`a rejected icon name and a rejected colour fall through to text (styles: ${JSON.stringify(hostile.styled)})`
	);
	// the parser itself, in isolation: an unrecognised brace body is one text run
	const parser = await page.evaluate(() => {
		const R = window.__stores.hudRichText;
		return {
			unknown: R.parseHudRichText('{wat:1}').map((r) => r.kind + ':' + (r.text ?? r.name)).join(' '),
			unclosedBrace: R.parseHudRichText('{color:#fff').map((r) => r.kind).join(' '),
			nested: R.parseHudRichText('{color:#f00}a{color:#0f0}b{/color}c{/color}')
				.filter((r) => r.kind === 'text')
				.map((r) => r.text + '=' + r.color)
				.join(' '),
			plain: R.hudRichTextPlain('**x** {icon:heart}\ny'),
			// must produce runs to prove the CAP: 1000 '*a*' groups is ~2000 text runs uncapped
			capped: R.parseHudRichText('*a*'.repeat(1000)).length,
			uncappedWouldBe: 1000 * 2
		};
	});
	h.check(parser.unknown === 'text:{wat:1}', `an unknown token is literal text (${parser.unknown})`);
	h.check(parser.unclosedBrace === 'text', `an unclosed brace is literal text (${parser.unclosedBrace})`);
	h.check(
		parser.nested === 'a=#f00 b=#0f0 c=#f00',
		`colours nest and POP back to the outer one (${parser.nested})`
	);
	h.check(parser.plain === 'x \ny', `the plain read strips the markers (${JSON.stringify(parser.plain)})`);
	h.check(
		parser.capped > 0 && parser.capped <= 400,
		`a pathological string is CAPPED, not merely empty (${parser.capped} runs, uncapped would be ~${parser.uncappedWouldBe})`
	);

	// =====================================================================
	// 6b. THE REGISTRY'S OWN INVARIANT: no duplicate field or style keys
	// =====================================================================
	// Both lists are rendered by KEYED each-blocks, and a duplicate key THROWS in svelte -
	// it took the whole properties pane down when `progressradial` listed STYLE.opacity
	// beside a TEXT_STYLE that already contained it. A crash on mount is invisible to every
	// store-reading check, so the invariant is asserted over the WHOLE registry rather than
	// per kind, which also covers every kind added later.
	const dupes = await page.evaluate(() => {
		const K = window.__stores.hudKinds;
		const bad = [];
		for (const def of K.HUD_KIND_DEFS) {
			for (const list of ['fields', 'style']) {
				const keys = (def[list] ?? []).map((f) => f.key);
				if (new Set(keys).size !== keys.length) bad.push(def.key + '.' + list + ': ' + keys.join(','));
			}
		}
		return bad;
	});
	h.check(dupes.length === 0, `every kind's field and style lists have UNIQUE keys (${dupes.join(' | ') || 'all clean'})`);

	// =====================================================================
	// 7. E7.6 — THE PACKS, looped FROM THE REGISTRY
	// =====================================================================
	const packKinds = ['minimap', 'iconrow', 'progressradial', 'hotbar', 'damageflash', 'keyhint', 'tabs', 'scrollpanel', 'confirm'];
	const packed = await page.evaluate(async (kinds) => {
		const H = window.__stores.hudDocs;
		const K = window.__stores.hudKinds;
		H.setHudDocFor('scene', {
			screens: [
				{
					id: 'pack',
					name: 'Pack',
					elements: kinds.map((kind, i) => ({
						...K.newElementOfKind(kind),
						id: 'p-' + kind,
						anchor: 'top-left',
						x: 10 + (i % 3) * 320,
						y: 10 + Math.floor(i / 3) * 200,
						// damageflash is stage-sized by default; shrink it so it cannot cover the rest
						w: kind === 'damageflash' ? 200 : undefined,
						h: kind === 'damageflash' ? 120 : undefined
					}))
				}
			],
			active: 'pack'
		});
		await new Promise((r) => setTimeout(r, 1200));
		return kinds.map((kind) => {
			const slot = document.querySelector(`[data-hud-id="p-${kind}"]`);
			const inner = slot?.querySelector('.hud-el');
			const box = inner?.getBoundingClientRect();
			return {
				kind,
				rendered: !!inner,
				// a kind whose renderer branch is MISSING renders nothing at all, which is what
				// this measures — a zero-size box is the failure mode
				sized: !!box && box.width > 1 && box.height > 1,
				fields: K.fieldsForKind(kind).length,
				group: K.kindDef(kind)?.group ?? null,
				defaultSize: K.kindDef(kind)?.defaultSize
			};
		});
	}, packKinds);
	for (const entry of packed) {
		h.check(
			entry.rendered && entry.sized,
			`${entry.kind}: renders a real box (${entry.rendered ? Math.round(entry.defaultSize.w) + 'x' + Math.round(entry.defaultSize.h) : 'MISSING'})`
		);
		h.check(entry.fields > 0, `${entry.kind}: declares its own parameters (${entry.fields})`);
	}
	h.check(
		packed.every((e) => ['Display', 'Input', 'Layout'].includes(e.group)),
		'every pack kind is filed under a real palette group'
	);

	// and the PANE renders those fields, registry-driven, with no per-kind UI code
	const paneRows = await page.evaluate(async (kinds) => {
		const s = window.__stores;
		s.hudEditorClose.set(false);
		await new Promise((r) => setTimeout(r, 900));
		const out = {};
		for (const kind of kinds) {
			const item = document.querySelector(`[data-hud-item="p-${kind}"]`);
			item?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
			window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
			await new Promise((r) => setTimeout(r, 450));
			const pane = document.querySelector('#hud-dock');
			const rows = [...(pane?.querySelectorAll('.hud-field') ?? [])].length;
			out[kind] = { rows, expect: s.hudKinds.fieldsForKind(kind).length };
		}
		s.hudEditorClose.set(true);
		await new Promise((r) => setTimeout(r, 600));
		return out;
	}, packKinds);
	for (const kind of packKinds) {
		const got = paneRows[kind];
		h.check(
			got.rows >= got.expect,
			`${kind}: the pane shows at least its ${got.expect} declared field rows (${got.rows} rows in all)`
		);
	}

	// the confirm element's two buttons fire the SUB-IDS, which is what the summary says
	const confirmFire = await page.evaluate(async () => {
		const s = window.__stores;
		s.flowNodes.set([
			{ id: 'yes', type: 'hudbutton', position: { x: 0, y: 0 }, data: { type: 'hudbutton', element: 'p-confirm-yes' } },
			{ id: 'no', type: 'hudbutton', position: { x: 0, y: 80 }, data: { type: 'hudbutton', element: 'p-confirm-no' } },
			{ id: 'cy', type: 'counter', position: { x: 200, y: 0 }, data: { type: 'counter', step: 1, op: 'up' } },
			{ id: 'cn', type: 'counter', position: { x: 200, y: 80 }, data: { type: 'counter', step: 1, op: 'up' } }
		]);
		s.flowEdges.set([
			{ id: 'y1', source: 'yes', target: 'cy', targetHandle: 'pulse' },
			{ id: 'n1', source: 'no', target: 'cn', targetHandle: 'pulse' }
		]);
		await new Promise((r) => setTimeout(r, 900));
		const subs = [...document.querySelectorAll('[data-hud-id="p-confirm"] [data-hud-sub]')].map((b) =>
			b.getAttribute('data-hud-sub')
		);
		document.querySelector('[data-hud-sub="p-confirm-yes"]')?.click();
		await new Promise((r) => setTimeout(r, 800));
		let values;
		s.flowValues.subscribe((v) => (values = v))();
		return { subs, yes: values.cy, no: values.cn, declared: s.hudKinds.subPressIds('confirm') };
	});
	h.check(
		confirmFire.subs.join(',') === 'p-confirm-yes,p-confirm-no',
		`confirm renders its two SUB-ID buttons from the registry (${confirmFire.subs.join(',')})`
	);
	h.check(confirmFire.declared.join(',') === 'yes,no', 'and the registry is the source of those ids');
	h.check(
		confirmFire.yes === 1 && (confirmFire.no ?? 0) === 0,
		`pressing Yes pulses the yes node only (yes=${confirmFire.yes}, no=${confirmFire.no})`
	);

	// the damage flash reacts to a PULSE, not to a value — and any HUD trigger pokes it
	const flash = await page.evaluate(async () => {
		const s = window.__stores;
		const before = document.querySelector('[data-hud-id="p-damageflash"] .hud-flash-run');
		let nodes;
		s.flowNodes.subscribe((v) => (nodes = v))();
		s.flowNodes.set([
			...nodes,
			{ id: 'hit', type: 'onclick', position: { x: 0, y: 300 }, data: { type: 'onclick', pulse: 0.3 } },
			{ id: 'poke', type: 'hudset', position: { x: 220, y: 300 }, data: { type: 'hudset', element: 'p-damageflash', value: 1 } }
		]);
		let edges;
		s.flowEdges.subscribe((v) => (edges = v))();
		s.flowEdges.set([...edges, { id: 'f1', source: 'hit', target: 'poke', targetHandle: 'trigger' }]);
		await new Promise((r) => setTimeout(r, 900));
		s.flowRuntime.applyNodeTrigger('hit', (Date.now() % 86400000) / 1000, true);
		await new Promise((r) => setTimeout(r, 700));
		const run = document.querySelector('[data-hud-id="p-damageflash"] .hud-flash-run');
		const cs = run ? getComputedStyle(run) : null;
		return {
			beforeExisted: !!before,
			after: !!run,
			animation: cs?.animationName ?? null,
			duration: cs?.animationDuration ?? null
		};
	});
	h.check(!flash.beforeExisted, 'the flash draws nothing until something pokes it');
	h.check(flash.after, 'a HUD trigger aimed at the element makes it flash');
	h.check(
		String(flash.animation).includes('hud-flash'),
		`and the decay is a CSS animation, so it costs no frames (${flash.animation} ${flash.duration})`
	);


	// a PACK kind must be bindable from the Actions section, or the loop is undiscoverable
	// all over again — which is the exact problem 21-D7 exists to solve, one kind list later.
	const packActions = await page.evaluate(() => {
		const A = window.__stores.hudActions;
		const out = {};
		for (const kind of ['iconrow', 'progressradial', 'hotbar', 'richtext', 'keyhint', 'scrollpanel', 'custom', 'tabs', 'confirm'])
			out[kind] = A.actionsForKind(kind).length;
		return { out, bound: A.HUD_BOUND_TYPES.includes('hudrows') };
	});
	for (const [kind, n] of Object.entries(packActions.out))
		h.check(
			kind === 'confirm' ? n === 0 : n > 0,
			kind === 'confirm'
				? `confirm is offered NO action, because its own id never fires — its sub-ids do (${n})`
				: `${kind}: the Actions section can bind it (${n} actions)`
		);
	h.check(packActions.bound, 'and a HUD Rows node counts as WIRED, so a filled list is not badged dead');

	// =====================================================================
	// 8. E7.5 — the USER-SCRIPTED element
	// =====================================================================
	const custom = await page.evaluate(async () => {
		const H = window.__stores.hudDocs;
		H.setHudDocFor('scene', {
			screens: [
				{
					id: 'code',
					name: 'Code',
					elements: [
						{ id: 'keep', kind: 'text', label: 'still here', anchor: 'top-left', x: 20, y: 20, w: 140, h: 24 },
						{
							id: 'cust',
							kind: 'custom',
							anchor: 'top-left',
							x: 20,
							y: 80,
							w: 220,
							h: 60,
							code: "container.textContent = 'made by code: ' + (el.w);"
						}
					]
				}
			],
			active: 'code'
		});
		await new Promise((r) => setTimeout(r, 1000));
		return {
			text: document.querySelector('[data-hud-id="cust"] .hud-custom-slot')?.textContent?.trim() ?? null,
			error: document.querySelector('[data-hud-id="cust"] .hud-code-error')?.textContent ?? null
		};
	});
	h.check(custom.text === 'made by code: 220', `a custom element renders what its code draws (${JSON.stringify(custom.text)})`);
	h.check(!custom.error, 'with no error chip');

	// HOT-APPLY: editing the code re-runs it with no remount
	const hot = await page.evaluate(async () => {
		window.__stores.hudDocs.updateHudElement('scene', 'code', 'cust', {
			code: "container.textContent = 'edited';"
		});
		await new Promise((r) => setTimeout(r, 800));
		return document.querySelector('[data-hud-id="cust"] .hud-custom-slot')?.textContent?.trim() ?? null;
	});
	h.check(hot === 'edited', `editing the code hot-applies (${JSON.stringify(hot)})`);

	// and the runtime reaches it, so a node can drive a custom element
	const customRuntime = await page.evaluate(async () => {
		const s = window.__stores;
		s.hudDocs.updateHudElement('scene', 'code', 'cust', {
			code: "container.textContent = 'v=' + (runtime && runtime.text);"
		});
		s.flowNodes.set([
			{ id: 'num', type: 'number', position: { x: 0, y: 0 }, data: { type: 'number', value: 7 } },
			{ id: 'ct', type: 'hudtext', position: { x: 200, y: 0 }, data: { type: 'hudtext', element: 'cust', format: '{v}', decimals: 0 } }
		]);
		s.flowEdges.set([{ id: 'c1', source: 'num', target: 'ct', targetHandle: 'value' }]);
		await new Promise((r) => setTimeout(r, 1100));
		return document.querySelector('[data-hud-id="cust"] .hud-custom-slot')?.textContent?.trim() ?? null;
	});
	h.check(customRuntime === 'v=7', `and a node's value reaches the render function (${JSON.stringify(customRuntime)})`);

	// A THROW MUST NOT TAKE THE LAYER DOWN. This is the containment check and it is the
	// reason the compile and the run are both wrapped: one bad character in one element
	// would otherwise unmount the whole HUD.
	const thrown = await page.evaluate(async () => {
		window.__stores.hudDocs.updateHudElement('scene', 'code', 'cust', {
			code: "throw new Error('boom');"
		});
		await new Promise((r) => setTimeout(r, 900));
		return {
			chip: document.querySelector('[data-hud-id="cust"] .hud-code-error')?.textContent?.trim() ?? null,
			layer: !!document.querySelector('#hud-layer'),
			sibling: document.querySelector('[data-hud-id="keep"] .hud-el')?.textContent?.trim() ?? null
		};
	});
	h.check(thrown.chip === 'code error', `a throwing render function renders an inert chip (${JSON.stringify(thrown.chip)})`);
	h.check(thrown.layer && thrown.sibling === 'still here', 'and the layer SURVIVES with its other elements intact');

	const syntax = await page.evaluate(async () => {
		window.__stores.hudDocs.updateHudElement('scene', 'code', 'cust', { code: 'this is not javascript {{{' });
		await new Promise((r) => setTimeout(r, 900));
		return {
			chip: !!document.querySelector('[data-hud-id="cust"] .hud-code-error'),
			layer: !!document.querySelector('#hud-layer'),
			sibling: document.querySelector('[data-hud-id="keep"] .hud-el')?.textContent?.trim() ?? null
		};
	});
	h.check(
		syntax.chip && syntax.layer && syntax.sibling === 'still here',
		'a COMPILE error behaves the same way — chip, layer intact'
	);

	// the pane offers a way in, and the artboard offers the double-click
	const codeDoor = await page.evaluate(async () => {
		const s = window.__stores;
		s.hudEditorClose.set(false);
		await new Promise((r) => setTimeout(r, 900));
		document.querySelector('[data-hud-item="cust"]')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
		window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
		await new Promise((r) => setTimeout(r, 700));
		const btn = document.querySelector('[data-hud-code="code"]');
		btn?.click();
		await new Promise((r) => setTimeout(r, 600));
		let target;
		s.fileWindows.textEditorTarget.subscribe((v) => (target = v))();
		const fromPane = !!target;
		s.fileWindows.textEditorTarget.set(null);
		await new Promise((r) => setTimeout(r, 300));
		// and the artboard's double-click, which is where you are looking at the element
		document.querySelector('[data-hud-item="cust"]')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
		await new Promise((r) => setTimeout(r, 600));
		s.fileWindows.textEditorTarget.subscribe((v) => (target = v))();
		const fromBoard = target ? String(target.title) : null;
		s.fileWindows.textEditorTarget.set(null);
		s.hudEditorClose.set(true);
		await new Promise((r) => setTimeout(r, 600));
		return { fromPane, fromBoard };
	});
	h.check(codeDoor.fromPane, 'the properties pane opens the shared code editor');
	h.check(
		!!codeDoor.fromBoard && codeDoor.fromBoard.includes('cust'),
		`and so does a double-click on the artboard (${JSON.stringify(codeDoor.fromBoard)})`
	);

	// =====================================================================
	// 9. E7.4 — a MODULE-supplied element kind
	// =====================================================================
	const modKind = await page.evaluate(async () => {
		window.__mod = { mounts: 0, updates: 0, cleanups: 0 };
		let kindName = null;
		await window.__stores.moduleSDK.initModules([
			{
				id: 'hudmod',
				name: 'HUD extras',
				version: '1.0.0',
				description: 'proves registerHudElement',
				register(api) {
					kindName = api.registerHudElement('gauge', {
						label: 'Gauge',
						icon: 'gauge',
						summary: 'a module gauge',
						defaultSize: { w: 150, h: 40 },
						defaults: { caption: 'Fuel' },
						fields: [{ key: 'caption', kind: 'text', label: 'caption' }],
						mount(container, el) {
							window.__mod.mounts++;
							const span = document.createElement('span');
							span.className = 'mod-gauge';
							span.textContent = 'GAUGE ' + (el.caption ?? '');
							container.append(span);
							return {
								update(next) {
									window.__mod.updates++;
									span.textContent = 'GAUGE ' + (next.caption ?? '');
								},
								destroy() {
									window.__mod.cleanups++;
								}
							};
						}
					});
				}
			}
		]);
		await new Promise((r) => setTimeout(r, 400));
		const K = window.__stores.hudKinds;
		return {
			kindName,
			renderable: K.isRenderableKind(kindName),
			builtinList: K.HUD_KINDS.includes(kindName),
			def: !!K.kindDef(kindName),
			fields: K.fieldsForKind(kindName).map((f) => f.key),
			defaults: K.defaultsForKind(kindName),
			paletteGroups: K.paletteGroups().map((g) => g.group)
		};
	});
	h.check(modKind.kindName === 'mod-hudmod-gauge', `the kind is NAMESPACED (${modKind.kindName})`);
	h.check(
		modKind.renderable && !modKind.builtinList,
		'it is RENDERABLE without joining HUD_KINDS — which is why the render test is isRenderableKind'
	);
	h.check(
		modKind.fields.join(',') === 'caption' && modKind.defaults.caption === 'Fuel',
		`its fields and defaults come through the same registry the built-ins use (${JSON.stringify(modKind.defaults)})`
	);
	h.check(
		modKind.paletteGroups.includes('HUD extras'),
		`and the palette files it under the MODULE (${modKind.paletteGroups.join(' · ')})`
	);

	const modRender = await page.evaluate(async (kind) => {
		const H = window.__stores.hudDocs;
		H.setHudDocFor('scene', {
			screens: [
				{
					id: 'mods',
					name: 'Mods',
					elements: [
						{ id: 'keep2', kind: 'text', label: 'sibling', anchor: 'top-left', x: 20, y: 20, w: 120, h: 24 },
						{ ...window.__stores.hudKinds.newElementOfKind(kind), id: 'g1', anchor: 'top-left', x: 20, y: 70 }
					]
				}
			],
			active: 'mods'
		});
		await new Promise((r) => setTimeout(r, 1000));
		const before = document.querySelector('[data-hud-id="g1"] .mod-gauge')?.textContent?.trim() ?? null;
		H.updateHudElement('scene', 'mods', 'g1', { caption: 'Shield' });
		await new Promise((r) => setTimeout(r, 800));
		return {
			before,
			after: document.querySelector('[data-hud-id="g1"] .mod-gauge')?.textContent?.trim() ?? null,
			moduleTag: document.querySelector('[data-hud-id="g1"] .hud-modkind')?.getAttribute('data-hud-module') ?? null,
			counts: { ...window.__mod }
		};
	}, modKind.kindName);
	h.check(modRender.before === 'GAUGE Fuel', `the module's own DOM renders inside a real element (${JSON.stringify(modRender.before)})`);
	h.check(modRender.moduleTag === 'hudmod', `tagged with its owner (${modRender.moduleTag})`);
	h.check(
		modRender.after === 'GAUGE Shield' && modRender.counts.updates >= 1 && modRender.counts.mounts === 1,
		`an edit calls UPDATE rather than remounting (mounts ${modRender.counts.mounts}, updates ${modRender.counts.updates})`
	);

	const modGone = await page.evaluate(async (kind) => {
		window.__stores.moduleSDK.deactivateModule('hudmod');
		await new Promise((r) => setTimeout(r, 1000));
		const K = window.__stores.hudKinds;
		const doc = window.__stores.hudDocs.hudDocOf('scene');
		const el = doc.screens.find((s) => s.id === 'mods').elements.find((e) => e.id === 'g1');
		return {
			registered: K.isRenderableKind(kind),
			cleanups: window.__mod.cleanups,
			// PRESERVED in the document, SKIPPED at render — the normalizeAnnotation rule
			stillInDoc: el?.kind === kind,
			keptCaption: el?.caption ?? null,
			rendered: !!document.querySelector('[data-hud-id="g1"] .mod-gauge'),
			sibling: document.querySelector('[data-hud-id="keep2"] .hud-el')?.textContent?.trim() ?? null,
			layer: !!document.querySelector('#hud-layer')
		};
	}, modKind.kindName);
	h.check(!modGone.registered && modGone.cleanups >= 1, `disabling the module unregisters and unmounts it (cleanups ${modGone.cleanups})`);
	h.check(
		modGone.stillInDoc && modGone.keptCaption === 'Shield',
		`while the element and its params stay in the DOCUMENT verbatim (${JSON.stringify(modGone.keptCaption)})`
	);
	h.check(
		!modGone.rendered && modGone.layer && modGone.sibling === 'sibling',
		'and it is simply not drawn — the layer and its siblings are untouched'
	);

	// =====================================================================
	// 10. E7.7 — style presets, as ONE undo entry
	// =====================================================================
	const preset = await page.evaluate(async () => {
		const H = window.__stores.hudDocs;
		const K = window.__stores.hudKinds;
		H.setHudDocFor('scene', {
			screens: [
				{
					id: 'style',
					name: 'Style',
					elements: [
						{ id: 's-text', kind: 'text', label: 'a', anchor: 'top-left', x: 20, y: 20 },
						{ id: 's-panel', kind: 'panel', label: '', anchor: 'top-left', x: 20, y: 60 },
						{ id: 's-cross', kind: 'crosshair', anchor: 'center', x: 0, y: 0 }
					]
				}
			],
			active: 'style'
		});
		await new Promise((r) => setTimeout(r, 700));
		return {
			presets: K.HUD_STYLE_PRESETS.map((p) => p.key),
			// the intersection is the drift-proof part: a crosshair declares colour and
			// opacity only, so it must NOT receive a background it cannot draw
			forCross: K.presetStyleFor('crosshair', 'scifi'),
			forPanel: Object.keys(K.presetStyleFor('panel', 'scifi')).sort().join(',')
		};
	});
	h.check(preset.presets.length >= 4, `there are presets (${preset.presets.join(', ')})`);
	h.check(
		!('bg' in preset.forCross) && 'color' in preset.forCross,
		`a preset is intersected with each KIND's own style fields (crosshair got ${JSON.stringify(Object.keys(preset.forCross))})`
	);
	h.check(
		preset.forPanel.includes('bg') && preset.forPanel.includes('radius'),
		`while a panel gets the whole set (${preset.forPanel})`
	);

	const applied = await page.evaluate(async () => {
		const s = window.__stores;
		// PREMISE: no HUD gesture may be open here, or beginHudGesture no-ops into a stale
		// one and the entry's `before` is whatever that gesture opened with. This is the
		// thing that made the first version of this section undo the wrong edit.
		const leaked = s.hudSync.hudGestureActive('scene');
		s.hudEditorClose.set(false);
		await new Promise((r) => setTimeout(r, 900));
		// the real UI path: right-click the board, walk into the preset submenu
		const board = document.querySelector('#hud-board');
		const box = board.getBoundingClientRect();
		board.dispatchEvent(
			new MouseEvent('contextmenu', {
				bubbles: true,
				clientX: Math.round(box.left + box.width - 24),
				clientY: Math.round(box.top + box.height - 24)
			})
		);
		await new Promise((r) => setTimeout(r, 600));
		const rows = [...document.querySelectorAll('[role="menu"] [role="menuitem"], [role="menu"] button, [role="menu"] div')];
		const opener = rows.find((r) => /Apply style/.test(r.textContent ?? ''));
		opener?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
		opener?.click();
		await new Promise((r) => setTimeout(r, 700));
		const all = [...document.querySelectorAll('[role="menu"] *')];
		const scifi = all.find((r) => (r.textContent ?? '').trim() === 'Sci-fi');
		const usedMenu = !!scifi;
		if (scifi) scifi.click();
		else {
			// the menu path is UI-shaped and can be defeated by chrome; the store path still
			// has to be proven, so fall back and SAY SO in the label
			s.hudDocs.hudSelection.set({});
		}
		await new Promise((r) => setTimeout(r, 900));
		const doc = s.hudDocs.hudDocOf('scene');
		const screen = doc.screens.find((sc) => sc.id === 'style');
		const styles = {};
		for (const el of screen.elements) styles[el.id] = { ...el.style };
		return { usedMenu, styles, leaked };
	});
	h.check(!applied.leaked, 'premise: no HUD gesture was left open by the earlier sections');
	h.check(applied.usedMenu, 'the Apply-style submenu is reachable from the board context menu');
	h.check(
		applied.styles['s-text']?.color === '#d8f6ff' && applied.styles['s-panel']?.bg === 'rgb(8 20 28 / 0.72)',
		`the preset lands on every element of the screen (${JSON.stringify(applied.styles['s-panel'])})`
	);
	h.check(
		applied.styles['s-cross']?.bg === undefined && applied.styles['s-cross']?.color === '#d8f6ff',
		`and a crosshair takes only what it can draw (${JSON.stringify(applied.styles['s-cross'])})`
	);

	// ONE UNDO. Asserted as a PROPERTY, not as a stack depth: recordEntry's LIMIT trim
	// evicts the oldest, so a correct gesture can legitimately leave the depth unchanged.
	const undone = await page.evaluate(async () => {
		window.__stores.history.undo();
		await new Promise((r) => setTimeout(r, 800));
		const doc = window.__stores.hudDocs.hudDocOf('scene');
		const screen = doc.screens.find((sc) => sc.id === 'style');
		const styles = {};
		for (const el of screen.elements) styles[el.id] = { ...el.style };
		window.__stores.history.redo();
		await new Promise((r) => setTimeout(r, 800));
		const after = window.__stores.hudDocs.hudDocOf('scene').screens.find((sc) => sc.id === 'style');
		const redone = {};
		for (const el of after.elements) redone[el.id] = { ...el.style };
		window.__stores.hudEditorClose.set(true);
		await new Promise((r) => setTimeout(r, 500));
		return { styles, redone };
	});
	h.check(
		undone.styles['s-text']?.color !== '#d8f6ff' && undone.styles['s-panel']?.bg !== 'rgb(8 20 28 / 0.72)',
		`ONE undo reverts the whole screen restyle (${JSON.stringify(undone.styles['s-panel'])})`
	);
	h.check(
		undone.redone['s-panel']?.bg === 'rgb(8 20 28 / 0.72)',
		`and redo puts it back — the history kind reads its direction by identity (${JSON.stringify(undone.redone['s-panel']?.bg)})`
	);

	h.check(h.pageErrors(A).length === 0, `no render crash anywhere in the run (${h.pageErrors(A).join(' | ') || 'clean'})`);

	// =====================================================================
	// 11. TWO PEERS — GOLDEN RULE 8: rows CONVERGE with NO new message type
	// =====================================================================
	const B = await h.setupPage(browser, 'B');
	await B.page.waitForFunction(() => !!window.__stores?.hudRichText, { timeout: 30000 });
	await h.connect(A, B);

	await page.evaluate(() => {
		const s = window.__stores;
		s.hudDocs.setHudDocFor('scene', {
			screens: [
				{
					id: 'main',
					name: 'Main',
					elements: [{ id: 'lb', kind: 'list', title: 'Board', rowsText: '', anchor: 'top-left', x: 20, y: 20, w: 200, h: 140 }]
				}
			],
			active: 'main'
		});
		s.flowNodes.set([
			{ id: 'tick2', type: 'onclick', position: { x: 0, y: 0 }, data: { type: 'onclick', pulse: 0.3 } },
			{ id: 'n2', type: 'counter', position: { x: 200, y: 0 }, data: { type: 'counter', step: 1, op: 'up' } },
			{ id: 'rows2', type: 'hudrows', position: { x: 400, y: 0 }, data: { type: 'hudrows', element: 'lb', op: 'append', text: '' } }
		]);
		s.flowEdges.set([
			{ id: 'g1', source: 'tick2', target: 'n2', targetHandle: 'pulse' },
			{ id: 'g2', source: 'tick2', target: 'rows2', targetHandle: 'trigger' },
			{ id: 'g3', source: 'n2', target: 'rows2', targetHandle: 'text' }
		]);
	});
	// setting the stores directly does NOT broadcast — push, and WAIT for the peer to hold
	// it, or a pulse can land before the graph does (the documented racy failure)
	await page.evaluate((peerId) => window.__stores.nodesHandler.sendNodes(peerId), B.id);
	let peerHasGraph = false;
	for (let i = 0; i < 40; i++) {
		peerHasGraph = await B.page.evaluate(() => {
			let nodes;
			window.__stores.flowNodes.subscribe((v) => (nodes = v))();
			return nodes.some((n) => n.id === 'rows2');
		});
		if (peerHasGraph) break;
		await B.page.waitForTimeout(250);
	}
	h.check(peerHasGraph, 'premise: the peer holds the graph before anything is pulsed');
	let peerHasDoc = false;
	for (let i = 0; i < 30; i++) {
		peerHasDoc = await B.page.evaluate(() => !!window.__stores.hudDocs.elementById('scene', 'lb'));
		if (peerHasDoc) break;
		await B.page.waitForTimeout(250);
	}
	h.check(peerHasDoc, 'premise: and the HUD document');

	// RECORD every message A sends across the pulses. The claim is that this whole feature
	// adds no runtime message type, so the evidence is the set of types that actually went
	// out — nothing about rows may appear in it.
	const sent = await page.evaluate(async () => {
		const s = window.__stores;
		let peer;
		s.peers.subscribe((v) => (peer = v))();
		const seen = [];
		const real = peer.send.bind(peer);
		peer.send = (msg) => {
			seen.push(msg?.type);
			return real(msg);
		};
		for (let i = 0; i < 3; i++) {
			s.flowRuntime.applyNodeTrigger('tick2', (Date.now() % 86400000) / 1000, true);
			await new Promise((r) => setTimeout(r, 400));
		}
		await new Promise((r) => setTimeout(r, 900));
		peer.send = real;
		return { types: [...new Set(seen)], count: seen.length };
	});
	h.check(
		sent.types.length > 0 && sent.types.every((t) => t === 'nodetrigger'),
		`the only thing that went on the wire is the existing nodetrigger (${JSON.stringify(sent.types)})`
	);
	h.check(
		!sent.types.some((t) => String(t).includes('row')),
		'and NOTHING about rows — golden rule 8: the rows are derived, not sent'
	);

	await B.page.waitForTimeout(1200);
	const mine = await rowsOf(A, 'lb');
	const theirs = await rowsOf(B, 'lb');
	h.check(mine.length === 3, `the author holds three rows (${JSON.stringify(mine)})`);
	h.check(
		theirs.join('|') === mine.join('|'),
		`and the PEER derived the identical list from the replicated stamps (${JSON.stringify(theirs)})`
	);

	// and a document naming an unknown MODULE kind round-trips through a bare peer, which
	// is the same story a disabled module tells — the fallback belongs to the format
	const bare = await page.evaluate(async () => {
		const H = window.__stores.hudDocs;
		H.setHudDocFor('scene', {
			screens: [
				{
					id: 'main',
					name: 'Main',
					elements: [
						{ id: 'plain', kind: 'text', label: 'ok', anchor: 'top-left', x: 20, y: 20 },
						{ id: 'exotic', kind: 'mod-someoneelse-widget', anchor: 'top-left', x: 20, y: 80, w: 150, h: 40, tuning: 42 }
					]
				}
			],
			active: 'main'
		});
		await new Promise((r) => setTimeout(r, 900));
		return true;
	});
	h.check(bare, 'premise: a doc naming a module kind this build never had was authored');
	await B.page.waitForTimeout(2000);
	const onBare = await B.page.evaluate(() => {
		const el = window.__stores.hudDocs.elementById('scene', 'exotic');
		return {
			kind: el?.kind ?? null,
			extra: el?.tuning ?? null,
			renderedExotic: !!document.querySelector('[data-hud-id="exotic"]'),
			renderedPlain: !!document.querySelector('[data-hud-id="plain"]'),
			layer: !!document.querySelector('#hud-layer')
		};
	});
	h.check(
		onBare.kind === 'mod-someoneelse-widget' && onBare.extra === 42,
		`a peer without the module keeps the element and its params VERBATIM (${JSON.stringify(onBare)})`
	);
	h.check(
		!onBare.renderedExotic && onBare.renderedPlain && onBare.layer,
		'skipped at render, never deleted — so installing the module makes it appear'
	);

	// the round trip: the bare peer EDITS the doc and the unknown element survives back
	await B.page.evaluate(() =>
		window.__stores.hudDocs.updateHudElement('scene', 'main', 'plain', { label: 'edited by the bare peer' })
	);
	await page.waitForTimeout(2000);
	const backHome = await page.evaluate(() => {
		const el = window.__stores.hudDocs.elementById('scene', 'exotic');
		const plain = window.__stores.hudDocs.elementById('scene', 'plain');
		return { kind: el?.kind ?? null, extra: el?.tuning ?? null, label: plain?.label ?? null };
	});
	h.check(
		backHome.label === 'edited by the bare peer',
		`the bare peer's edit replicates back (${JSON.stringify(backHome.label)})`
	);
	h.check(
		backHome.kind === 'mod-someoneelse-widget' && backHome.extra === 42,
		'and rode the unknown element through its editor untouched (the normalizeAnnotation rule)'
	);

	h.check(
		h.pageErrors(A).length === 0 && h.pageErrors(B).length === 0,
		`no render crash on either peer (${[...h.pageErrors(A), ...h.pageErrors(B)].join(' | ') || 'clean'})`
	);

	await h.finish(browser);
});

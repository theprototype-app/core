// The bridge's chat helpers (roadmap 56): wait clamps, the image spool, import_model's local path.
// Run: node test/chat.test.mjs
import { mkdtempSync, writeFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitMs, ImageSpool, messageContent, withImportPath, importModelArgs, importFileCalls, sniffImportKind, execBridged, IMPORT_FILE_CAPS, chatTools, CHAT_TOOL_NAMES } from '../src/chat.js';

let pass = 0;
let fail = 0;
const check = (name, cond) => {
	if (cond) {
		pass++;
		console.log('PASS ' + name);
	} else {
		fail++;
		console.log('FAIL ' + name);
	}
};
const throws = (fn, re) => {
	try {
		fn();
		return false;
	} catch (e) {
		return re.test(e.message);
	}
};

check('chat tools: the four names, each with an object schema', chatTools().map((t) => t.name).join() === CHAT_TOOL_NAMES.join() && chatTools().every((t) => t.inputSchema.type === 'object'));
check('waitMs: default 240 s', waitMs(undefined) === 240000 && waitMs('x') === 240000);
check('waitMs: clamped to 1..600 s', waitMs(0.2) === 1000 && waitMs(9999) === 600000 && waitMs(30) === 30000);

// --- the spool ---
const root = join(mkdtempSync(join(tmpdir(), 'tpa-')), 'spool');
const spool = new ImageSpool({ root });
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const p = spool.write('../../etc', 'm/1', 1, { mimeType: 'image/jpeg', data: PNG });
check('spool: ids cannot climb out of the spool', p.startsWith(root + '/') && !p.includes('..'.concat('/')) && p.endsWith('m_1-1.jpg'));
check('spool: dir 0700, file 0600', (statSync(join(root)).mode & 0o777) === 0o700 && (statSync(p).mode & 0o777) === 0o600);
const content = messageContent({ id: 'm1', chatId: 'c1', from: 'a', role: 'editor', text: 'x', images: [{ mimeType: 'image/png', data: PNG }, { mimeType: 'image/png' }] }, spool);
check('messageContent: one block per real image, JSON first', content.length === 2 && content[1].type === 'image' && JSON.parse(content[0].text).images.length === 1);
check('messageContent without a spool: no path, still the block', !JSON.parse(messageContent({ id: 'm', chatId: 'c', images: [{ mimeType: 'image/png', data: PNG }] }, null)[0].text).images[0].path);
spool.cleanup();
check('spool: cleanup removes everything', !existsSync(root));

// --- import_model ---
const host = { name: 'import_model', description: 'Import a GLB.', inputSchema: { type: 'object', properties: { data: { type: 'string' }, url: { type: 'string' } } } };
const aug = withImportPath(host);
check('withImportPath: adds path, keeps the host fields', !!aug.inputSchema.properties.path && !!aug.inputSchema.properties.data && /path/.test(aug.description));
check('withImportPath: leaves the host schema object untouched', !host.inputSchema.properties.path);
check('withImportPath: other tools untouched', withImportPath({ name: 'x', inputSchema: {} }).inputSchema.properties === undefined);
const dir = mkdtempSync(join(tmpdir(), 'tpa-glb-'));
const glb = Buffer.alloc(32);
glb.write('glTF', 0, 'latin1');
writeFileSync(join(dir, 'Tree.glb'), glb);
writeFileSync(join(dir, 'fake.glb'), Buffer.from('not a model at all'));
const ok = importModelArgs({ path: join(dir, 'Tree.glb'), position: [1, 0, 0] });
check('import_model path → data (base64), name from the file, path gone', ok.data === glb.toString('base64') && ok.name === 'Tree' && !('path' in ok) && ok.position[0] === 1);
check('import_model: explicit name wins', importModelArgs({ path: join(dir, 'Tree.glb'), name: 'Oak' }).name === 'Oak');
check('import_model: not a GLB → refused before anything is sent', throws(() => importModelArgs({ path: join(dir, 'fake.glb') }), /not a binary glTF/));
check('import_model: missing file → readable', throws(() => importModelArgs({ path: join(dir, 'nope.glb') }), /cannot read/));
check('import_model: over 25 MB → refused without reading', throws(() => importModelArgs({ path: 'big.glb' }, { size: () => 26 * 1048576, read: () => { throw new Error('read'); } }), /limit is 25 MB/));
check('import_model: path + data → refused', throws(() => importModelArgs({ path: join(dir, 'Tree.glb'), data: 'AAAA' }), /one of path/));
check('import_model without path passes through untouched', JSON.stringify(importModelArgs({ url: 'https://x/y.glb' })) === '{"url":"https://x/y.glb"}');
// --- import_file (roadmap 66 S4b) ---
const fdir = mkdtempSync(join(tmpdir(), 'tpa-file-'));
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 7)]);
writeFileSync(join(fdir, 'knight_walk.png'), png);
writeFileSync(join(fdir, 'knight.json'), '{"name":"knight","clips":["walk"]}');
writeFileSync(join(fdir, 'bad.json'), '{"name":');
writeFileSync(join(fdir, 'photo.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]));
writeFileSync(join(fdir, 'sheet.png.txt'), png); // the name lies; the bytes decide
check('sniff: PNG / WebP / glTF / JSON by bytes', sniffImportKind(png) === 'image' && sniffImportKind(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1')) === 'image' && sniffImportKind(glb) === 'clip' && sniffImportKind(Buffer.from('\uFEFF  [1]')) === 'json');
check('sniff: JPEG / text → null', sniffImportKind(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])) === null && sniffImportKind(Buffer.from('hello')) === null);
const one = importFileCalls({ path: join(fdir, 'knight_walk.png'), spec_path: join(fdir, 'knight.json'), filter: 'nearest' });
check('import_file path → ONE call: data, name from the file, spec parsed, paths gone', one.length === 1 && one[0].data === png.toString('base64') && one[0].name === 'knight_walk' && one[0].spec.name === 'knight' && one[0].filter === 'nearest' && !('path' in one[0]) && !('spec_path' in one[0]));
check('import_file: type from bytes, not the name', importFileCalls({ path: join(fdir, 'sheet.png.txt') })[0].data === png.toString('base64'));
check('import_file: JPEG refused before anything is sent', throws(() => importFileCalls({ path: join(fdir, 'photo.jpg') }), /not a PNG, WebP, JSON or \.tpanim/));
check('import_file: broken spec_path → readable', throws(() => importFileCalls({ path: join(fdir, 'knight_walk.png'), spec_path: join(fdir, 'bad.json') }), /bad\.json is not JSON/));
check('import_file: spec + spec_path → refused', throws(() => importFileCalls({ spec: {}, spec_path: join(fdir, 'knight.json') }), /one of spec or spec_path/));
check('import_file: path + data → refused', throws(() => importFileCalls({ path: join(fdir, 'knight_walk.png'), data: 'AAAA' }), /one of path or data/));
check('import_file: missing file → readable', throws(() => importFileCalls({ path: join(fdir, 'nope.png') }), /cannot read/));
check('import_file: over every cap → refused without reading', throws(() => importFileCalls({ path: 'big.png' }, { size: () => 26 * 1048576, read: () => { throw new Error('read'); } }), /limit for any file is 25 MB/));
const bigJson = Buffer.from('[' + '0,'.repeat(1100000) + '0]');
check('import_file: JSON over 2 MB → the JSON cap', throws(() => importFileCalls({ path: 'x.json' }, { size: () => bigJson.length, read: () => bigJson }), /limit for a JSON file is 2 MB/));
const bigPng = Buffer.concat([png, Buffer.alloc(IMPORT_FILE_CAPS.image)]);
check('import_file: image over 16 MB → the image cap', throws(() => importFileCalls({ path: 'x.png' }, { size: () => bigPng.length, read: () => bigPng }), /limit for an image is 16 MB/));
const parts = importFileCalls({ path: join(fdir, 'knight_walk.png'), folder: 'Sprites' }, { chunkChars: 42, id: 'up1' });
check('import_file: chunked — whole quads, same id, args on the LAST part only', parts.length === 2 && parts.every((c, i) => c.chunk.id === 'up1' && c.chunk.index === i && c.chunk.total === 2) && parts[0].data.length === 40 && !parts[0].folder && parts[1].folder === 'Sprites' && parts[1].name === 'knight_walk' && parts.map((c) => c.data).join('') === png.toString('base64'));
check('import_file without path passes through (data / spec untouched)', JSON.stringify(importFileCalls({ data: 'AAAA', spec: { a: 1 } })) === '[{"data":"AAAA","spec":{"a":1}}]');
/** @type {any[]} */
const sent = [];
const fakeEngine = { exec: async (/** @type {string} */ n, /** @type {any} */ a) => (sent.push([n, a]), a.chunk && a.chunk.index < a.chunk.total - 1 ? { partial: true } : { file: 'Generated/' + a.name + '.png' }) };
const done = await execBridged(fakeEngine, 'import_file', { path: join(fdir, 'knight_walk.png') });
check('execBridged import_file: one exec, the page answer back', sent.length === 1 && done.file === 'Generated/knight_walk.png');
sent.length = 0;
const refusing = { exec: async (/** @type {string} */ n, /** @type {any} */ a) => (sent.push([n, a]), { error: 'view-only', refused: true }) };
const r2 = await execBridged(refusing, 'import_file', { path: join(fdir, 'knight_walk.png') });
check('execBridged: the page refusal comes back (viewer)', r2.refused === true && sent.length === 1);
sent.length = 0;
await execBridged(fakeEngine, 'import_model', { path: join(dir, 'Tree.glb') });
check('execBridged import_model: path read into data', sent[0][1].data === glb.toString('base64'));
sent.length = 0;
await execBridged(fakeEngine, 'add_object', { type: 'box' });
check('execBridged: other tools untouched', sent[0][0] === 'add_object' && sent[0][1].type === 'box');
rmSync(fdir, { recursive: true, force: true });
rmSync(dir, { recursive: true, force: true });

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

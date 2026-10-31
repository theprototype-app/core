import { describe, it, expect, beforeAll } from 'vitest';
import { loadSandbox } from '../../src/lib/sandbox/engine.js';
import { renderCustomInGuest } from '../../src/lib/sandbox/hud.js';

// 69 T1: a HUD custom element's render function runs in the guest against a DOM proxy; what comes
// out is a plain tree (the host rebuilds it through sanitize.js — covered by the e2e, it needs a DOM).

beforeAll(async () => {
	await loadSandbox();
});

describe('HUD custom element in the guest', () => {
	it('textContent, nested elements, styles, classes and the runtime', () => {
		const out = renderCustomInGuest(
			`container.style.background = 'red';
			 const b = document.createElement('b'); b.className = 'big'; b.textContent = 'v=' + runtime.text + ' w=' + el.w;
			 b.style.fontSize = '12px'; container.append('pre ', b);`,
			{ w: 220 },
			{ text: 7 }
		);
		expect(out).toEqual({
			style: 'background: red',
			nodes: [{ x: 'pre ' }, { t: 'b', a: { class: 'big', style: 'font-size: 12px' }, c: [{ x: 'v=7 w=220' }] }]
		});
	});

	it('innerHTML travels as a raw string (the host sanitises it); a canvas records its calls', () => {
		const out = renderCustomInGuest(
			`container.innerHTML = '<i>hi</i><img src=x onerror=alert(1)>';
			 const c = document.createElement('canvas'); c.width = 20; c.height = 10;
			 const g = c.getContext('2d'); g.fillStyle = '#f00'; g.fillRect(0, 0, 5, 5);
			 container.appendChild(c);`,
			{},
			{}
		);
		expect(out?.nodes?.[0]).toEqual({ h: '<i>hi</i><img src=x onerror=alert(1)>' });
		expect(out?.nodes?.[1]).toEqual({ t: 'canvas', a: { width: '20', height: '10' }, c: [], cmd: [['=', 'fillStyle', '#f00'], ['fillRect', [0, 0, 5, 5]]] });
	});

	it('a throw is an error, not a crash; hostile reads find a proxy document and nothing else', () => {
		expect(renderCustomInGuest("throw new Error('boom')", {}, {})).toEqual({ error: 'boom' });
		const out = renderCustomInGuest(
			`container.textContent = ['window','localStorage','fetch','XMLHttpRequest','navigator','location','parent','top','cookie']
				.filter((k) => typeof globalThis[k] !== 'undefined' || typeof document[k] !== 'undefined').join(',') || 'none';`,
			{},
			{}
		);
		expect(out?.nodes).toEqual([{ x: 'none' }]);
	});
});

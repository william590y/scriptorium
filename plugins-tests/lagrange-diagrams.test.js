// Unit tests for Lagrange's diagrams (1.5.0): Mermaid blocks in a note, the order a diagram is drawn in, what the
// model is told, sketches given as Mermaid, and the demo's Mermaid diagram. What needs Obsidian (the pen drawing a
// diagram, the chat's ink, a Mermaid diagram turned into an Excalidraw drawing) is checked by
// plugins-tests/diagrams.harness.js in a real Obsidian.
//
// Run from the repository root:   node --test plugins-tests/lagrange-diagrams.test.js
//
// Copyright (C) 2026 William Liaw. GNU General Public License, version 3 or later (see LICENSE).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.resolve(__dirname, '..');
function stubModule() {
  return new Proxy({}, { get(target, key) { if (!(key in target)) target[key] = class { static define() { return {}; } }; return target[key]; } });
}
const stubs = { obsidian: stubModule(), '@codemirror/state': stubModule(), '@codemirror/view': stubModule(), '@codemirror/commands': stubModule() };
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return realLoad.call(this, request, parent, isMain);
};
const L = require(path.join(ROOT, 'vault', '.obsidian', 'plugins', 'lagrange', 'main.js')).internals;
Module._load = realLoad;

const FLOW = '```mermaid\nflowchart LR\n  A[Start] --> B{Is it?}\n  B -->|Yes| C[OK]\n```';

test('Mermaid blocks: counted with the other diagrams, taken out of what the pen writes by hand, found with their source', () => {
  assert.deepEqual(L.figureKinds(`Before.\n\n${FLOW}\n\nAfter.`), { tikz: 0, sketch: 0, mermaid: 1 });
  assert.deepEqual(L.figureKinds('~~~mermaid\ngraph TD\n  a-->b\n~~~\n\n````mermaid\npie\n  "a" : 1\n````'), { tikz: 0, sketch: 0, mermaid: 2 });
  assert.deepEqual(L.figureKinds('```js\nconst mermaid = 1;\n```\n\nthe word mermaid'), { tikz: 0, sketch: 0, mermaid: 0 }, 'only a block fenced as mermaid');
  assert.deepEqual(L.figureKinds('```mermaid\nflowchart LR\n  a --> b'), { tikz: 0, sketch: 0, mermaid: 0 }, 'a block that is not closed is not a diagram yet');
  assert.equal(L.withoutFigures(`Before.\n\n${FLOW}\n\nAfter.`), 'Before.\n\n\n\nAfter.');
  const text = `# T\n\nOne.\n\n${FLOW}\n\nTwo.\n\n~~~mermaid\nsequenceDiagram\n  A->>B: hi\n~~~\n`;
  const blocks = L.mermaidBlocks(text);
  assert.equal(blocks.length, 2);
  assert.equal(text.slice(blocks[0].from, blocks[0].to), FLOW);
  assert.equal(blocks[0].source, 'flowchart LR\n  A[Start] --> B{Is it?}\n  B -->|Yes| C[OK]');
  assert.equal(blocks[1].source, 'sequenceDiagram\n  A->>B: hi');
  assert.ok(text.slice(blocks[1].from, blocks[1].to).startsWith('~~~mermaid') && text.slice(blocks[1].from, blocks[1].to).endsWith('~~~'));
  assert.deepEqual(L.mermaidBlocks(''), []);
});

test('mermaidState: drawn, failed (Obsidian wrote what is wrong) or still waiting', () => {
  const block = (svg, text) => ({ querySelector: q => (q === '.mermaid' ? { querySelector: () => (svg ? {} : null), textContent: text || '' } : null) });
  assert.equal(L.mermaidState(block(true)), 'drawn');
  assert.equal(L.mermaidState(block(false, 'Parse error on line 2')), 'failed');
  assert.equal(L.mermaidState(block(false, '  ')), 'waiting');
  assert.equal(L.mermaidState({ querySelector: () => null }), 'waiting');
  assert.equal(L.mermaidState(null), 'waiting');
});

/* The parts of the flowchart above as Obsidian 1.15 draws it (probed): edges first in the svg, then their labels,
   then the nodes, each node a shape and its words. */
const part = (kind, id, text, footer) => ({ kind, id, text: Boolean(text), footer: Boolean(footer) });
const FLOW_PARTS = [
  part('edge', 'L_A_B_0'), part('edge', 'L_A_B_0'),               // 0 1: the line and its arrowhead
  part('edge', 'L_B_C_0'), part('edge', 'L_B_C_0'),               // 2 3
  part('edge', 'L_B_D_0'), part('edge', 'L_B_D_0'),               // 4 5
  part('label', 'L_B_C_0'), part('label', 'L_B_C_0', true),       // 6 7: "Yes", its box and its word
  part('node', 'A'), part('node', 'A', true),                     // 8 9
  part('node', 'B'), part('node', 'B', true),                     // 10 11
  part('node', 'C'), part('node', 'C', true),                     // 12 13
  part('node', 'D'), part('node', 'D', true),                     // 14 15
];

test('diagramOrder: a flowchart grows from its first node, each edge and its label before the node it reaches', () => {
  const order = L.diagramOrder(FLOW_PARTS);
  assert.deepEqual(order, [8, 9, 0, 1, 10, 11, 2, 3, 6, 7, 12, 13, 4, 5, 14, 15]);
  assert.deepEqual(order.slice().sort((a, b) => a - b), FLOW_PARTS.map((p, i) => i), 'every part once');
  // the shape of a node before its words, whatever the svg's order
  const swapped = L.diagramOrder([part('node', 'A', true), part('node', 'A')]);
  assert.deepEqual(swapped, [1, 0]);
});

test('diagramOrder: nodes nothing reaches start again; ids with underscores; a cycle; loose parts first and last', () => {
  // two separate pieces: X -> Y, then Z alone
  const two = [part('edge', 'L_X_Y_0'), part('node', 'X'), part('node', 'Y'), part('node', 'Z')];
  assert.deepEqual(L.diagramOrder(two), [1, 0, 2, 3]);
  // node ids with underscores: "L_my_a_my_b_0" is my_a -> my_b
  const under = [part('edge', 'L_my_a_my_b_0'), part('node', 'my_b'), part('node', 'my_a')];
  assert.deepEqual(L.diagramOrder(under), [1, 2, 0], 'the edge waits for the node it leaves');
  // an edge that comes back to where it began
  const cyc = [part('edge', 'L_A_B_0'), part('edge', 'L_B_A_0'), part('node', 'A'), part('node', 'B')];
  assert.deepEqual(L.diagramOrder(cyc), [2, 0, 3, 1]);
  // parts that belong to nothing: shapes first, words last
  const loose = [part('', '', true), part('', ''), part('node', 'A')];
  assert.deepEqual(L.diagramOrder(loose), [1, 2, 0]);
  assert.deepEqual(L.diagramOrder([]), []);
  assert.deepEqual(L.diagramOrder(null), []);
});

test('diagramOrder: a sequence draws its actors, their lifelines, the messages in order, then the copies at the foot', () => {
  const seq = [
    part('line', 'Alice'), part('line', 'Bob'),                                  // 0 1
    part('edge', 'i1'), part('edge', 'i1'), part('edge', 'i0'), part('edge', 'i0'),   // 2 3 4 5 (the svg may hold them out of order)
    part('label', 'i0', true), part('label', 'i1', true),                         // 6 7
    part('node', 'Alice', false, true), part('node', 'Alice', true, true),        // 8 9: the foot
    part('node', 'Alice'), part('node', 'Alice', true),                           // 10 11
    part('node', 'Bob'), part('node', 'Bob', true),                               // 12 13
  ];
  assert.deepEqual(L.diagramOrder(seq), [10, 11, 12, 13, 0, 1, 4, 5, 6, 2, 3, 7, 8, 9]);
});

test('diagramOrder: other diagrams (states with edges not named by their ends, pies, Gantt charts) keep the svg order, group by group', () => {
  const pie = [part('other', 's1'), part('other', 's1', true), part('other', 's2'), part('other', 'k1', true)];
  assert.deepEqual(L.diagramOrder(pie), [0, 1, 2, 3]);
  const states = [part('edge', 't0'), part('node', 'Still'), part('node', 'Still', true), part('node', 'Moving'), part('cluster', 'c')];
  assert.deepEqual(L.diagramOrder(states), [4, 1, 2, 3, 0], 'boxes around first, then the nodes, then the edges');
});

test('What the model is told: Mermaid always (no plugin needed), with the kinds Obsidian 1.15 draws and how to keep a block readable', () => {
  for (const have of [{}, { tikz: true }, { sketch: true }, { tikz: true, sketch: true }]) {
    const told = L.diagramStyle(have);
    assert.match(told, /```mermaid/);
    assert.match(told, /Obsidian draws itself, with no plugin/);
    assert.match(told, /flowchart LR \(or TD\), sequenceDiagram, stateDiagram-v2, classDiagram, erDiagram, timeline, gantt, mindmap, pie/);
    assert.match(told, /in double quotes/);
    assert.match(told, /shows its error/);
  }
  assert.match(L.diagramStyle({ tikz: true, sketch: true }), /Use Mermaid for flow and structure, TikZ where mathematical exactness matters/);
  assert.match(L.diagramStyle({ sketch: true }), /"mermaid": "flowchart LR\\n/, 'a sketch may be given as a Mermaid flowchart');
  assert.doesNotMatch(L.diagramStyle({ tikz: true }), /"mermaid":/, 'not where Excalidraw is off');
  assert.match(L.diagramStyle({}), /offer a Mermaid diagram where it would serve/);
});

test('A sketch may be a Mermaid diagram: kept (fence taken off, cut to its limit), and elements win where both are given', () => {
  const op = item => L.parseAgentReply('```lagrange-edits\n' + JSON.stringify([item]) + '\n```').ops[0];
  const m = op({ insert_after: 'x', sketch: { name: 'Flow', mermaid: '```mermaid\nflowchart LR\n  A --> B\n```' } });
  assert.equal(m.op, 'insert');
  assert.deepEqual(m.sketch, { name: 'Flow', elements: [], mermaid: 'flowchart LR\n  A --> B' });
  const both = op({ sketch: { name: 'B', mermaid: 'flowchart LR\n  A-->B', elements: [{ type: 'rect', x: 0, y: 0, w: 10, h: 10 }] } });
  assert.deepEqual(both.sketch, { name: 'B', elements: [{ type: 'rect', x: 0, y: 0, w: 10, h: 10 }] });
  assert.equal(L.sketchSpec({ mermaid: 'x'.repeat(10000) }).mermaid.length, L.SKETCH_MERMAID);
  assert.equal(L.sketchSpec({ mermaid: '   ' }), null, 'an empty diagram is no drawing');
  assert.equal(L.sketchSpec({ mermaid: 42 }), null);
});

test('Demo mode: a flowchart in Mermaid (always), a sketch from it where Excalidraw is on, TikZ where TikZJax is on', () => {
  const note = { title: 'On Balance', text: 'A note.\n' };
  assert.match(L.DEMO_MERMAID, /^```mermaid\nflowchart LR\n/);
  assert.match(L.DEMO_MERMAID, /\n```$/);
  assert.doesNotMatch(L.DEMO_MERMAID, /[^\x00-\x7f]/);
  const flow = L.parseAgentReply(L.demoChatReply('Draw a flowchart', note, true, false, { tikz: true, sketch: true })).ops;
  assert.equal(flow.length, 1);
  assert.deepEqual(L.figureKinds(flow[0].text), { tikz: 0, sketch: 0, mermaid: 1 }, 'a flowchart is Mermaid even where TikZJax is on');
  const tikz = L.parseAgentReply(L.demoChatReply('Draw a diagram', note, true, false, { tikz: true })).ops;
  assert.deepEqual(L.figureKinds(tikz[0].text), { tikz: 1, sketch: 0, mermaid: 0 });
  const sketch = L.parseAgentReply(L.demoChatReply('Draw a sketch', note, true, false, { sketch: true })).ops;
  assert.equal(sketch.length, 1);
  assert.equal(sketch[0].sketch.name, 'Balance at L1');
  assert.match(sketch[0].sketch.mermaid, /^flowchart LR\n/);
  assert.deepEqual(sketch[0].sketch.elements, []);
  const noSketch = L.parseAgentReply(L.demoChatReply('Draw a sketch', note, true, false, { tikz: false })).ops;
  assert.deepEqual(L.figureKinds(noSketch[0].text), { tikz: 0, sketch: 0, mermaid: 1 }, 'without Excalidraw, a sketch is asked for in vain: a flowchart instead');
});

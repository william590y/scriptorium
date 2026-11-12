/*
 * Lagrange: a writing companion for Scriptorium.
 *
 * Copyright (C) 2026 William Liaw
 *
 * This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
 * License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later
 * version. It is distributed WITHOUT ANY WARRANTY; see the GNU General Public License (LICENSE, next to this file).
 *
 * Plain CommonJS with no build step, like the Scriptorium plugin next to it. Obsidian supplies 'obsidian',
 * '@codemirror/state' and '@codemirror/view' to plugins through require(). Node's child_process, fs, os and path are
 * loaded only by the two subscription providers, only on desktop (nodeModule), so the plugin still runs on mobile.
 *
 * Map of this file:
 *   1. Settings and constants
 *   2. Pure helpers: SSE parsing, edit JSON parsing, locating edits, edits in a chat reply, the pen's script (with
 *      its mathematics) and trail, clipping notes, error messages, demo replies. They touch neither the DOM nor
 *      Obsidian; plugins-tests/lagrange.test.js tests them under Node.
 *   3. Providers: Anthropic Messages API, OpenAI API and OpenAI-compatible chat completions, a Claude subscription
 *      through Claude Code, a ChatGPT subscription through Codex, Demo (offline). The only requests the plugin makes
 *      are to the provider chosen in its settings, when the writer asks for something.
 *   4. The loader, a replaceable section:  mountLoader(containerEl, theme) -> { stop() }
 *   5. Pen helpers shared by any pen (rangeRects, sleep, nextFrame), then the pen, a replaceable section:
 *      createPen(app, settings) -> { edit(view, from, to, replacement): Promise<void>, destroy() }
 *      Each replaceable section runs from its "==== LAGRANGE … (replaceable) ====" line to its "==== END …" line,
 *      here and in styles.css.
 *   6. Edit runs: the editor is locked while the pen writes, and all of a request's edits become one undo step
 *   7. The chat view (with the model and effort picker in its footer), the revise modal, the settings tab and the
 *      plugin. A chat message may edit the note: the reply's edits block goes to the pen (applyChatEdits).
 */
'use strict';

const obsidian = require('obsidian');
const { Plugin, ItemView, Modal, Notice, PluginSettingTab, Setting, MarkdownRenderer, MarkdownView, Component, setIcon } = obsidian;
const { StateField, StateEffect, EditorState, Transaction, ChangeSet, Compartment } = require('@codemirror/state');
const { EditorView, Decoration, WidgetType } = require('@codemirror/view');


/* ---------------------------------------------------------------------------------------------------------------
 * 1. Settings and constants
 * ------------------------------------------------------------------------------------------------------------- */

const VIEW_TYPE = 'lagrange-chat';
const ICON = 'pen-tool';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2026-10-21';
// Server-side refusal fallback (beta): if a safety classifier declines, the API retries on another model in the same
// call. Only these two models take fallbacks: "default" (Claude Haiku 5.5 has no server-side fallback).
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const ANTHROPIC_MODELS = [
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', fallback: true },
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', fallback: true },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', fallback: false },
];
const MAX_TOKENS = 64000;          // streamed, so a long reply can't time out; known models all allow it
const MAX_TOKENS_CUSTOM = 8192;    // a custom model ID may be an older model with a smaller output limit

// How much of a note goes into one request, in characters. Longer notes are clipped around the cursor, and the chat
// says so. Local models often run with small context windows, hence the smaller figure.
const NOTE_LIMIT = { anthropic: 120000, 'claude-code': 120000, 'openai-api': 120000, codex: 80000, openai: 24000, demo: 120000 };

const LOADER_THEMES = ['random', 'clockwork', 'alchemy', 'orbit'];
// Reasoning effort, where the provider and model take one; '' leaves it to the provider's own default.
const EFFORTS = ['low', 'medium', 'high'];
const CLAUDE_CODE_MODELS = ['sonnet', 'opus', 'haiku'];   // Claude Code's aliases for the latest of each

const DEFAULT_SETTINGS = {
  provider: 'claude-code',            // 'claude-code' | 'anthropic' | 'codex' | 'openai-api' | 'openai' | 'demo'
  anthropicApiKey: '',
  anthropicModel: 'claude-sonnet-5-5', // an ANTHROPIC_MODELS id, or 'custom'
  anthropicCustomModel: '',
  refusalFallback: true,
  openaiBaseUrl: 'http://localhost:11434/v1',
  openaiApiKey: '',
  openaiModel: '',
  openaiPlatformKey: '',               // OpenAI API (platform.openai.com)
  openaiPlatformModel: '',
  claudeCodePath: '',                  // Claude subscription via Claude Code; empty = look in the usual places
  claudeCodeModel: 'sonnet',
  codexPath: '',                       // ChatGPT subscription via Codex; empty = look in the usual places
  codexModel: '',
  effort: '',                         // '' (the provider's default) | 'low' | 'medium' | 'high'; see effortFor
  agenticEdits: true,                 // a chat message may edit the open note with the pen; off: the chat only talks
  loaderTheme: 'random',              // 'random' | 'clockwork' | 'alchemy' | 'orbit'
  showPen: true,
  penSpeed: 1,                        // 0.5 (slow) to 3 (fast)
  penTrail: true,                     // a fading line of ink behind the pen's nib as it moves
};

function sanitizeSettings(saved) {
  const s = Object.assign({}, DEFAULT_SETTINGS);
  if (saved && typeof saved === 'object') {
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      if (typeof saved[k] === typeof DEFAULT_SETTINGS[k]) s[k] = saved[k];
    }
  }
  if (!['anthropic', 'claude-code', 'openai-api', 'codex', 'openai', 'demo'].includes(s.provider)) s.provider = DEFAULT_SETTINGS.provider;
  // A plate that no longer exists (a saved 'trebuchet', from 0.1) falls back to 'random'.
  if (!LOADER_THEMES.includes(s.loaderTheme)) s.loaderTheme = DEFAULT_SETTINGS.loaderTheme;
  if (s.anthropicModel !== 'custom' && !ANTHROPIC_MODELS.some(m => m.id === s.anthropicModel)) {
    s.anthropicModel = DEFAULT_SETTINGS.anthropicModel;
  }
  if (!(s.penSpeed >= 0.5 && s.penSpeed <= 3)) s.penSpeed = DEFAULT_SETTINGS.penSpeed;
  if (!EFFORTS.includes(s.effort)) s.effort = '';
  return s;
}

function anthropicModelId(s) {
  return s.anthropicModel === 'custom' ? String(s.anthropicCustomModel || '').trim() : s.anthropicModel;
}

/* Which models take a reasoning effort. Anthropic: `output_config.effort`, on Claude Opus 4.5 and every later Opus,
   Sonnet 4.6 and later, Haiku 5.5 and later, Fable and Mythos (older models answer 400). OpenAI: `reasoning_effort`,
   on the reasoning models only (the o-series and GPT-5 and later, but not their "chat" variants). */
const ANTHROPIC_EFFORT_RE = /^claude-(?:(?:fable|mythos)-|opus-(?:4-[5-9]|[5-9])|sonnet-(?:4-[6-9]|[5-9])|haiku-[5-9])/;
const OPENAI_EFFORT_RE = /^(?:o[1-9]|gpt-[5-9])/i;

/* Whether the chosen provider and model take a reasoning effort at all. Claude Code has `--effort`, Codex the
   `model_reasoning_effort` setting. A local OpenAI-compatible server is sent none (most reject or ignore it), and the
   demo has no model. */
function effortSupported(s) {
  if (s.provider === 'claude-code' || s.provider === 'codex') return true;
  if (s.provider === 'anthropic') return ANTHROPIC_EFFORT_RE.test(anthropicModelId(s));
  if (s.provider === 'openai-api') {
    const m = String(s.openaiPlatformModel || '').trim();
    return OPENAI_EFFORT_RE.test(m) && !/chat/i.test(m);
  }
  return false;
}

/* The effort to send with a request: the chosen one where it is supported, otherwise '' (send nothing). */
function effortFor(s) {
  return EFFORTS.includes(s.effort) && effortSupported(s) ? s.effort : '';
}

/* What the footer's model picker offers for the current provider:
   {provider, options: [{value, label}], current, free, placeholder}. `free` says a model can also be typed in. */
function modelChoices(s) {
  const out = (provider, options, current, free, placeholder) => {
    current = String(current || '').trim();
    if (current && !options.some(o => o.value === current)) options.push({ value: current, label: current });
    return { provider, options, current, free, placeholder: placeholder || '' };
  };
  switch (s.provider) {
    case 'anthropic':
      return out('Claude: API key', ANTHROPIC_MODELS.map(m => ({ value: m.id, label: m.name })), anthropicModelId(s), true, 'claude-…');
    case 'claude-code':
      return out('Claude: my subscription', CLAUDE_CODE_MODELS.map(m => ({ value: m, label: m[0].toUpperCase() + m.slice(1) })),
        s.claudeCodeModel, true, 'a full model ID');
    case 'codex':
      return out('ChatGPT: my subscription', [{ value: '', label: 'Codex’s default' }], s.codexModel, true, 'a model Codex knows');
    case 'openai-api':
      return out('OpenAI: API key', [], s.openaiPlatformModel, true, 'model ID');
    case 'openai':
      return out('OpenAI-compatible server', [], s.openaiModel, true, 'llama3.1');
    default:
      return out('Demo (offline)', [], '', false, '');
  }
}

/* Sets the current provider's model (a modelChoices value, or one typed in). */
function setModel(s, value) {
  const v = String(value == null ? '' : value).trim();
  if (s.provider === 'anthropic') {
    if (ANTHROPIC_MODELS.some(m => m.id === v)) s.anthropicModel = v;
    else if (v) { s.anthropicModel = 'custom'; s.anthropicCustomModel = v; }
  } else if (s.provider === 'claude-code') {
    if (v) s.claudeCodeModel = v;
  } else if (s.provider === 'codex') {
    s.codexModel = v;
  } else if (s.provider === 'openai-api') {
    if (v) s.openaiPlatformModel = v;
  } else if (s.provider === 'openai') {
    if (v) s.openaiModel = v;
  }
  return s;
}

/* The footer's label: the model, and the effort when one is set and the model takes it. */
function footLabel(s) {
  const e = effortFor(s);
  return modelLabel(s) + (e ? ` · ${e} effort` : '');
}

function modelLabel(s) {
  if (s.provider === 'demo') return 'Demo (offline)';
  if (s.provider === 'openai') return String(s.openaiModel || '').trim() || 'OpenAI-compatible server';
  if (s.provider === 'openai-api') return String(s.openaiPlatformModel || '').trim() || 'OpenAI';
  if (s.provider === 'claude-code') return `Claude (subscription${String(s.claudeCodeModel || '').trim() ? `, ${String(s.claudeCodeModel).trim()}` : ''})`;
  if (s.provider === 'codex') return `ChatGPT (subscription${String(s.codexModel || '').trim() ? `, ${String(s.codexModel).trim()}` : ''})`;
  const id = anthropicModelId(s);
  const preset = ANTHROPIC_MODELS.find(m => m.id === id);
  return preset ? preset.name : (id || 'Claude');
}


/* ---------------------------------------------------------------------------------------------------------------
 * 2. Pure helpers
 * ------------------------------------------------------------------------------------------------------------- */

class LagrangeError extends Error {
  constructor(message, extra) {
    super(message);
    this.name = 'LagrangeError';
    if (extra) Object.assign(this, extra);
  }
}

function abortError() {
  const e = new Error('Stopped');
  e.name = 'AbortError';
  return e;
}

function isAbort(e) {
  return Boolean(e && e.name === 'AbortError');
}

/* Server-sent events (https://html.spec.whatwg.org/multipage/server-sent-events.html). push() takes text chunks cut
   anywhere (mid-line, mid-CRLF); onEvent gets {event, data} for each complete event. end() flushes a final event that
   had no blank line after it. Comments and id/retry fields are ignored. */
function createSSEParser(onEvent) {
  let buf = '';
  let event = '';
  let data = [];
  const dispatch = () => {
    if (data.length) onEvent({ event: event || 'message', data: data.join('\n') });
    event = '';
    data = [];
  };
  const line = l => {
    if (l === '') { dispatch(); return; }
    if (l[0] === ':') return;
    const i = l.indexOf(':');
    const field = i < 0 ? l : l.slice(0, i);
    let value = i < 0 ? '' : l.slice(i + 1);
    if (value[0] === ' ') value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  };
  return {
    push(chunk) {
      buf += chunk;
      for (;;) {
        const n = buf.search(/\r\n|\n|\r/);
        if (n < 0) break;
        if (buf[n] === '\r' && n === buf.length - 1) break;   // maybe the first half of a CRLF: wait for more
        const len = buf[n] === '\r' && buf[n + 1] === '\n' ? 2 : 1;
        const l = buf.slice(0, n);
        buf = buf.slice(n + len);
        line(l);
      }
    },
    end() {
      if (buf) { const l = buf.replace(/\r$/, ''); buf = ''; line(l); }
      dispatch();
    },
  };
}

/* Each balanced JSON array or object in text, parsed, in order of where it starts. Prose around it, and brackets in
   the prose that don't start valid JSON, are skipped. */
function* jsonValuesIn(text) {
  let tries = 0;
  for (let start = 0; start < text.length && tries < 200; start++) {
    const open = text[start];
    if (open !== '[' && open !== '{') continue;
    tries++;
    let depth = 0, inString = false, escaped = false, end = -1;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end < 0) continue;
    try {
      yield JSON.parse(text.slice(start, end + 1));
      start = end;
    } catch (e) { /* not JSON from here: try the next bracket */ }
  }
}

function normalizeEdit(item) {
  if (!item || typeof item !== 'object') return null;
  const pick = keys => { for (const k of keys) if (typeof item[k] === 'string') return item[k]; return null; };
  const find = pick(['find', 'original', 'old', 'search']);
  const replace = pick(['replace', 'replacement', 'new', 'corrected']);
  if (!find || replace === null) return null;
  const reason = pick(['reason', 'why', 'explanation']);
  return { find, replace, reason: reason ? reason.trim() : '' };
}

/* The model's reply to a proofreading request, as edits: [{find, replace, reason}]. Accepts a bare JSON array, one in
   a ``` fence, one surrounded by prose, or {"edits": [...]}. Items without a non-empty "find" and a "replace" string
   are dropped (and counted). */
function parseEdits(text) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return { edits: [], dropped: 0, error: 'The reply was empty.' };
  const sources = [];
  const fence = /```[^\n`]*\n?([\s\S]*?)```/g;
  let m;
  while ((m = fence.exec(raw))) sources.push(m[1]);
  sources.push(raw);
  for (const src of sources) {
    for (const value of jsonValuesIn(src)) {
      const list = Array.isArray(value) ? value : (value && Array.isArray(value.edits) ? value.edits : null);
      if (!list) continue;
      if (list.length && !list.some(x => x && typeof x === 'object')) continue;
      const edits = list.map(normalizeEdit).filter(Boolean);
      return { edits, dropped: list.length - edits.length, error: null };
    }
  }
  return { edits: [], dropped: 0, error: 'The reply was not a JSON list of edits.' };
}

/* Every index where needle occurs in text, overlapping occurrences included (so "aa" is twice in "aaa"). */
function findAll(text, needle) {
  const out = [];
  if (!needle) return out;
  for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + 1)) out.push([i, i + needle.length]);
  return out;
}

/* A second, looser search for text a model copied not quite exactly: any kind of quotation mark or apostrophe matches
   any other, hyphens and dashes match each other, "..." matches "…", and runs of white space match any white space. */
function looseFindAll(text, needle) {
  if (!needle || needle.length > 4000) return [];
  let src = '';
  for (let i = 0; i < needle.length; i++) {
    const c = needle[i];
    if (/\s/.test(c)) { while (i + 1 < needle.length && /\s/.test(needle[i + 1])) i++; src += '\\s+'; }
    else if ('"“”„«»'.includes(c)) src += '["“”„«»]';
    else if ("'‘’‚".includes(c)) src += "['‘’‚]";
    else if ('-‐‑–—'.includes(c)) src += '[-‐‑–—]';
    else if (c === '…') src += '(?:…|\\.\\.\\.)';
    else if (c === '.' && needle.slice(i, i + 3) === '...') { src += '(?:…|\\.\\.\\.)'; i += 2; }
    else src += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  }
  const out = [];
  const re = new RegExp(src, 'g');
  let m;
  while ((m = re.exec(text))) {
    out.push([m.index, m.index + m[0].length]);
    re.lastIndex = m.index + 1;
  }
  return out;
}

/* Finds each edit's text in the document. An edit is skipped when its text isn't there, is there more than once, or
   overlaps an edit kept before it. Kept edits come back in document order with from/to offsets and the exact text
   matched ("matched", which can differ from "find" in quotes or spacing after the loose search). */
function locateEdits(doc, edits) {
  const located = [];
  const skipped = [];
  for (const e of edits) {
    if (e.find === e.replace) { skipped.push(Object.assign({}, e, { why: 'no change' })); continue; }
    let hits = findAll(doc, e.find);
    if (!hits.length) hits = looseFindAll(doc, e.find);
    if (!hits.length) { skipped.push(Object.assign({}, e, { why: 'not found in the note' })); continue; }
    if (hits.length > 1) { skipped.push(Object.assign({}, e, { why: `appears ${hits.length} times` })); continue; }
    const [from, to] = hits[0];
    if (located.some(o => from < o.to && o.from < to)) {
      skipped.push(Object.assign({}, e, { why: 'overlaps another edit' }));
      continue;
    }
    located.push(Object.assign({}, e, { from, to, matched: doc.slice(from, to) }));
  }
  located.sort((a, b) => a.from - b.from);
  return { located, skipped };
}

/* At most limit characters of text, cut at line ends where possible, centred on focus (an offset, e.g. the cursor;
   the beginning if not given). Marks what was left out so the model knows. */
function clipText(text, limit, focus) {
  text = String(text || '');
  if (text.length <= limit) return { text, clipped: false, start: 0, end: text.length, total: text.length };
  const f = Number.isFinite(focus) ? focus : 0;
  let start = Math.max(0, Math.min(text.length - limit, Math.round(f - limit / 2)));
  let end = Math.min(text.length, start + limit);
  if (start > 0) {
    const nl = text.indexOf('\n', start);
    if (nl >= 0 && nl < start + 2000 && nl < end) start = nl + 1;
  }
  if (end < text.length) {
    const nl = text.lastIndexOf('\n', end);
    if (nl > start && nl > end - 2000) end = nl;
  }
  let out = text.slice(start, end);
  if (start > 0) out = `[… the first ${start} characters are not shown …]\n` + out;
  if (end < text.length) out += `\n[… the last ${text.length - end} characters are not shown …]`;
  return { text: out, clipped: true, start, end, total: text.length };
}

/* The model's reply to a revise request, ready to replace the passage: a fence, <passage> tags or quotation marks
   wrapped around the whole reply are removed, and the passage's own leading and trailing white space is kept. Null if
   nothing is left. */
function cleanRevision(reply, original) {
  let t = String(reply == null ? '' : reply).trim();
  const fenced = t.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
  if (fenced) t = fenced[1].trim();
  const tagged = t.match(/^<passage>\s*([\s\S]*?)\s*<\/passage>$/i);
  if (tagged) t = tagged[1].trim();
  const orig = String(original || '');
  const quoted = t.match(/^(["“])([\s\S]*)(["”])$/);
  if (quoted && !/^\s*["“]/.test(orig) && !quoted[2].includes(quoted[1] === '“' ? '”' : '"')) t = quoted[2].trim();
  if (!t) return null;
  const lead = orig.match(/^\s*/)[0];
  const trail = orig.slice(lead.length).match(/\s*$/)[0];
  return lead + t + trail;
}

/* ---- Edits in a chat reply ----
   With "Edit with the pen" on, a chat reply may carry edits to the open note: after its prose, one block
       ```lagrange-edits
       [{"find": "…", "replace": "…", "reason": "…"}, {"insert_after": "…", "text": "…"}, {"append": "…"}]
       ```
   (or the same JSON between <lagrange-edits> and </lagrange-edits>). It is plain text, so every provider can write
   it. The chat shows the prose; the block goes to the pen. A reply without a block is an answer and changes nothing. */

const EDITS_OPEN_RE = /(?:^|\n)[ \t]*(?:(`{3,}|~{3,})[ \t]*lagrange-edits\b[^\n]*(?:\n|$)|<lagrange-edits>)/i;

/* Splits a chat reply into the prose to show and the edit blocks: {text, blocks: [string], open}. `open` is true when
   the last block has no closing line, as while the reply is still streaming, or when it was cut off; everything from
   its opening line on is then left out of the text. */
function splitAgentReply(reply) {
  let rest = String(reply == null ? '' : reply);
  let text = '';
  const blocks = [];
  let open = false;
  for (;;) {
    const m = EDITS_OPEN_RE.exec(rest);
    if (!m) { text += rest; break; }
    text += rest.slice(0, m.index) + '\n';
    const body = rest.slice(m.index + m[0].length);
    const close = m[1]
      ? new RegExp(`(?:^|\\n)[ \\t]*${m[1][0]}{${m[1].length},}[ \\t]*(?=\\n|$)`).exec(body)
      : /<\/lagrange-edits>/i.exec(body);
    if (!close) { blocks.push(body); open = true; break; }
    blocks.push(body.slice(0, close.index));
    rest = body.slice(close.index + close[0].length);
  }
  return { text: text.replace(/\n{3,}/g, '\n\n').trim(), blocks, open };
}

/* One item of an edits block, as an operation: {op: 'replace', find, replace, reason}, {op: 'insert', after | before,
   text, reason} or {op: 'append', text, reason}. Null if it is none of these. */
function normalizeOp(item) {
  if (!item || typeof item !== 'object') return null;
  const str = keys => { for (const k of keys) if (typeof item[k] === 'string') return item[k]; return null; };
  const reason = (str(['reason', 'why', 'explanation']) || '').trim();
  const text = str(['text', 'insert', 'content']);
  const append = str(['append']);
  if (append !== null) return append ? { op: 'append', text: append, reason } : null;
  const after = str(['insert_after', 'after']), before = str(['insert_before', 'before']);
  if (after !== null || before !== null) {
    if (!text || !(after || before)) return null;
    return after ? { op: 'insert', after, text, reason } : { op: 'insert', before, text, reason };
  }
  const e = normalizeEdit(item);
  return e ? { op: 'replace', find: e.find, replace: e.replace, reason: e.reason } : null;
}

/* The operations in a chat reply: {text, ops, dropped, error, open}. text is the prose to show. error is null when
   every block held a JSON list (an empty list is fine: no edits); items that are not edits are dropped and counted. */
function parseAgentReply(reply) {
  const { text, blocks, open } = splitAgentReply(reply);
  const ops = [];
  let dropped = 0, error = null;
  for (const block of blocks) {
    let list = null;
    for (const value of jsonValuesIn(block)) {
      list = Array.isArray(value) ? value : (value && Array.isArray(value.edits) ? value.edits : (value && typeof value === 'object' ? [value] : null));
      if (list) break;
    }
    if (!list) { error = open ? 'The edits were cut off before they were complete.' : 'The edits were not a JSON list.'; continue; }
    for (const item of list) {
      const op = normalizeOp(item);
      if (op) ops.push(op); else dropped++;
    }
  }
  return { text, ops, dropped, error, open };
}

/* Finds each operation's place in the document, as locateEdits does for proofreading (and by the same rules: the text
   named must be there exactly once, by the exact search or the loose one, and edits may not overlap). An insertion is
   an edit of an empty range, next to its anchor; an append goes at the end of the note, after a blank line. */
function locateOps(doc, ops) {
  const { located, skipped } = locateEdits(doc, ops.filter(o => o.op === 'replace').map(o => ({ find: o.find, replace: o.replace, reason: o.reason })));
  const skip = (o, find, why) => skipped.push({ find, matched: '', replace: o.text, reason: o.reason, why, insert: true });
  for (const o of ops) {
    if (o.op === 'replace') continue;
    let at, anchor = '';
    if (o.op === 'append') {
      at = doc.length;
    } else {
      anchor = o.after || o.before;
      let hits = findAll(doc, anchor);
      if (!hits.length) hits = looseFindAll(doc, anchor);
      if (!hits.length) { skip(o, anchor, 'the place was not found in the note'); continue; }
      if (hits.length > 1) { skip(o, anchor, `the place appears ${hits.length} times`); continue; }
      at = o.after ? hits[0][1] : hits[0][0];
    }
    if (located.some(e => (e.from < at && at < e.to) || (e.from === e.to && e.from === at))) { skip(o, anchor, 'overlaps another edit'); continue; }
    let insert = o.text;
    if (o.op === 'append' && doc.length) insert = (doc.endsWith('\n\n') ? '' : doc.endsWith('\n') ? '\n' : '\n\n') + insert;
    located.push({ find: '', matched: '', replace: insert, reason: o.reason, from: at, to: at, insert: true });
  }
  located.sort((a, b) => a.from - b.from || a.to - b.to);
  return { located, skipped };
}

/* ---- What the pen writes ----
   The pen writes a short form of each replacement above the line. Mathematics in it ($…$ or $$…$$, as Obsidian reads
   them) is kept whole, so it can be typeset and drawn symbol by symbol. */

/* Splits text into [{type: 'text', text} | {type: 'math', source, display}]. Inline math opens with a $ that is not
   escaped and not followed by white space, and closes with one not preceded by white space and not followed by a
   digit, on the same line (so "$5 and $10" is text); $$…$$ is display math and may span lines. Code spans and fenced
   code are text. */
function mathSegments(text) {
  const src = String(text == null ? '' : text);
  const out = [];
  let buf = '';
  const flush = () => { if (buf) { out.push({ type: 'text', text: buf }); buf = ''; } };
  for (let i = 0; i < src.length;) {
    const c = src[i];
    if (c === '\\' && i + 1 < src.length) { buf += src.slice(i, i + 2); i += 2; continue; }
    if (c === '`') {
      const ticks = src.slice(i).match(/^`+/)[0];
      const end = src.indexOf(ticks, i + ticks.length);
      const stop = end < 0 ? (ticks.length >= 3 ? src.length : i + ticks.length) : end + ticks.length;
      buf += src.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === '$') {
      if (src[i + 1] === '$') {
        const end = src.indexOf('$$', i + 2);
        const body = end < 0 ? '' : src.slice(i + 2, end).trim();
        if (body) { flush(); out.push({ type: 'math', source: body, display: true }); i = end + 2; continue; }
        const skip = end < 0 ? i + 2 : end + 2;      // "$$" with nothing in it, or never closed: text
        buf += src.slice(i, skip);
        i = skip;
        continue;
      } else if (i + 1 < src.length && !/\s/.test(src[i + 1])) {
        let end = -1;
        for (let j = i + 1; j < src.length && src[j] !== '\n'; j++) {
          if (src[j] === '\\') { j++; continue; }
          if (src[j] === '$') { if (!/\s/.test(src[j - 1]) && !/\d/.test(src[j + 1] || '')) end = j; break; }
        }
        if (end > i + 1) { flush(); out.push({ type: 'math', source: src.slice(i + 1, end), display: false }); i = end + 1; continue; }
      }
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

function hasMath(text) {
  return mathSegments(text).some(g => g.type === 'math');
}

/* The pen's script for a replacement: its segments, white space collapsed, cut to about `limit` characters of text.
   An equation is never cut in two and never left out for want of room (it counts for at most 24 characters, and the
   pen writes smaller if it must); only one whose source is longer than 160 characters ends the script, with an
   ellipsis, as does the text that runs past the limit. */
function penScript(replacement, limit) {
  const max = limit || 48;
  const segs = mathSegments(String(replacement == null ? '' : replacement).replace(/\s+/g, ' ').trim());
  const out = [];
  let used = 0;
  for (const g of segs) {
    const room = max - used;
    if (g.type === 'math') {
      const cost = Math.min(g.source.length, 24);
      if (g.source.length > 160 || room <= 0) { out.push({ type: 'text', text: ' …' }); break; }
      out.push(g);
      used += cost;
    } else {
      if (g.text.length > room) { out.push({ type: 'text', text: g.text.slice(0, Math.max(0, room - 2)).trimEnd() + ' …' }); break; }
      out.push(g);
      used += g.text.length;
    }
    if (used >= max && g.type !== 'math') { if (g !== segs[segs.length - 1]) out.push({ type: 'text', text: ' …' }); break; }
  }
  return out;
}

/* A typeset equation as an element, from `render(source, display)` (Obsidian's renderMath), or null when there is no
   renderer, it throws, or it returns something that isn't an element: the pen then writes the source as text. */
function renderPenMath(source, display, render) {
  if (typeof render !== 'function') return null;
  try {
    const el = render(source, Boolean(display));
    return el && el.nodeType === 1 ? el : null;
  } catch (e) {
    return null;
  }
}

/* The pen's trail: points [{x, y, t}] (oldest first) no older than `life` ms at `now`, as `bands` strokes from the
   newest (the darkest and widest) to the oldest: [{d, opacity, width}], d an SVG path. Neighbouring strokes share a
   point, so the line has no gaps. Pure, so it can be tested without a window. */
function trailBands(points, now, life, bands) {
  const out = [];
  const live = points.filter(p => now - p.t <= life && now - p.t >= 0);
  if (live.length < 2) return out;
  const groups = Array.from({ length: bands }, () => []);
  for (const p of live) groups[Math.min(bands - 1, Math.floor(((now - p.t) / life) * bands))].push(p);
  let newer = null;                                   // the oldest point of the band before (nearer the nib)
  for (let i = 0; i < bands; i++) {
    const g = groups[i];
    if (!g.length) continue;
    const pts = newer ? g.concat([newer]) : g;
    newer = g[0];
    if (pts.length < 2) continue;
    const k = 1 - i / bands;
    out.push({
      d: 'M' + pts.map(p => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join('L'),
      opacity: Number((0.5 * k * k).toFixed(3)),
      width: Number((0.6 + 1.8 * k).toFixed(2)),
    });
  }
  return out;
}

/* {type, message} from an error response body (Anthropic: {"type":"error","error":{"type","message"}}; OpenAI-style
   servers: {"error":{"message"}} or {"error":"..."}). Falls back to a short plain-text body. */
function parseErrorBody(text) {
  const raw = String(text || '').trim();
  try {
    const d = JSON.parse(raw);
    const e = d && d.error;
    if (e && typeof e === 'object') return { type: e.type || e.code || null, message: e.message || null };
    if (typeof e === 'string') return { type: null, message: e };
    if (d && typeof d.message === 'string') return { type: d.type || null, message: d.message };
  } catch (err) { /* not JSON */ }
  if (raw && raw.length <= 300 && !/^\s*</.test(raw)) return { type: null, message: raw };
  return { type: null, message: null };
}

/* A sentence for the writer, from an HTTP status and/or an API error type. */
function describeError({ provider, status, type, message, model, retryAfter }) {
  const anthropic = provider === 'anthropic';
  const who = anthropic ? 'Anthropic' : 'The server';
  const detail = message ? `: ${String(message).replace(/\s+/g, ' ').trim().replace(/\.$/, '')}` : '';
  if (status === 401 || type === 'authentication_error') {
    return `${who} did not accept the API key (401). Check it in Settings → Lagrange.`;
  }
  if (status === 402 || type === 'billing_error') return `${who} reports a billing problem with this account (402)${detail}.`;
  if (status === 403 || type === 'permission_error') return `This API key is not allowed to do that (403)${detail}.`;
  if (status === 404 || type === 'not_found_error') {
    return anthropic
      ? `The model “${model}” was not found, or this key cannot use it (404). Choose another in Settings → Lagrange.`
      : `Not found (404)${detail}. Check the base URL and the model name in Settings → Lagrange.`;
  }
  if (status === 413 || type === 'request_too_large') return 'The request was too large (413): the note is too long to send at once.';
  if (status === 429 || type === 'rate_limit_error') {
    return `Rate limited (429)${retryAfter ? `: try again in ${retryAfter} seconds` : ': wait a little and try again'}.`;
  }
  if (status === 529 || type === 'overloaded_error') return `${who} is overloaded at the moment (529). Try again shortly.`;
  if ((status && status >= 500) || type === 'api_error') return `${who} had an internal error (${status || 500}). Try again shortly.`;
  if (status === 400 || type === 'invalid_request_error') return `${who} could not accept the request (400)${detail}.`;
  return `${who} returned an error${status ? ` (${status})` : ''}${detail}.`;
}

function networkMessage(provider, url) {
  if (provider === 'anthropic') return 'Could not reach api.anthropic.com. Check your internet connection and try again.';
  let host = url;
  try { host = new URL(url).host; } catch (e) { /* keep the URL */ }
  return `Could not reach ${host}. Is the server running, and does it accept requests from Obsidian (CORS)? ` +
    'Ollama does by default; LM Studio needs CORS turned on.';
}

/* Words, paragraphs and headings of a Markdown note, and its first sentence of prose (for the demo). */
function noteStats(text) {
  const lines = String(text || '').split('\n');
  let headings = 0, paragraphs = 0, inPara = false, first = null, fenced = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; inPara = false; continue; }
    if (fenced) continue;
    if (/^#{1,6}\s/.test(line)) { headings++; inPara = false; continue; }
    if (!line.trim() || /^\s*(---|\*\*\*|___)\s*$/.test(line)) { inPara = false; continue; }
    if (/^\s*>/.test(line)) { inPara = false; continue; }
    if (!inPara) { paragraphs++; inPara = true; }
    if (first === null) {
      const plain = line.replace(/[*_`~]/g, '').trim();
      const m = plain.match(/^.*?[.!?](?=\s|$)/);
      first = m ? m[0] : plain;
    }
  }
  const words = (String(text || '').replace(/[#>*_`~[\]|-]/g, ' ').match(/[\p{L}\p{N}’'-]+/gu) || []).length;
  return { words, paragraphs, headings, firstSentence: first };
}

function excerpt(text, n) {
  const t = String(text || '');
  if (t.length <= n) return t;
  const head = Math.round(n * 0.7), tail = Math.max(10, n - head - 3);
  return t.slice(0, head).trimEnd() + ' … ' + t.slice(-tail).trimStart();
}

/* ---- Demo (offline) replies ---- */

// Edits for the Lorem Ipsum sample note, so the demo has something to proofread there (each occurs once in it).
const DEMO_SAMPLE_EDITS = [
  { find: 'erat a ante venenatis', replace: 'erat ante venenatis', reason: 'demo: a stray word' },
  { find: 'mollis interdum, sed posuere', replace: 'mollis interdum; sed posuere', reason: 'demo: a semicolon between two clauses' },
  { find: 'bibendum nulla sed consectetur', replace: 'bibendum nulla, sed consectetur', reason: 'demo: a comma before “sed”' },
];

// Typographic slips the demo can find in any note. Each pattern matches exactly the text to change.
const DEMO_RULES = [
  { re: /(?<=\S) {2,}(?=\S)/g, fix: () => ' ', reason: 'a doubled space' },
  { re: /(?<=\S) - (?=\S)/g, fix: () => '—', reason: 'a spaced hyphen used as a dash' },
  { re: /(?<=\w)--(?=\w)/g, fix: () => '—', reason: 'two hyphens for a dash' },
  { re: /\.\.\./g, fix: () => '…', reason: 'three full stops for an ellipsis' },
  { re: /"([^"\n]{1,120})"/g, fix: m => '“' + m[1] + '”', reason: 'straight quotation marks' },
  { re: /(?<=\w)'(?=\w)/g, fix: () => '’', reason: 'a straight apostrophe' },
  { re: /\b([A-Za-z]+) \1\b/g, fix: m => m[1], reason: 'a doubled word' },
];

/* [a, b): [from, to) widened to whole words, then word by word on both sides, until it occurs once in doc. */
function uniqueContext(doc, from, to) {
  let a = from, b = to;
  while (a > 0 && !/\s/.test(doc[a - 1])) a--;
  while (b < doc.length && !/\s/.test(doc[b])) b++;
  for (let step = 0; step < 12; step++) {
    if (findAll(doc, doc.slice(a, b)).length === 1) return [a, b];
    let a2 = a, b2 = b;
    while (a2 > 0 && /\s/.test(doc[a2 - 1])) a2--;
    while (a2 > 0 && !/\s/.test(doc[a2 - 1])) a2--;
    while (b2 < doc.length && /\s/.test(doc[b2])) b2++;
    while (b2 < doc.length && !/\s/.test(doc[b2])) b2++;
    if (a2 === a && b2 === b) break;
    a = a2; b = b2;
  }
  return null;
}

/* Ranges of a note the demo must not change: front matter, code, math, comments, HTML tags, tables, link and image
   destinations (where a curled quote would break a title), wikilinks and embeds, and bare URLs. */
function demoSkipRanges(text) {
  const skip = [];
  const fm = text.match(/^---\n[\s\S]*?\n---\n/);
  if (fm) skip.push([0, fm[0].length]);
  const patterns = [
    /```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`/g,     // code
    /\$\$[\s\S]*?\$\$|\$[^$\n]+\$/g,                // math
    /%%[\s\S]*?%%|<!--[\s\S]*?-->/g,               // comments
    /<\/?[A-Za-z][^>\n]*>/g,                         // HTML tags
    /^[ \t]*\|.*$/gm,                                 // table rows
    /\]\((?:[^()\n]|\([^()\n]*\))*\)/g,                 // link and image destinations, with their titles
    /^[ \t]*\[[^\]\n]+\]:.*$/gm,                        // reference link definitions
    /!?\[\[[^\]\n]*\]\]/g,                              // wikilinks and embeds
    /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>()]+/gi,              // bare URLs
  ];
  for (const re of patterns) for (const m of text.matchAll(re)) skip.push([m.index, m.index + m[0].length]);
  return skip;
}

/* The demo's proofreading: typographic slips anywhere (fixes close together become one edit), then, in the Lorem
   Ipsum sample, a few made-up corrections so there is always something to show. */
function demoProofreadEdits(doc) {
  const text = String(doc || '');
  const skip = demoSkipRanges(text);   // front matter, code and Markdown syntax are never touched
  const overlaps = (list, a, b) => list.some(([s, e]) => a < e && s < b);
  const fixes = [];
  for (const rule of DEMO_RULES) {
    for (const m of text.matchAll(rule.re)) {
      const from = m.index, to = m.index + m[0].length;
      if (overlaps(skip, from, to) || overlaps(fixes.map(f => [f.from, f.to]), from, to)) continue;
      fixes.push({ from, to, insert: rule.fix(m), reason: rule.reason });
    }
  }
  fixes.sort((x, y) => x.from - y.from);
  const groups = [];
  for (const f of fixes) {
    const ctx = uniqueContext(text, f.from, f.to);
    if (!ctx) continue;
    const g = groups[groups.length - 1];
    if (g && ctx[0] <= g.b) { g.b = Math.max(g.b, ctx[1]); g.fixes.push(f); }
    else groups.push({ a: ctx[0], b: ctx[1], fixes: [f] });
  }
  const edits = [];
  const taken = [];
  for (const g of groups) {
    const ctx = uniqueContext(text, g.a, g.b);
    if (!ctx || overlaps(taken, ctx[0], ctx[1])) continue;
    let replace = text.slice(ctx[0], ctx[1]);
    for (const f of g.fixes.slice().reverse()) {
      replace = replace.slice(0, f.from - ctx[0]) + f.insert + replace.slice(f.to - ctx[0]);
    }
    edits.push({ find: text.slice(ctx[0], ctx[1]), replace, reason: [...new Set(g.fixes.map(f => f.reason))].join('; ') });
    taken.push(ctx);
    if (edits.length >= 6) return edits;
  }
  for (const e of DEMO_SAMPLE_EDITS) {
    const hits = findAll(text, e.find);
    if (hits.length === 1 && !overlaps(taken, hits[0][0], hits[0][1])) edits.push(Object.assign({}, e));
  }
  return edits.slice(0, 6);
}

function titleCase(t) {
  const small = /^(a|an|and|as|at|but|by|for|in|of|on|or|the|to|via)$/i;
  let first = true;
  return t.replace(/[\p{L}\p{N}’']+/gu, w => {
    const out = !first && small.test(w) ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1);
    first = false;
    return out;
  });
}

function splitSentences(t) {
  return t.match(/[^.!?…]+[.!?…]+["”’)*_]*\s*|[^.!?…]+$/g) || [t];
}

function demoRevise(passage, instruction) {
  const t = String(passage || '');
  const i = String(instruction || '').toLowerCase();
  if (/upper|capital/.test(i)) return t.toUpperCase();
  if (/lower/.test(i)) return t.toLowerCase();
  if (/title/.test(i)) return titleCase(t);
  if (/short|concise|trim|tight|brief|cut/.test(i)) {
    const s = splitSentences(t.trim());
    if (s.length > 1) return s.slice(0, Math.ceil(s.length / 2)).join('').trim();
    const words = t.trim().split(/\s+/);
    return words.slice(0, Math.max(1, Math.ceil(words.length * 0.6))).join(' ').replace(/[,;:]$/, '') + '…';
  }
  let out = t;
  for (const rule of DEMO_RULES) out = out.replace(rule.re, (...args) => rule.fix(args));   // args: match, groups…
  if (out !== t) return out;
  const s = splitSentences(t.trim());
  if (s.length > 1) return s.map(x => x.trim()).reverse().join(' ');
  return titleCase(t);
}

/* The demo's edits block for a chat message that asks for a change, or '' when it asks for none: "fix", "proofread"
   or "correct" proofreads; "equation" or "formula" adds one; "add" or "append" adds a line. */
function demoChatEdits(question, note) {
  const q = String(question || '').toLowerCase();
  let ops = null;
  if (/\b(equation|formula|math)/.test(q)) {
    ops = [{ append: 'The Euler–Lagrange equation: $$\\frac{d}{dt}\\frac{\\partial L}{\\partial \\dot{q}} - \\frac{\\partial L}{\\partial q} = 0$$' }];
  } else if (/\b(fix|proofread|correct|tidy|clean)/.test(q)) {
    ops = demoProofreadEdits(note.text);
  } else if (/\b(add|append|write)\b/.test(q)) {
    ops = [{ append: 'A line added by Lagrange in demo mode.' }];
  }
  return ops && ops.length ? '```lagrange-edits\n' + JSON.stringify(ops, null, 2) + '\n```' : '';
}

function demoChatReply(question, note, agentic) {
  const parts = ['*Demo mode: a canned reply, written without a model. Choose a Claude or ChatGPT subscription, an ' +
    'API key or an OpenAI-compatible server in Settings → Lagrange for real answers.*'];
  if (agentic && note) {
    const block = demoChatEdits(question, note);
    if (block) return parts.concat(`Here is what the pen will set down in **${note.title}**.`, block).join('\n\n');
  }
  if (note) {
    const st = noteStats(note.text);
    const pl = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
    parts.push(`I have read **${note.title}**: ${pl(st.words, 'word')} in ${pl(st.paragraphs, 'paragraph')}` +
      (st.headings ? `, under ${pl(st.headings, 'heading')}.` : '.') +
      (st.firstSentence ? ` It opens: “${excerpt(st.firstSentence, 160)}”` : ''));
  } else {
    parts.push('No note is open, so there is nothing for me to read yet.');
  }
  parts.push(`You asked: “${excerpt(String(question || '').replace(/\s+/g, ' '), 160)}” A model would answer here, ` +
    'with the note in mind.');
  parts.push('The edits work offline in demo mode:\n\n' +
    (agentic ? '- Ask here to *fix the typography*, to *add a line* or to *add an equation*, and the pen does it.\n' : '') +
    '- **Proofread note** finds typographic slips (straight quotes, spaced hyphens, doubled spaces) and sets the ' +
    'corrections down with the pen.\n' +
    '- **Revise selection** rewrites the selected passage: ask for it *shorter*, *in title case* or *in capitals*.\n\n' +
    'One undo (Ctrl+Z or Cmd+Z) takes back all the edits of a request.');
  return parts.join('\n\n');
}


/* ---------------------------------------------------------------------------------------------------------------
 * 3. Providers
 *
 * complete(settings, req, hooks, session) -> Promise<{text, stopReason, stopDetails, model, fallbackTo}>
 *   req:     {purpose: 'chat'|'proofread'|'revise', system, messages: [{role, content}], cache, demo: () => string}
 *   hooks:   {signal, onText(delta, fullText), onRetry(status, ms), fetch, retryDelays}
 *   session: {noFallback, noEffort: {}}, what this run of Obsidian has learnt a provider won't take
 * The reasoning effort (settings.effort) goes out only where the provider and model take one (effortFor); if a
 * provider still rejects it, the request is sent again without it and the session remembers.
 * Throws LagrangeError with a sentence for the writer, or an AbortError when stopped.
 * ------------------------------------------------------------------------------------------------------------- */

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504, 529]);

/* The effort for this request, unless this session has already seen `key` (a provider and model) refuse one. */
function sessionEffort(s, session, key) {
  const e = effortFor(s);
  return e && !(session && session.noEffort && session.noEffort[key]) ? e : '';
}

function forgetEffort(session, key) {
  if (!session) return;
  if (!session.noEffort) session.noEffort = {};
  session.noEffort[key] = true;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { reject(abortError()); return; }
    const t = setTimeout(() => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); }, Math.max(0, ms));
    const onAbort = () => { clearTimeout(t); reject(abortError()); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/* fetch, retried (twice, after a pause) on rate limits, overloads and server errors before any of the reply has been
   read; a network failure becomes a LagrangeError that says what to check. */
async function fetchWithRetry(provider, url, init, hooks) {
  const doFetch = hooks.fetch || fetch;
  const delays = hooks.retryDelays || [1500, 4000];
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await doFetch(url, init);
    } catch (e) {
      if (isAbort(e) || (init.signal && init.signal.aborted)) throw abortError();
      throw new LagrangeError(networkMessage(provider, url), { kind: 'network', cause: e });
    }
    if (!RETRY_STATUSES.has(res.status) || attempt >= delays.length) return res;
    const ra = Number(res.headers && res.headers.get('retry-after'));
    if (res.status === 429 && ra > 20) return res;
    const wait = ra > 0 ? ra * 1000 : delays[attempt];
    try { if (res.body && res.body.cancel) await res.body.cancel(); } catch (e) { /* ignore */ }
    if (hooks.onRetry) hooks.onRetry(res.status, wait);
    await sleep(wait, init.signal);
  }
}

async function safeText(res) {
  try { return await res.text(); } catch (e) { return ''; }
}

function httpError(provider, res, bodyText, model) {
  const info = parseErrorBody(bodyText);
  const ra = Number(res.headers && res.headers.get('retry-after'));
  return new LagrangeError(describeError({
    provider, status: res.status, type: info.type, message: info.message, model, retryAfter: ra > 0 ? ra : null,
  }), { kind: 'http', status: res.status });
}

/* Reads a streamed response as server-sent events. */
async function readSSE(res, onEvent) {
  const parser = createSSEParser(onEvent);
  if (!res.body || typeof res.body.getReader !== 'function') {
    parser.push(await res.text());
    parser.end();
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
    }
    parser.push(decoder.decode());
    parser.end();
  } catch (e) {
    try { await reader.cancel(); } catch (err) { /* already closed */ }
    if (isAbort(e)) throw abortError();
    throw e;
  }
}

/* Applies one Messages API stream event to st ({text, stopReason, stopDetails, model, fallbackTo}); returns the text
   it added. Thinking blocks are skipped (only text is shown); a "fallback" block marks a server-side retry on another
   model after a refusal, and the text before and after it continues one reply. An "error" event throws. */
function applyAnthropicEvent(st, ev) {
  if (!ev || !ev.data) return '';
  let d;
  try { d = JSON.parse(ev.data); } catch (e) { return ''; }
  switch (d.type) {
    case 'message_start':
      if (d.message && d.message.model) st.model = d.message.model;
      return '';
    case 'content_block_start': {
      const b = d.content_block || {};
      if (b.type === 'text' && typeof b.text === 'string' && b.text) { st.text += b.text; return b.text; }
      if (b.type === 'fallback') st.fallbackTo = (b.to && b.to.model) || 'another model';
      return '';
    }
    case 'content_block_delta':
      if (d.delta && d.delta.type === 'text_delta' && typeof d.delta.text === 'string') {
        st.text += d.delta.text;
        return d.delta.text;
      }
      return '';
    case 'message_delta':
      if (d.delta && d.delta.stop_reason) st.stopReason = d.delta.stop_reason;
      if (d.delta && d.delta.stop_details) st.stopDetails = d.delta.stop_details;
      return '';
    case 'error': {
      const err = d.error || {};
      throw new LagrangeError(describeError({ provider: 'anthropic', type: err.type, message: err.message }),
        { kind: 'stream', type: err.type });
    }
    default:
      return '';
  }
}

async function streamAnthropic(s, req, hooks, session) {
  const key = String(s.anthropicApiKey || '').trim();
  if (!key) {
    throw new LagrangeError('Lagrange needs an Anthropic API key: add one in Settings → Lagrange, or choose the ' +
      'Demo provider there to try Lagrange offline.', { kind: 'setup' });
  }
  const model = anthropicModelId(s);
  if (!model) throw new LagrangeError('Choose a Claude model in Settings → Lagrange.', { kind: 'setup' });
  const preset = ANTHROPIC_MODELS.find(m => m.id === model);
  const body = {
    model,
    max_tokens: preset ? MAX_TOKENS : MAX_TOKENS_CUSTOM,
    stream: true,
    system: req.system,
    messages: req.messages,
  };
  if (req.cache) body.cache_control = { type: 'ephemeral' };   // reuses the note across turns of one conversation
  const headers = {
    'content-type': 'application/json',
    'x-api-key': key,
    'anthropic-version': ANTHROPIC_VERSION,
    'anthropic-dangerous-direct-browser-access': 'true',        // lets the API answer a browser (Obsidian) directly
  };
  const send = (withFallback, effort) => {
    const h = Object.assign({}, headers);
    const b = Object.assign({}, body);
    if (withFallback) { h['anthropic-beta'] = FALLBACK_BETA; b.fallbacks = 'default'; }
    if (effort) b.output_config = { effort };                   // thinking stays adaptive (the default); effort sets its depth
    return fetchWithRetry('anthropic', ANTHROPIC_URL,
      { method: 'POST', headers: h, body: JSON.stringify(b), signal: hooks.signal }, hooks);
  };
  let fallback = Boolean(s.refusalFallback && preset && preset.fallback && !(session && session.noFallback));
  let effort = sessionEffort(s, session, `anthropic:${model}`);
  let res;
  for (;;) {
    res = await send(fallback, effort);
    if (res.ok) break;
    const text = await safeText(res);
    const info = parseErrorBody(text);
    const said = info.message || text;
    // An account without the fallback beta gets a 400 naming it: carry on without fallbacks for this session.
    if (fallback && res.status === 400 && /anthropic-beta|fallback/i.test(said)) {
      if (session) session.noFallback = true;
      fallback = false;
    // A model that takes no effort (a custom ID for an older model) says so: carry on without it.
    } else if (effort && res.status === 400 && /effort|output_config/i.test(said)) {
      forgetEffort(session, `anthropic:${model}`);
      effort = '';
    } else {
      throw httpError('anthropic', res, text, model);
    }
  }
  const st = { text: '', stopReason: null, stopDetails: null, model: null, fallbackTo: null };
  await readSSE(res, ev => {
    const delta = applyAnthropicEvent(st, ev);
    if (delta && hooks.onText) hooks.onText(delta, st.text);
  });
  return { text: st.text, stopReason: st.stopReason, stopDetails: st.stopDetails, model: st.model || model, fallbackTo: st.fallbackTo };
}

/* Applies one chat-completions stream chunk (or a whole non-streamed response) to st; returns the text it added. */
function applyOpenAIEvent(st, ev) {
  const data = String((ev && ev.data) || '').trim();
  if (!data) return '';
  if (data === '[DONE]') { st.done = true; return ''; }
  let d;
  try { d = JSON.parse(data); } catch (e) { return ''; }
  if (d.error) {
    const e = typeof d.error === 'string' ? { message: d.error } : d.error;
    throw new LagrangeError(describeError({ provider: 'openai', type: e.type || e.code, message: e.message }), { kind: 'stream' });
  }
  const c = d.choices && d.choices[0];
  if (!c) return '';
  let piece = '';
  if (c.delta && typeof c.delta.content === 'string') piece = c.delta.content;
  else if (c.message && typeof c.message.content === 'string') piece = c.message.content;
  if (c.finish_reason) st.stopReason = c.finish_reason === 'length' ? 'max_tokens' : c.finish_reason;
  st.text += piece;
  return piece;
}

async function streamOpenAI(s, req, hooks, session) {
  const base = String(s.openaiBaseUrl || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) {
    throw new LagrangeError('Enter the server’s base URL in Settings → Lagrange, for example http://localhost:11434/v1.', { kind: 'setup' });
  }
  const model = String(s.openaiModel || '').trim();
  if (!model) {
    throw new LagrangeError('Enter the name of the model your server runs (for example llama3.1) in Settings → Lagrange.', { kind: 'setup' });
  }
  const headers = { 'content-type': 'application/json' };
  const key = String(s.openaiApiKey || '').trim();
  if (key) headers.authorization = `Bearer ${key}`;
  const url = `${base}/chat/completions`;
  const body = { model, stream: true, messages: [{ role: 'system', content: req.system }].concat(req.messages) };
  // Only OpenAI's own reasoning models are sent an effort (effortSupported); a local server never is.
  let effort = sessionEffort(s, session, `openai:${model}`);
  let res;
  for (;;) {
    const b = effort ? Object.assign({ reasoning_effort: effort }, body) : body;
    res = await fetchWithRetry('openai', url, { method: 'POST', headers, body: JSON.stringify(b), signal: hooks.signal }, hooks);
    if (res.ok) break;
    const text = await safeText(res);
    if (effort && res.status === 400 && /reasoning|effort/i.test(parseErrorBody(text).message || text)) {
      forgetEffort(session, `openai:${model}`);
      effort = '';
      continue;
    }
    throw httpError('openai', res, text, model);
  }
  const st = { text: '', stopReason: null, done: false };
  const onEvent = ev => {
    const delta = applyOpenAIEvent(st, ev);
    if (delta && hooks.onText) hooks.onText(delta, st.text);
  };
  const type = (res.headers && res.headers.get('content-type')) || '';
  if (/application\/json/i.test(type)) onEvent({ data: await res.text() });   // a server that ignored "stream"
  else await readSSE(res, onEvent);
  return { text: st.text, stopReason: st.stopReason, stopDetails: null, model, fallbackTo: null };
}

/* ---- Subscriptions: Claude through Claude Code, ChatGPT through Codex (desktop only) ----
   A Claude Pro/Max or ChatGPT Plus/Pro subscription can't be used by calling an API directly; the sanctioned way is
   each company's own command-line tool, signed in to the writer's account: Claude Code (`claude`) and Codex (`codex`).
   Lagrange runs the tool once per request, with every tool, setting file and session file turned off, gives it the
   prompt on stdin, and reads its JSON event stream. Node's child_process is loaded only here, only on desktop. */

// Node modules, loaded lazily so the plugin still loads on mobile, where the subscription providers are unavailable.
function nodeModule(name) {
  if (obsidian.Platform && obsidian.Platform.isDesktopApp === false) {
    throw new LagrangeError('Signing in with a subscription works only in Obsidian on a computer: it runs the ' +
      'provider’s command-line tool. On a phone or tablet, choose an API key provider (or the Demo) in Settings → Lagrange.', { kind: 'setup' });
  }
  return require(name);   // eslint-disable-line global-require
}

const CLI = {
  claude: {
    label: 'Claude Code',
    install: 'Install Claude Code (claude.com/code), then run “claude” once in a terminal and sign in with your Claude account.',
    login: 'Claude Code isn’t signed in. Open a terminal, run “claude”, and sign in with your Claude Pro or Max account.',
  },
  codex: {
    label: 'Codex',
    install: 'Install Codex (npm install -g @openai/codex, or see developers.openai.com/codex), then run “codex login” and choose “Sign in with ChatGPT”.',
    login: 'Codex isn’t signed in. Open a terminal, run “codex login”, and choose “Sign in with ChatGPT”.',
  },
};

/* Where the tools usually live. Obsidian started from the dock doesn't see the shell's PATH, so look in the usual
   install folders as well as PATH. Returns the first path that exists, or null. */
function findCli(name, custom) {
  const fs = nodeModule('fs'), path = nodeModule('path'), os = nodeModule('os');
  const want = String(custom || '').trim();
  if (want) return fs.existsSync(want) ? want : null;
  const home = os.homedir(), win = process.platform === 'win32';
  const exts = win ? ['.exe', '.cmd', ''] : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean).concat(win
    ? [path.join(home, '.local', 'bin'), path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'npm'),
       path.join(home, 'AppData', 'Local', 'Programs', name)]
    : [path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local'), '/opt/homebrew/bin', '/usr/local/bin',
       path.join(home, '.npm-global', 'bin'), path.join(home, '.bun', 'bin'), path.join(home, '.volta', 'bin'), '/usr/bin']);
  for (const d of dirs) for (const e of exts) {
    const p = path.join(d, name + e);
    try { if (fs.statSync(p).isFile()) return p; } catch (err) { /* not here */ }
  }
  return null;
}

/* One prompt from the conversation: the tools take a single message, so earlier turns become a short transcript. */
function transcriptPrompt(messages) {
  const msgs = (messages || []).filter(m => m && typeof m.content === 'string');
  if (msgs.length <= 1) return msgs.length ? msgs[0].content : '';
  const last = msgs[msgs.length - 1];
  const earlier = msgs.slice(0, -1).map(m => `${m.role === 'assistant' ? 'Lagrange' : 'Writer'}: ${m.content}`).join('\n\n');
  return `<conversation_so_far>\n${earlier}\n</conversation_so_far>\n\nThe writer now says:\n\n${last.content}`;
}

/* Applies one line of `claude -p --output-format stream-json --include-partial-messages` to st; returns new text. */
function applyClaudeCodeLine(st, line) {
  line = String(line || '').trim();
  if (!line) return '';
  let e;
  try { e = JSON.parse(line); } catch (err) { return ''; }
  if (e.type === 'stream_event' && e.event && e.event.type === 'content_block_delta' && e.event.delta
      && e.event.delta.type === 'text_delta' && typeof e.event.delta.text === 'string') {
    st.text += e.event.delta.text;
    st.streamed = true;
    return e.event.delta.text;
  }
  if (e.type === 'stream_event' && e.event && e.event.type === 'message_delta' && e.event.delta && e.event.delta.stop_reason) {
    st.stopReason = e.event.delta.stop_reason;
  }
  if (e.type === 'system' && e.subtype === 'init' && e.model) st.model = e.model;
  if (e.type === 'assistant' && !st.streamed && e.message && Array.isArray(e.message.content)) {
    const t = e.message.content.filter(b => b && b.type === 'text').map(b => b.text).join('');
    if (t) { st.text += t; return t; }
  }
  if (e.type === 'result') {
    st.done = true;
    if (e.is_error) st.error = String(e.result || (e.errors && e.errors.join(' ')) || e.subtype || 'Claude Code reported an error.');
    else if (!st.text && typeof e.result === 'string') { st.text = e.result; return e.result; }
  }
  return '';
}

/* Applies one line of `codex exec --json` to st; returns new text. */
function applyCodexLine(st, line) {
  line = String(line || '').trim();
  if (!line) return '';
  let e;
  try { e = JSON.parse(line); } catch (err) { return ''; }
  const item = e.item || (e.msg && { type: e.msg.type, text: e.msg.message });
  if ((e.type === 'item.completed' || (e.msg && e.msg.type === 'agent_message')) && item && item.type === 'agent_message' && typeof item.text === 'string') {
    const add = (st.text ? '\n\n' : '') + item.text;
    st.text += add;
    return add;
  }
  if (e.type === 'turn.completed') st.done = true;
  if (e.type === 'error' || e.type === 'turn.failed' || (e.msg && e.msg.type === 'error')) {
    st.error = String((e.error && e.error.message) || e.message || (e.msg && e.msg.message) || 'Codex reported an error.');
  }
  return '';
}

function cliErrorMessage(which, text) {
  const t = String(text || '');
  if (/log ?in|logged in|sign ?in|authenticat|unauthori[sz]ed|invalid api key|401|credential/i.test(t)) return CLI[which].login;
  if (/rate.?limit|usage limit|quota|429|limit reached/i.test(t)) {
    return `${CLI[which].label} says your subscription’s usage limit has been reached. Try again later. (${t.slice(0, 160)})`;
  }
  return `${CLI[which].label} stopped with an error: ${t.slice(0, 300) || 'no details'}`;
}

/* Runs a command-line tool, feeding `input` on stdin and passing each stdout line to onLine. Resolves with the exit
   code and stderr; rejects on a missing executable. hooks.signal stops it. */
function runCli(which, exe, args, input, onLine, hooks) {
  const cp = nodeModule('child_process'), os = nodeModule('os'), path = nodeModule('path');
  const win = process.platform === 'win32';
  const env = Object.assign({}, process.env);
  env.PATH = [path.dirname(exe), env.PATH || ''].filter(Boolean).join(path.delimiter);
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = cp.spawn(exe, args, { cwd: os.tmpdir(), env, windowsHide: true, shell: win && /\.cmd$/i.test(exe), stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      reject(new LagrangeError(`${CLI[which].label} couldn’t be started (${e.message}). ${CLI[which].install}`, { kind: 'setup', cause: e }));
      return;
    }
    let buf = '', err = '', settled = false;
    const done = f => { if (!settled) { settled = true; f(); } };
    const onAbort = () => { try { child.kill(); } catch (e) { /* gone */ } done(() => reject(abortError())); };
    if (hooks.signal) {
      if (hooks.signal.aborted) { onAbort(); return; }
      hooks.signal.addEventListener('abort', onAbort, { once: true });
    }
    child.on('error', e => done(() => reject(new LagrangeError(e.code === 'ENOENT'
      ? `${CLI[which].label} wasn’t found at ${exe}. ${CLI[which].install}`
      : `${CLI[which].label} couldn’t be started (${e.message}).`, { kind: 'setup', cause: e }))));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try { onLine(line); } catch (e) { try { child.kill(); } catch (k) { /* gone */ } done(() => reject(e)); return; }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', c => { err = (err + c).slice(-4000); });
    child.on('close', code => {
      if (hooks.signal) hooks.signal.removeEventListener('abort', onAbort);
      if (buf.trim()) { try { onLine(buf); } catch (e) { done(() => reject(e)); return; } }
      done(() => resolve({ code, stderr: err }));
    });
    child.stdin.on('error', () => { /* the tool may exit before reading everything */ });
    child.stdin.end(input, 'utf8');
  });
}

function abortError() {
  const e = new Error('Stopped.');
  e.name = 'AbortError';
  return e;
}

async function streamClaudeCode(s, req, hooks, session) {
  const exe = findCli('claude', s.claudeCodePath);
  if (!exe) throw new LagrangeError(`Claude Code wasn’t found${s.claudeCodePath ? ` at ${s.claudeCodePath}` : ''}. ${CLI.claude.install}`, { kind: 'setup' });
  const fs = nodeModule('fs'), os = nodeModule('os'), path = nodeModule('path');
  const sysFile = path.join(os.tmpdir(), `lagrange-system-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(sysFile, req.system || '', 'utf8');
  const quote = a => (process.platform === 'win32' && /\.cmd$/i.test(exe) ? `"${String(a).replace(/"/g, '""')}"` : a);
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--tools', quote(''), '--no-session-persistence', '--setting-sources', quote(''), '--strict-mcp-config',
    '--system-prompt-file', quote(sysFile)];
  const model = String(s.claudeCodeModel || '').trim();
  if (model) args.push('--model', quote(model));
  let effort = sessionEffort(s, session, 'claude-code');
  let st;
  try {
    for (;;) {
      st = { text: '', streamed: false, stopReason: null, model: null, error: null, done: false };
      const { code, stderr } = await runCli('claude', exe, effort ? args.concat('--effort', quote(effort)) : args,
        transcriptPrompt(req.messages), line => {
          const delta = applyClaudeCodeLine(st, line);
          if (delta && hooks.onText) hooks.onText(delta, st.text);
        }, hooks);
      // A Claude Code from before `--effort` stops at once, naming the option: run it again without.
      if (effort && !st.text && /effort/i.test(`${st.error || ''} ${stderr}`) && /unknown|unrecogni[sz]ed|invalid|unexpected|not supported/i.test(`${st.error || ''} ${stderr}`)) {
        forgetEffort(session, 'claude-code');
        effort = '';
        continue;
      }
      if (st.error) throw new LagrangeError(cliErrorMessage('claude', st.error), { kind: 'stream' });
      if (!st.text) throw new LagrangeError(cliErrorMessage('claude', stderr || `exit code ${code}`), { kind: 'stream' });
      break;
    }
  } finally {
    try { fs.unlinkSync(sysFile); } catch (e) { /* already gone */ }
  }
  return { text: st.text, stopReason: st.stopReason || 'end_turn', stopDetails: null, model: st.model || model || 'Claude Code', fallbackTo: null };
}

async function streamCodex(s, req, hooks, session) {
  const exe = findCli('codex', s.codexPath);
  if (!exe) throw new LagrangeError(`Codex wasn’t found${s.codexPath ? ` at ${s.codexPath}` : ''}. ${CLI.codex.install}`, { kind: 'setup' });
  const os = nodeModule('os');
  const args = ['exec', '--json', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only', '-C', os.tmpdir()];
  const model = String(s.codexModel || '').trim();
  if (model) args.push('-m', model);
  const input = '<instructions>\n' + (req.system || '') + '\n\nAnswer in text only: do not run commands, and do not ' +
    'read or write files. Everything you need is in this message.\n</instructions>\n\n' + transcriptPrompt(req.messages);
  let effort = sessionEffort(s, session, `codex:${model}`);
  let st;
  for (;;) {
    st = { text: '', error: null, done: false };
    // `-c key=value` overrides Codex's config for this run; a bare word is taken as a string.
    const { code, stderr } = await runCli('codex', exe, args.concat(effort ? ['-c', `model_reasoning_effort=${effort}`] : [], '-'), input, line => {
      const delta = applyCodexLine(st, line);
      if (delta && hooks.onText) hooks.onText(delta, st.text);
    }, hooks);
    // A model or a Codex that won't take this effort says so: run it again without.
    if (effort && !st.text && /reasoning|effort/i.test(`${st.error || ''} ${stderr}`)) {
      forgetEffort(session, `codex:${model}`);
      effort = '';
      continue;
    }
    if (st.error) throw new LagrangeError(cliErrorMessage('codex', st.error), { kind: 'stream' });
    if (!st.text) throw new LagrangeError(cliErrorMessage('codex', stderr || `exit code ${code}`), { kind: 'stream' });
    break;
  }
  return { text: st.text, stopReason: 'end_turn', stopDetails: null, model: model || 'Codex', fallbackTo: null };
}

/* Settings → "Check": runs `<tool> --version`. Resolves with a sentence for the settings page. */
async function checkCli(which, custom) {
  let exe;
  try { exe = findCli(which === 'claude' ? 'claude' : 'codex', custom); } catch (e) { return e.message; }
  if (!exe) return `Not found. ${CLI[which].install}`;
  try {
    let out = '';
    await runCli(which, exe, ['--version'], '', line => { out += line + ' '; }, {});
    return `Found ${exe}${out.trim() ? ` (${out.trim()})` : ''}. If requests fail, sign in: ${which === 'claude' ? 'run “claude” in a terminal' : 'run “codex login”'}.`;
  } catch (e) { return e.message; }
}

async function streamDemo(req, hooks) {
  const text = typeof req.demo === 'function' ? String(req.demo()) : 'Demo mode has no reply for this.';
  await sleep(req.purpose === 'chat' ? 900 : 1200, hooks.signal);
  const pieces = text.match(/\s*\S+|\s+$/g) || [];
  const pause = req.purpose === 'chat' ? 22 : 0;
  let out = '';
  for (const p of pieces) {
    out += p;
    if (hooks.onText) hooks.onText(p, out);
    if (pause) await sleep(pause, hooks.signal);
  }
  return { text: out, stopReason: 'end_turn', stopDetails: null, model: 'demo', fallbackTo: null };
}

function complete(settings, req, hooks, session) {
  hooks = hooks || {};
  if (settings.provider === 'demo') return streamDemo(req, hooks);
  if (settings.provider === 'openai') return streamOpenAI(settings, req, hooks, session);
  if (settings.provider === 'openai-api') {
    if (!String(settings.openaiPlatformKey || '').trim()) {
      return Promise.reject(new LagrangeError('Add your OpenAI API key in Settings → Lagrange, or choose “ChatGPT: my subscription” to use a ChatGPT plan.', { kind: 'setup' }));
    }
    if (!String(settings.openaiPlatformModel || '').trim()) {
      return Promise.reject(new LagrangeError('Enter an OpenAI model ID in Settings → Lagrange.', { kind: 'setup' }));
    }
    return streamOpenAI(Object.assign({}, settings, { openaiBaseUrl: 'https://api.openai.com/v1', openaiApiKey: settings.openaiPlatformKey, openaiModel: settings.openaiPlatformModel }), req, hooks, session);
  }
  if (settings.provider === 'claude-code') return streamClaudeCode(settings, req, hooks, session);
  if (settings.provider === 'codex') return streamCodex(settings, req, hooks, session);
  return streamAnthropic(settings, req, hooks, session);
}


/* ---- Prompts ---- */

function noteBlock(note, clip) {
  if (!note) return 'No note is open.';
  const where = clip.clipped
    ? ` The note is long (${clip.total} characters), so only the part around the writer’s cursor is included.`
    : '';
  return `The note is titled “${note.title}”.${where}\n\n<note>\n${clip.text}\n</note>`;
}

const CHAT_INTRO =
  'You are Lagrange, a writing companion inside Obsidian. The writer uses Scriptorium, a configuration that ' +
  'sets notes like the pages of a printed book. You talk with the writer about the note they have open: answer ' +
  'questions about it, suggest improvements, and explain your thinking briefly. Write plain, warm, precise prose, ' +
  'and use Markdown lightly (a short list or some emphasis when it helps). Quote the note exactly when you quote ' +
  'it. ';

const CHAT_TALK_ONLY =
  'You cannot change the note yourself; if the writer wants changes made, they can select a passage and run ' +
  '“Lagrange: Revise selection”, or run “Lagrange: Proofread note”.';

// The contract for edits in a chat reply (see splitAgentReply). The model chooses: prose alone answers; a block edits.
const CHAT_AGENTIC =
  'You can also change the note yourself: you have a pen. When the writer asks you to change the note (to fix, ' +
  'rewrite, shorten, expand, add, delete or move something in it), make the change rather than describing it. Say ' +
  'in a sentence or two what you are changing, without repeating the new text, and then end your reply with one ' +
  'block in exactly this form:\n\n' +
  '```lagrange-edits\n' +
  '[{"find": "exact text from the note", "replace": "the new text", "reason": "a few words"},\n' +
  ' {"insert_after": "exact text from the note", "text": "text to add straight after it"},\n' +
  ' {"append": "text to add at the end of the note"}]\n' +
  '```\n\n' +
  'The block holds a JSON array of one or more edits, of these three kinds in any mix ("insert_before" also works). ' +
  'Rules:\n' +
  '- "find" and "insert_after" are copied from the note exactly, character for character (the same quotation marks, ' +
  'dashes, spaces and Markdown marks), and must occur exactly once in the note: include a few neighbouring words when ' +
  'the text is short or repeated.\n' +
  '- "replace" is the new version of exactly the text in "find"; "replace": "" deletes it.\n' +
  '- Keep edits small and separate (a sentence or a paragraph each), and never let two edits overlap.\n' +
  '- Inserted text goes in exactly as written, so begin or end it with the space or the blank line (\\n\\n) it needs; ' +
  'appended text starts a new paragraph by itself.\n' +
  '- The block must be valid JSON: escape quotation marks and backslashes inside strings (so LaTeX is written ' +
  '"\\\\frac{a}{b}"), and write line breaks as \\n.\n' +
  'Your pen writes the edits into the note as soon as your reply ends, and the writer can take them all back with ' +
  'one undo, so do not ask for permission when the request is clear, and do not tell the writer to run a command.\n\n' +
  'When the writer asks a question, wants your opinion or feedback, or it is not clear that they want the note ' +
  'itself changed, answer in prose with no block; you may offer to make the change. Never write a lagrange-edits ' +
  'block for any other purpose, and never more than one in a reply. If no note is open there is nothing to edit.';

function chatSystemPrompt(note, clip, agentic) {
  return CHAT_INTRO + (agentic ? CHAT_AGENTIC : CHAT_TALK_ONLY) + '\n\n' +
    (note ? noteBlock(note, clip) : 'No note is open at the moment; talk with the writer about their writing in general.');
}

const PROOFREAD_SYSTEM =
  'You are Lagrange, a careful proofreader working inside Obsidian. You will receive one note written in Markdown. ' +
  'Find mistakes of spelling, grammar, punctuation and typography, and nothing else: do not rewrite for style, do not ' +
  'change the meaning, and leave Markdown syntax, links, code, YAML front matter and deliberately foreign text (such ' +
  'as Latin placeholder text) as they are.\n\n' +
  'Reply with only a JSON array, with nothing before or after it, in this form:\n' +
  '[{"find": "exact text from the note", "replace": "the corrected text", "reason": "a few words"}]\n\n' +
  'Rules for each edit:\n' +
  '- "find" is copied from the note exactly, character for character (the same quotation marks, dashes, spaces and ' +
  'Markdown marks), and occurs exactly once in the note: include a few neighbouring words when the mistake itself is ' +
  'short or repeated.\n' +
  '- "replace" is the corrected version of exactly that text.\n' +
  '- Keep edits small and separate, and never let two edits overlap.\n' +
  '- "reason" says briefly what was wrong, for example "spelling", "subject–verb agreement" or "missing comma".\n' +
  'If there is nothing to correct, reply with [].';

function proofreadUserMessage(note, clip) {
  return `Proofread this note.\n\n${noteBlock(note, clip)}`;
}

const REVISE_SYSTEM =
  'You are Lagrange, a writing assistant inside Obsidian. You revise one passage of the writer’s note as they ask. ' +
  'Reply with only the revised passage, ready to replace the original: no preamble, no explanation, and no quotation ' +
  'marks or code fences around it. Keep the passage’s Markdown (emphasis, links, headings, line breaks) unless the ' +
  'instruction asks otherwise, and keep the writer’s voice. The rest of the note is there for context only; change ' +
  'nothing outside the passage.';

function reviseUserMessage(note, clip, passage, instruction) {
  return `Instruction: ${instruction}\n\nFor context, the whole note. ${noteBlock(note, clip)}\n\n` +
    `The passage to revise:\n<passage>\n${passage}\n</passage>`;
}


/* ---------------------------------------------------------------------------------------------------------------
 * 4. The loader
 * ------------------------------------------------------------------------------------------------------------- */

// ==== LAGRANGE LOADER (replaceable) ====
// The "Lagrange is thinking" plate. The chat shows it from the moment a request is sent until the first words of the
// reply arrive (or the request fails). Three engravings, drawn in the page's ink: clockwork (gears and a belted
// flywheel), alchemy (a flask distilling into a receiver), and the Earth-Moon system with its five Lagrange
// points. Settings → Lagrange → Loading animation picks one, or "random" (the default) draws a new one each time.
//
// Contract
//   mountLoader(containerEl, theme) -> { stop() }
//     theme  'random' | 'clockwork' | 'alchemy' | 'orbit' (anything else counts as 'random')
//     stop() removes the plate and stops its animation. Called once; calling it again does nothing.
/* Lagrange's loading plates: three ink engravings drawn into an <svg viewBox="0 0 320 240">.
   drawPlate(svg, name, opts) -> stop(); name is 'clockwork' | 'alchemy' | 'orbit'.
   Colours come from CSS variables (--lg-ink, --lg-ink-soft, --lg-rubric, --lg-wash, --lg-plate) so light and dark
   themes both work. opts.still draws one frame and does not animate (prefers-reduced-motion). */
const LagrangePlates = (() => {
  const NS = 'http://www.w3.org/2000/svg';
  let uid = 0;
  const INK = 'var(--lg-ink)', SOFT = 'var(--lg-ink-soft)', RUB = 'var(--lg-rubric)', WASH = 'var(--lg-wash)', PLATE = 'var(--lg-plate)';
  const mk = (tag, attrs, parent) => {
    const e = (parent ? parent.ownerDocument : document).createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  };

  function defs(svg, id, seed) {
    const d = mk('defs', {}, svg);
    const f = mk('filter', { id: `ink${id}`, x: '-5%', y: '-5%', width: '110%', height: '110%' }, d);
    mk('feTurbulence', { type: 'fractalNoise', baseFrequency: '0.035', numOctaves: '2', seed: String(seed), result: 'n' }, f);
    mk('feDisplacementMap', { in: 'SourceGraphic', in2: 'n', scale: '2.4', xChannelSelector: 'R', yChannelSelector: 'G' }, f);
    const p = mk('pattern', { id: `hatch${id}`, width: '4', height: '4', patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(40)' }, d);
    mk('line', { x1: 0, y1: 0, x2: 0, y2: 4, stroke: INK, 'stroke-width': '0.7', opacity: '0.55' }, p);
    const p2 = mk('pattern', { id: `hatchx${id}`, width: '5', height: '5', patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(-35)' }, d);
    mk('line', { x1: 0, y1: 0, x2: 0, y2: 5, stroke: INK, 'stroke-width': '0.6', opacity: '0.35' }, p2);
    return d;
  }
  const inkAttrs = (id, w = 1.5) => ({ filter: `url(#ink${id})`, stroke: INK, fill: 'none', 'stroke-width': String(w), 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });

  function animate(win, step, still) {
    if (still) { step(1500); return () => {}; }
    let on = true, t0 = null;
    const loop = t => { if (!on) return; if (t0 === null) t0 = t; step(t - t0 + 16); win.requestAnimationFrame(loop); };
    win.requestAnimationFrame(loop);
    return () => { on = false; };
  }

  /* ------------------------------------------------------------------ I. Clockwork */
  function gearPath(n, r, add = 5, ded = 6) {
    const pts = [], p = (2 * Math.PI) / n;
    for (let i = 0; i < n; i++) {
      const a = i * p;
      for (const [t, rr] of [[a - p * 0.5, r - ded], [a - p * 0.3, r - ded], [a - p * 0.17, r + add], [a + p * 0.17, r + add], [a + p * 0.3, r - ded]])
        pts.push([Math.cos(t) * rr, Math.sin(t) * rr]);
    }
    return 'M' + pts.map(q => q.map(v => v.toFixed(2)).join(' ')).join('L') + 'Z';
  }
  function gear(svg, id, n, m, cx, cy, spokes) {
    const r = (n * m) / 2;
    const g = mk('g', { transform: `translate(${cx} ${cy})` }, svg);
    const rot = mk('g', {}, g);
    const ink = mk('g', { filter: `url(#ink${id})`, stroke: INK, 'stroke-width': '1.5', 'stroke-linejoin': 'round', fill: 'none' }, rot);
    mk('path', { d: gearPath(n, r), fill: PLATE }, ink);
    mk('circle', { r: r - 11, fill: `url(#hatch${id})`, 'stroke-width': '1' }, ink);
    mk('circle', { r: r - 13 }, ink);
    for (let i = 0; i < spokes; i++) {
      const t = (i * 2 * Math.PI) / spokes, w = 0.12;
      const a1 = [Math.cos(t - w) * 8, Math.sin(t - w) * 8], a2 = [Math.cos(t + w) * 8, Math.sin(t + w) * 8];
      const b1 = [Math.cos(t - w / 2.5) * (r - 13), Math.sin(t - w / 2.5) * (r - 13)], b2 = [Math.cos(t + w / 2.5) * (r - 13), Math.sin(t + w / 2.5) * (r - 13)];
      mk('path', { d: `M${a1}L${b1}L${b2}L${a2}Z`, fill: PLATE }, ink);
    }
    mk('circle', { r: 9, fill: PLATE }, ink);
    mk('circle', { r: 3.2, fill: INK }, ink);
    return { rot, n, cx, cy };
  }
  function clockwork(svg, id, win, still) {
    defs(svg, id, 4);
    const frame = mk('g', inkAttrs(id, 1), svg);
    mk('rect', { x: 8, y: 8, width: 304, height: 224, rx: 3, opacity: .6 }, frame);
    for (const [x, y] of [[18, 18], [302, 18], [18, 222], [302, 222]]) {
      mk('circle', { cx: x, cy: y, r: 4 }, frame); mk('line', { x1: x - 3, y1: y - 1.5, x2: x + 3, y2: y + 1.5 }, frame);
    }
    const m = 5.2;
    const A = gear(svg, id, 22, m, 128, 132, 5);
    const phi1 = -0.62, phi2 = 2.62, dB = (22 + 13) * m / 2, dC = (22 + 11) * m / 2;
    const B = gear(svg, id, 13, m, A.cx + Math.cos(phi1) * dB, A.cy + Math.sin(phi1) * dB, 4);
    const C = gear(svg, id, 11, m, A.cx + Math.cos(phi2) * dC, A.cy + Math.sin(phi2) * dC, 3);
    // a flywheel, belted to a pulley on the great wheel's arbor
    const F = [254, 178], rP = 11, rF = 21;
    const dx = F[0] - A.cx, dy = F[1] - A.cy, dist = Math.hypot(dx, dy), th = Math.atan2(dy, dx), be = Math.acos((rP - rF) / dist);
    const tan = s2 => { const p = th + s2 * be; return [[A.cx + Math.cos(p) * rP, A.cy + Math.sin(p) * rP], [F[0] + Math.cos(p) * rF, F[1] + Math.sin(p) * rF]]; };
    const fw = mk('g', { transform: `translate(${F[0]} ${F[1]})` }, svg);
    const fwr = mk('g', {}, fw);
    const fink = mk('g', inkAttrs(id, 1.4), fwr);
    mk('circle', { r: 29, fill: PLATE }, fink); mk('circle', { r: 25 }, fink);
    for (let i = 0; i < 6; i++) { const t = i * Math.PI / 3; mk('line', { x1: Math.cos(t) * 7, y1: Math.sin(t) * 7, x2: Math.cos(t) * 25, y2: Math.sin(t) * 25 }, fink); }
    mk('circle', { r: rF, 'stroke-width': '2.4', opacity: .9 }, fink);
    mk('circle', { r: 7, fill: `url(#hatch${id})` }, fink);
    mk('circle', { r: 2.5, fill: INK }, fink);
    const pul = mk('g', inkAttrs(id, 1.3), A.rot);
    mk('circle', { r: rP + 2, fill: PLATE }, pul); mk('circle', { r: rP, 'stroke-width': '2.4' }, pul);
    mk('circle', { r: 5, fill: `url(#hatch${id})` }, pul); mk('line', { x1: 0, y1: -rP + 3, x2: 0, y2: -5 }, pul);
    mk('circle', { r: 2.6, fill: INK, stroke: 'none' }, pul);
    const belt = [1, -1].map(s2 => { const [p, q] = tan(s2); return mk('path', { d: `M${p[0].toFixed(2)} ${p[1].toFixed(2)}L${q[0].toFixed(2)} ${q[1].toFixed(2)}`, stroke: INK, 'stroke-width': '1.8', 'stroke-dasharray': '7 3', fill: 'none', filter: `url(#ink${id})` }, svg); });
    // bracket holding the flywheel's axle to the frame
    mk('path', { d: `M${F[0]} ${F[1]} L${F[0] + 34} 226 M${F[0]} ${F[1]} L${F[0] - 24} 226`, ...inkAttrs(id, 1.2) }, svg);
    svg.appendChild(fw);
    const pA = 2 * Math.PI / A.n, pB = 2 * Math.PI / B.n, pC = 2 * Math.PI / C.n;
    const mod = (a, b) => ((a % b) + b) % b;
    const cB = phi1 + Math.PI - pB / 2 + (A.n / B.n) * mod(phi1, pA);
    const cC = phi2 + Math.PI - pC / 2 + (A.n / C.n) * mod(phi2, pA);
    const deg = r => (r * 180 / Math.PI).toFixed(3);
    return animate(win, t => {
      const a = t * 0.00035;
      A.rot.setAttribute('transform', `rotate(${deg(a)})`);
      B.rot.setAttribute('transform', `rotate(${deg(-(A.n / B.n) * a + cB)})`);
      C.rot.setAttribute('transform', `rotate(${deg(-(A.n / C.n) * a + cC)})`);
      fwr.setAttribute('transform', `rotate(${deg(a * rP / rF)})`);
      belt[0].setAttribute('stroke-dashoffset', (-a * rP).toFixed(2));
      belt[1].setAttribute('stroke-dashoffset', (a * rP).toFixed(2));
    }, still);
  }

  /* ------------------------------------------------------------------ II. Alchemy */
  function alchemy(svg, id, win, still) {
    const d = defs(svg, id, 9);
    const cx = 112, cy = 160, R = 50, nh = 11, neckY = cy - Math.sqrt(R * R - nh * nh);
    const cp = mk('clipPath', { id: `bulb${id}` }, d);
    mk('circle', { cx, cy, r: R - 1.5 }, cp);
    const stand = mk('g', inkAttrs(id), svg);
    mk('path', { d: `M${cx - 46} ${cy + 38} L${cx - 58} 228 M${cx + 46} ${cy + 38} L${cx + 58} 228 M${cx - 52} ${cy + 38} H${cx + 52}` }, stand);
    mk('path', { d: `M${cx - 16} 228 L${cx - 12} 214 H${cx + 12} L${cx + 16} 228 Z`, fill: `url(#hatch${id})` }, stand);
    mk('line', { x1: 20, y1: 229, x2: 300, y2: 229, opacity: .7 }, stand);
    const flame = mk('g', { transform: `translate(${cx} 214)` }, svg);
    const fl = mk('path', { d: 'M0 0 C-7 -6 -6 -14 0 -24 C6 -14 7 -6 0 0 Z', fill: WASH, stroke: RUB, 'stroke-width': '1.2', filter: `url(#ink${id})` }, flame);
    const fl2 = mk('path', { d: 'M0 -2 C-3 -6 -3 -10 0 -15 C3 -10 3 -6 0 -2 Z', fill: RUB, opacity: .55 }, flame);
    const liq = mk('g', { 'clip-path': `url(#bulb${id})` }, svg);
    const surf = mk('path', { fill: WASH }, liq);
    const surfH = mk('path', { fill: `url(#hatchx${id})` }, liq);
    const bubbles = mk('g', {}, liq);
    const glass = mk('g', inkAttrs(id), svg);
    mk('path', { d: `M${cx - nh} 52 L${cx - nh} ${neckY} A${R} ${R} 0 1 0 ${cx + nh} ${neckY} L${cx + nh} 52` }, glass);
    mk('path', { d: `M${cx - nh - 3} 50 H${cx + nh + 3}` }, glass);
    mk('path', { d: `M${cx - 30} ${cy - 26} q 8 -10 20 -13`, 'stroke-width': '1', opacity: .5 }, glass);
    mk('rect', { x: cx - nh + 1, y: 40, width: 2 * nh - 2, height: 12, fill: `url(#hatch${id})` }, glass);
    const tube = `M${cx + 2} 40 C ${cx + 4} 14, ${cx + 70} 10, 238 96`;
    mk('path', { d: tube, 'stroke-width': '5' }, glass);
    mk('path', { d: tube, 'stroke-width': '2.4', stroke: PLATE, fill: 'none', 'stroke-linecap': 'round' }, svg);
    const rx = 250, ry = 222;
    const flask = `M${rx - 8} 112 V140 L${rx - 34} ${ry - 4} Q${rx - 36} ${ry + 3} ${rx - 28} ${ry + 3} H${rx + 28} Q${rx + 36} ${ry + 3} ${rx + 34} ${ry - 4} L${rx + 8} 140 V112`;
    const recv = mk('g', inkAttrs(id), svg);
    mk('path', { d: flask }, recv);
    mk('path', { d: `M${rx - 11} 111 H${rx + 11}` }, recv);
    const rclip = mk('clipPath', { id: `recv${id}` }, d);
    mk('path', { d: flask + ' Z' }, rclip);
    const rliq = mk('g', { 'clip-path': `url(#recv${id})` }, svg);
    const rsurf = mk('rect', { x: rx - 40, width: 80, y: 200, height: 40, fill: WASH }, rliq);
    const rsurfH = mk('rect', { x: rx - 40, width: 80, y: 200, height: 40, fill: `url(#hatchx${id})` }, rliq);
    const drops = mk('g', {}, svg);
    const wisps = mk('g', { stroke: SOFT, fill: 'none', 'stroke-width': '1', 'stroke-linecap': 'round', filter: `url(#ink${id})` }, svg);
    const wisp = [0, 1, 2].map(() => mk('path', { opacity: 0 }, wisps));
    const B = [], D = [];
    let lastSpawn = -1e9, lastDrop = -1e9, level = 200, rnd = 7;
    const rand = () => { rnd = (rnd * 16807) % 2147483647; return rnd / 2147483647; };
    const surfaceY = cy - 6;
    return animate(win, t => {
      let dd = `M${cx - R} ${cy + R + 4} L${cx - R} ${surfaceY}`;
      for (let x = cx - R; x <= cx + R; x += 4) dd += ` L${x} ${(surfaceY + Math.sin(x * 0.18 + t * 0.004) * 1.6 + Math.sin(x * 0.07 - t * 0.0027) * 1.2).toFixed(2)}`;
      dd += ` L${cx + R} ${cy + R + 4} Z`;
      surf.setAttribute('d', dd); surfH.setAttribute('d', dd);
      fl.setAttribute('transform', `scale(${(1 + Math.sin(t * 0.021) * 0.06).toFixed(3)} ${(1 + Math.sin(t * 0.017 + 1) * 0.12).toFixed(3)})`);
      fl2.setAttribute('transform', `scale(1 ${(1 + Math.sin(t * 0.025) * 0.15).toFixed(3)})`);
      if (t - lastSpawn > 140) {
        lastSpawn = t;
        B.push({ c: mk('circle', { fill: 'none', stroke: INK, 'stroke-width': '1' }, bubbles), x: cx + (rand() - 0.5) * 60, r: 1 + rand() * 1.5, v: 0.025 + rand() * 0.03, ph: rand() * 6, born: t });
      }
      for (let i = B.length - 1; i >= 0; i--) {
        const b = B[i], age = t - b.born, y = cy + R - 4 - age * b.v;
        if (y < surfaceY - 3) { b.c.remove(); B.splice(i, 1); continue; }
        b.c.setAttribute('opacity', y < surfaceY + 1 ? Math.max(0, 1 - (surfaceY + 1 - y) / 4).toFixed(2) : '1');
        b.c.setAttribute('cx', (b.x + Math.sin(age * 0.006 + b.ph) * 2.5).toFixed(2));
        b.c.setAttribute('cy', y.toFixed(2));
        b.c.setAttribute('r', (b.r + age * 0.003).toFixed(2));
      }
      if (t - lastDrop > 1400) {
        lastDrop = t;
        D.push({ p: mk('path', { d: 'M0 -4 C 2 -1, 2 2, 0 2.5 C -2 2, -2 -1, 0 -4 Z', fill: RUB, opacity: .8 }, drops), born: t, ring: null });
      }
      for (let i = D.length - 1; i >= 0; i--) {
        const q = D[i], a = t - q.born;
        if (!q.ring) {
          const y = 100 + a * a * 0.00012 + a * 0.02;
          if (y >= level) {
            q.p.remove(); q.ring = mk('ellipse', { cx: rx, cy: level, rx: 1, ry: .4, fill: 'none', stroke: INK, 'stroke-width': '.8' }, drops); q.landed = t;
            level = level > 176 ? level - 0.6 : 200;
            rsurf.setAttribute('y', level.toFixed(2)); rsurfH.setAttribute('y', level.toFixed(2));
          } else q.p.setAttribute('transform', `translate(${rx} ${y.toFixed(2)})`);
        } else {
          const k = (t - q.landed) / 500;
          if (k > 1) { q.ring.remove(); D.splice(i, 1); continue; }
          q.ring.setAttribute('rx', (1 + k * 12).toFixed(2)); q.ring.setAttribute('ry', (0.4 + k * 2).toFixed(2)); q.ring.setAttribute('opacity', (1 - k).toFixed(2));
        }
      }
      wisp.forEach((w, i) => {
        const ph = ((t * 0.00025 + i / 3) % 1), y0 = 36 - ph * 26, x0 = cx - 18 + i * 6;
        w.setAttribute('d', `M${x0} ${y0 + 10} c -6 -4, 6 -8, 0 -12 s 6 -8, 0 -12`);
        w.setAttribute('opacity', (Math.sin(ph * Math.PI) * 0.55).toFixed(2));
      });
    }, still);
  }

  /* ------------------------------------------------------------------ III. The five points */
  function orbit(svg, id, win, still) {
    defs(svg, id, 21);
    const mu = 0.01215, Dpx = 92, C = [160, 121];
    // Effective potential in the rotating frame (barycentre at the origin, Earth at -mu, Moon at 1-mu, distance 1).
    const omega = (x, y) => 0.5 * (x * x + y * y) + (1 - mu) / Math.hypot(x + mu, y) + mu / Math.hypot(x - 1 + mu, y);
    const L = { 1: [0.83692, 0], 2: [1.15568, 0], 3: [-1.00506, 0], 4: [0.5 - mu, Math.sqrt(3) / 2], 5: [0.5 - mu, -Math.sqrt(3) / 2] };
    const levels = [omega(...L[1]), omega(...L[2]), omega(...L[3]), omega(...L[4]) - 0.004];
    // marching squares over the frame
    const x0 = -1.62, x1 = 1.62, y0 = -1.28, y1 = 1.28, h = 0.022;
    const nx = Math.round((x1 - x0) / h), ny = Math.round((y1 - y0) / h);
    const grid = [];
    for (let j = 0; j <= ny; j++) { const row = []; for (let i = 0; i <= nx; i++) row.push(Math.min(9, omega(x0 + i * h, y0 + j * h))); grid.push(row); }
    const px = (x, y) => [(x + mu) * Dpx, y * Dpx];           // frame units -> px, Earth at the origin of the group
    const contours = levels.map(lv => {
      let d = '';
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const v = [grid[j][i], grid[j][i + 1], grid[j + 1][i + 1], grid[j + 1][i]];
        const c = [[0, 0], [1, 0], [1, 1], [0, 1]];
        const pts = [];
        for (let e = 0; e < 4; e++) {
          const a = v[e], b = v[(e + 1) % 4];
          if ((a - lv) * (b - lv) < 0) {
            const k = (lv - a) / (b - a), ca = c[e], cb = c[(e + 1) % 4];
            pts.push(px(x0 + (i + ca[0] + (cb[0] - ca[0]) * k) * h, y0 + (j + ca[1] + (cb[1] - ca[1]) * k) * h));
          }
        }
        if (pts.length >= 2) d += `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}L${pts[1][0].toFixed(1)} ${pts[1][1].toFixed(1)}`;
        if (pts.length === 4) d += `M${pts[2][0].toFixed(1)} ${pts[2][1].toFixed(1)}L${pts[3][0].toFixed(1)} ${pts[3][1].toFixed(1)}`;
      }
      return d;
    });
    const back = mk('g', inkAttrs(id, 1), svg);
    mk('rect', { x: 8, y: 8, width: 304, height: 224, rx: 3, opacity: .55 }, back);
    mk('circle', { cx: C[0], cy: C[1], r: Dpx, 'stroke-dasharray': '2 4', opacity: .6, 'stroke-width': '.9' }, back);
    // stars, fixed
    let rnd = 11; const rand = () => { rnd = (rnd * 16807) % 2147483647; return rnd / 2147483647; };
    for (let i = 0; i < 26; i++) {
      const x = 14 + rand() * 292, y = 14 + rand() * 212;
      if (Math.hypot(x - C[0], y - C[1]) < 118) continue;
      mk('path', { d: `M${x - 1.6} ${y}H${x + 1.6}M${x} ${y - 1.6}V${y + 1.6}`, stroke: SOFT, 'stroke-width': '.7' }, svg);
    }
    const frame = mk('g', {}, svg);                  // rotates with the Moon
    const fr = mk('g', {}, frame);
    contours.forEach((d, i) => mk('path', { d, fill: 'none', stroke: i === 3 ? RUB : SOFT, 'stroke-width': i === 3 ? '.8' : '.7', opacity: i === 3 ? '.7' : '.65', 'stroke-linecap': 'round' }, fr));
    // the Moon
    const moon = mk('g', { transform: `translate(${Dpx} 0)` }, fr);
    const mi = mk('g', inkAttrs(id, 1.1), moon);
    mk('circle', { r: 7, fill: PLATE }, mi);
    mk('path', { d: 'M0 -7 A7 7 0 0 1 0 7 A3.5 7 0 0 0 0 -7 Z', fill: `url(#hatch${id})`, stroke: 'none' }, mi);
    for (const [x, y, r] of [[-2.5, -2, 1.3], [1.5, 2.5, 1], [-1, 3.6, .7]]) mk('circle', { cx: x, cy: y, r }, mi);
    // L points: small crosses in rubric
    const crosses = {};
    for (const k of [1, 2, 3, 4, 5]) {
      const [x, y] = px(...L[k]);
      crosses[k] = mk('path', { d: `M${x - 3} ${y - 3}L${x + 3} ${y + 3}M${x + 3} ${y - 3}L${x - 3} ${y + 3}`, stroke: RUB, 'stroke-width': '1.4', 'stroke-linecap': 'round' }, fr);
    }
    // Earth, fixed at the centre (a little globe that turns on its axis)
    const earth = mk('g', { transform: `translate(${C[0]} ${C[1]})` }, svg);
    const ei = mk('g', inkAttrs(id, 1.2), earth);
    mk('circle', { r: 17, fill: PLATE }, ei);
    const shade = mk('path', { fill: `url(#hatch${id})`, stroke: 'none' }, ei);
    mk('ellipse', { rx: 17, ry: 5.5, 'stroke-width': '.8' }, ei);
    mk('line', { x1: -17, y1: 0, x2: 17, y2: 0, 'stroke-width': '.6' }, ei);
    const mer = [0, 1, 2].map(() => mk('ellipse', { rx: 6, ry: 17, 'stroke-width': '.8' }, ei));
    mk('circle', { r: 17 }, ei);
    // labels stay upright: placed each frame at the rotated positions
    const labels = {};
    const off = { 1: [-2, -9], 2: [8, -6], 3: [-16, -6], 4: [7, -5], 5: [7, 11] };
    for (const k of [1, 2, 3, 4, 5]) {
      const t = mk('text', { fill: INK, 'font-size': '13', 'font-style': 'italic', 'font-family': 'var(--lg-display, Georgia, serif)' }, svg);
      t.textContent = 'L';
      const sub = mk('tspan', { 'font-size': '9', dy: '3' }, t); sub.textContent = String(k);
      labels[k] = t;
    }
    const mlab = mk('text', { fill: SOFT, 'font-size': '10', 'font-style': 'italic', 'font-family': 'var(--lg-display, Georgia, serif)' }, svg);
    mlab.textContent = 'Moon';
    const elab = mk('text', { x: C[0] - 13, y: C[1] + 31, fill: SOFT, 'font-size': '10', 'font-style': 'italic', 'font-family': 'var(--lg-display, Georgia, serif)' }, svg);
    elab.textContent = 'Earth';
    return animate(win, t => {
      const th = -t * 2 * Math.PI / 16000 + 0.5;        // one orbit in 16 s, counter-clockwise
      const c = Math.cos(th), s = Math.sin(th);
      frame.setAttribute('transform', `translate(${C[0]} ${C[1]}) rotate(${(th * 180 / Math.PI).toFixed(3)})`);
      for (const k of [1, 2, 3, 4, 5]) {
        const [x, y] = px(...L[k]);
        const X = C[0] + x * c - y * s, Y = C[1] + x * s + y * c;
        labels[k].setAttribute('x', (X + off[k][0]).toFixed(1)); labels[k].setAttribute('y', (Y + off[k][1]).toFixed(1));
      }
      const mx = C[0] + Dpx * c, my = C[1] + Dpx * s;
      mlab.setAttribute('x', (mx - 11).toFixed(1)); mlab.setAttribute('y', (my + 20).toFixed(1));
      const spin = (t * 0.0006) % (2 * Math.PI);
      mer.forEach((m, i) => { const p = spin + i * Math.PI / 3; m.setAttribute('rx', Math.abs(Math.cos(p) * 17).toFixed(2)); });
      shade.setAttribute('d', 'M0 -17 A17 17 0 0 1 0 17 A8 17 0 0 0 0 -17 Z');
    }, still);
  }

  const PLATES = { clockwork, alchemy, orbit };
  const NAMES = Object.keys(PLATES);
  function drawPlate(svg, name, opts = {}) {
    const id = `lgp${++uid}`;
    const win = (svg.ownerDocument && svg.ownerDocument.defaultView) || window;
    return PLATES[name](svg, id, win, !!opts.still);
  }
  return { drawPlate, NAMES };
})();

const LOADER_CAPTIONS = {
  clockwork: 'Lagrange is reckoning',
  alchemy: 'Lagrange is distilling',
  orbit: 'Lagrange is finding the balance',
};
function mountLoader(containerEl, theme) {
  const doc = containerEl.ownerDocument || document;
  const win = doc.defaultView || window;
  const names = LagrangePlates.NAMES;
  const name = names.includes(theme) ? theme : names[Math.floor(Math.random() * names.length)];
  const el = doc.createElement('div');
  el.className = `lagrange-loader lagrange-loader--${name}`;
  el.setAttribute('role', 'status');
  el.setAttribute('aria-label', `${LOADER_CAPTIONS[name]}…`);
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 320 240');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'lagrange-plate');
  el.appendChild(svg);
  const cap = doc.createElement('div');
  cap.className = 'lagrange-loader-caption';
  cap.textContent = LOADER_CAPTIONS[name];
  const dots = doc.createElement('span');
  dots.className = 'lagrange-loader-dots';
  for (let i = 0; i < 3; i++) { const d = doc.createElement('span'); d.textContent = '.'; dots.appendChild(d); }
  cap.appendChild(dots);
  el.appendChild(cap);
  containerEl.appendChild(el);
  let stopAnim = () => {};
  try { stopAnim = LagrangePlates.drawPlate(svg, name, { still: prefersReducedMotion(win) }); } catch (e) { console.error('Lagrange: loader', e); }
  let stopped = false;
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      try { stopAnim(); } catch (e) { /* ignore */ }
      el.remove();
    },
  };
}
// ==== END LAGRANGE LOADER ====


/* ---------------------------------------------------------------------------------------------------------------
 * 5. The pen
 * ------------------------------------------------------------------------------------------------------------- */

/* ---- Pen helpers: shared, kept when the pen is replaced ---- */

function nextFrame(win) {
  return new Promise(resolve => (win || window).requestAnimationFrame(() => resolve()));
}

function prefersReducedMotion(win) {
  try { return (win || window).matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
}

/* Screen rectangles, in viewport coordinates (as getBoundingClientRect gives), covering the document range [from, to]
   of a CodeMirror 6 EditorView: one per visual line, in reading order, each {left, top, right, bottom, width, height}.
   Measured from the DOM CodeMirror has drawn, with view.coordsAtPos as the fallback, so a pen can fly to the text.
   Only the part of the range CodeMirror has drawn is covered; scroll it into view first. An empty range gives one
   zero-width rectangle at the caret position. Read layout only: call it outside view.dispatch. */
function rangeRects(view, from, to) {
  if (to < from) { const t = from; from = to; to = t; }
  const len = view.state.doc.length;
  from = Math.max(0, Math.min(from, len));
  to = Math.max(0, Math.min(to, len));
  const box = (l, t, r, b) => ({ left: l, top: t, right: r, bottom: b, width: r - l, height: b - t });
  if (from === to) {
    const c = view.coordsAtPos(from);
    return c ? [box(c.left, c.top, c.left, c.bottom)] : [];
  }
  const out = [];
  const add = r => {
    if (!r || r.width <= 0.5 || r.height <= 0) return;
    const last = out[out.length - 1];
    if (last && Math.abs(r.top - last.top) < 3 && Math.abs(r.bottom - last.bottom) < 6) {
      out[out.length - 1] = box(Math.min(last.left, r.left), Math.min(last.top, r.top), Math.max(last.right, r.right), Math.max(last.bottom, r.bottom));
    } else {
      out.push(box(r.left, r.top, r.right, r.bottom));
    }
  };
  try {
    const a = view.domAtPos(from), b = view.domAtPos(to);
    const range = view.dom.ownerDocument.createRange();
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
    for (const r of range.getClientRects()) add(r);
  } catch (e) { out.length = 0; }
  if (out.length) return out;
  // Fallback: character by character with coordsAtPos (bounded, for long ranges).
  const step = Math.max(1, Math.ceil((to - from) / 400));
  for (let p = from; p < to; p += step) {
    const s = view.coordsAtPos(p, 1), e = view.coordsAtPos(Math.min(to, p + step), -1);
    if (s && e && Math.abs(s.top - e.top) < 3) add(box(Math.min(s.left, e.left), s.top, Math.max(s.right, e.right), s.bottom));
    else if (s) add(box(s.left, s.top, s.left + 1, s.bottom));
  }
  return out;
}

// ==== LAGRANGE PEN (replaceable) ====
// The pen that sets Lagrange's edits down in the note: a fountain pen flies to each edit, strikes the old words
// through in rubric ink, writes the replacement above the line in its own handwriting, then the change is made and
// the ink lifts off the page. Between edits it hovers; a moment after the last one it flies off.
// Mathematics in a replacement ($…$, $$…$$) is typeset with Obsidian's MathJax and drawn symbol by symbol, the nib
// following each one; if it can't be typeset (no MathJax, or an error) the pen writes its source like other text.
// A short line of ink trails behind the nib as it moves (settings.penTrail) and fades in half a second.
//
// Contract
//   createPen(app, settings) -> { edit(view, from, to, replacement): Promise<void>, destroy() }
//     settings.penSpeed (0.5 slow .. 3 fast) and settings.penTrail are read on every edit. Lagrange calls edit() one
//     edit at a time, in document order, with the editor locked and all changes folded into one undo step; see
//     runEdits.
//   pen.edit(view, from, to, replacement): strike [from, to], write `replacement`, then view.dispatch the change and
//     remove every mark it added. With prefers-reduced-motion the pen does not fly, leaves no trail and draws no
//     equation: the old words dim briefly and the change is made.
//   pen.destroy(): removes the pen, its ink and its decorations from every window, and stops its timers.
function createPen(app, settings) {
  const setGone = StateEffect.define();   // a DecorationSet, or null to clear
  const goneField = StateField.define({
    create: () => Decoration.none,
    update(deco, tr) {
      deco = deco.map(tr.changes);
      for (const e of tr.effects) if (e.is(setGone)) deco = e.value || Decoration.none;
      return deco;
    },
    provide: f => EditorView.decorations.from(f),
  });
  const goneMark = Decoration.mark({ class: 'lagrange-pen-gone' });
  const SVGNS = 'http://www.w3.org/2000/svg';
  const views = new Set();
  const layers = new Map();               // document -> { svg, marks, pen, pos, lift, idle, win, trail }
  const TRAIL_MS = 520, TRAIL_BANDS = 5;  // how long the ink trail lasts, and how many strokes it is drawn in
  let destroyed = false;

  const install = view => {
    if (view.state.field(goneField, false) === undefined) view.dispatch({ effects: StateEffect.appendConfig.of(goneField) });
    views.add(view);
  };
  const mk = (doc, tag, attrs, parent) => {
    const e = doc.createElementNS(SVGNS, tag);
    for (const k in attrs) e.setAttribute(k, String(attrs[k]));
    if (parent) parent.appendChild(e);
    return e;
  };

  function layerFor(doc) {
    let L = layers.get(doc);
    if (L && L.svg.isConnected) return L;
    const svg = mk(doc, 'svg', { class: 'lagrange-pen-layer', 'aria-hidden': 'true' });
    doc.body.appendChild(svg);
    const defs = mk(doc, 'defs', {}, svg);
    const pat = mk(doc, 'pattern', { id: 'lagrange-pen-hatch', width: 3, height: 3, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(80)' }, defs);
    mk(doc, 'rect', { width: 3, height: 3, fill: 'var(--lg-plate)' }, pat);
    mk(doc, 'line', { x1: 0, y1: 0, x2: 0, y2: 3, stroke: 'var(--lg-ink)', 'stroke-width': 0.7, opacity: 0.45 }, pat);
    const trailG = mk(doc, 'g', { class: 'lagrange-pen-trail' }, svg);
    const marks = mk(doc, 'g', {}, svg);
    const pen = mk(doc, 'g', { class: 'lagrange-pen' }, svg);
    // drawn horizontally with the nib's tip at (0, 0), then turned so the barrel rises to the upper right
    const body = mk(doc, 'g', { transform: 'rotate(-38)' }, pen);
    const st = { stroke: 'var(--lg-ink)', 'stroke-width': 1.2, 'stroke-linejoin': 'round' };
    mk(doc, 'path', { d: 'M0 0 L16 -5.2 Q22 -6.5 26 -6 L26 6 Q22 6.5 16 5.2 Z', fill: 'var(--lg-plate)', ...st }, body);   // nib
    mk(doc, 'line', { x1: 2, y1: 0, x2: 17, y2: 0, stroke: 'var(--lg-ink)', 'stroke-width': 0.8 }, body);                     // slit
    mk(doc, 'circle', { cx: 18, cy: 0, r: 1.3, fill: 'var(--lg-ink)' }, body);                                                 // breather hole
    mk(doc, 'path', { d: 'M26 -6.5 H48 Q51 -7.5 54 -8 V8 Q51 7.5 48 6.5 H26 Z', fill: 'var(--lg-ink)', opacity: 0.85 }, body);  // section
    mk(doc, 'path', { d: 'M54 -8.5 H150 Q158 -8.5 160 0 Q158 8.5 150 8.5 H54 Z', fill: 'url(#lagrange-pen-hatch)', ...st }, body); // barrel
    mk(doc, 'rect', { x: 92, y: -9, width: 7, height: 18, fill: 'var(--lg-rubric)', opacity: 0.9 }, body);                    // band
    mk(doc, 'path', { d: 'M100 -9 H140 Q144 -9 144 -6', fill: 'none', stroke: 'var(--lg-ink)', 'stroke-width': 1.6 }, body);  // clip
    pen.style.display = 'none';
    L = { svg, marks, pen, pos: null, lift: 0, idle: 0, win: doc.defaultView || window, trail: { g: trailG, pts: [], paths: [], on: false } };
    layers.set(doc, L);
    return L;
  }

  /* The trail: the nib's recent positions, redrawn each frame as a few strokes that thin and fade with age (see
     trailBands). The loop runs only while there is ink left to fade. */
  const drawTrail = L => {
    const T = L.trail;
    if (destroyed || !L.svg.isConnected) { T.on = false; return; }
    const now = L.win.performance.now();
    while (T.pts.length && now - T.pts[0].t > TRAIL_MS) T.pts.shift();
    const bands = trailBands(T.pts, now, TRAIL_MS, TRAIL_BANDS);
    while (T.paths.length < bands.length) {
      T.paths.push(mk(L.svg.ownerDocument, 'path', { fill: 'none', stroke: 'var(--lg-rubric)', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, T.g));
    }
    T.paths.forEach((path, i) => {
      const b = bands[i];
      if (!b) { path.setAttribute('d', ''); return; }
      path.setAttribute('d', b.d);
      path.setAttribute('opacity', b.opacity);
      path.setAttribute('stroke-width', b.width);
    });
    if (T.pts.length) L.win.requestAnimationFrame(() => drawTrail(L)); else T.on = false;
  };
  const inkTrail = (L, x, y) => {
    const T = L.trail, last = T.pts[T.pts.length - 1];
    if (last && Math.hypot(x - last.x, y - last.y) < 1.2) return;
    T.pts.push({ x, y, t: L.win.performance.now() });
    if (T.pts.length > 240) T.pts.shift();
    if (!T.on) { T.on = true; L.win.requestAnimationFrame(() => drawTrail(L)); }
  };

  const place = (L, x, y) => {
    L.pos = { x, y };
    L.pen.setAttribute('transform', `translate(${x.toFixed(1)} ${(y - L.lift).toFixed(1)}) scale(${(1 + L.lift * 0.012).toFixed(3)})`);
    if (settings && settings.penTrail !== false && L.pen.style.display !== 'none') inkTrail(L, x, y - L.lift);
  };
  const tween = (win, ms, fn) => new Promise(resolve => {
    const t0 = win.performance.now(), dur = Math.max(1, ms);
    const frame = now => {
      if (destroyed) { resolve(); return; }
      const k = Math.min(1, (now - t0) / dur);
      fn(k);
      if (k < 1) win.requestAnimationFrame(frame); else resolve();
    };
    win.requestAnimationFrame(frame);
  });
  const ease = k => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);
  const fly = async (L, x, y, ms, lift = 14) => {
    const a = L.pos ? { ...L.pos } : { x, y };
    const mx = (a.x + x) / 2, my = Math.min(a.y, y) - Math.min(60, 20 + Math.hypot(x - a.x, y - a.y) * 0.15);
    await tween(L.win, ms, k => {
      const e = ease(k), u = 1 - e;
      L.lift = Math.sin(k * Math.PI) * lift;
      place(L, u * u * a.x + 2 * u * e * mx + e * e * x, u * u * a.y + 2 * u * e * my + e * e * y);
    });
    L.lift = 0;
    place(L, x, y);
  };
  /* Obsidian's MathJax, loaded on first use. False where there is none, and the pen then writes the source. */
  const mathReady = async () => {
    try {
      if (typeof obsidian.renderMath !== 'function') return false;
      if (typeof obsidian.loadMathJax === 'function') await Promise.race([obsidian.loadMathJax(), sleep(2500)]);
      return true;
    } catch (e) { return false; }
  };
  /* The symbols of a typeset equation, in the order TeX reads them: MathJax's CHTML output (Obsidian's) has one
     <mjx-c> per character; its SVG output has paths. */
  const mathGlyphs = el => {
    const svg = el.querySelector('svg');
    if (svg) return Array.from(svg.querySelectorAll('use, path, rect')).filter(n => !n.closest('defs'));
    return Array.from(el.querySelectorAll('mjx-c'));
  };
  /* Draws one symbol over ms: an SVG outline is traced by the nib and then filled; a CHTML character is uncovered
     from left to right under it. onX(x) reports how far right (viewport x) the ink has reached. */
  const drawGlyph = async (L, g, ms, onX) => {
    const win = L.win, r = g.getBoundingClientRect();
    if (r.width < 0.5 && r.height < 0.5) { g.style.opacity = ''; g.style.clipPath = ''; return; }
    let outline = null, len = 0, ctm = null;
    if (g.ownerSVGElement) {
      try {
        const href = g.tagName.toLowerCase() === 'use' ? (g.getAttribute('href') || g.getAttribute('xlink:href') || '') : '';
        outline = href ? g.ownerDocument.getElementById(href.replace(/^#/, '')) : g;
        len = outline && outline.getTotalLength ? outline.getTotalLength() : 0;
        ctm = len ? g.getScreenCTM() : null;
      } catch (e) { len = 0; }
    }
    if (Math.hypot(r.left - L.pos.x, r.bottom - L.pos.y) > 6) await fly(L, r.left, r.top + r.height * 0.6, Math.min(110, ms), 3);
    if (len && ctm) {
      g.style.opacity = '';
      g.style.fillOpacity = '0';
      g.style.stroke = 'currentColor';
      g.style.strokeWidth = '34';                     // MathJax draws in thousandths of an em
      g.style.strokeDasharray = String(len);
      await tween(win, ms, t => {
        g.style.strokeDashoffset = (len * (1 - t)).toFixed(1);
        let q = outline.getPointAtLength(len * t);
        q = new win.DOMPoint(q.x, q.y).matrixTransform(ctm);
        place(L, q.x, q.y);
        onX(r.left + r.width * t);
      });
      for (const k of ['fillOpacity', 'stroke', 'strokeWidth', 'strokeDasharray', 'strokeDashoffset']) g.style[k] = '';
    } else {
      g.style.opacity = '';
      await tween(win, ms, t => {
        g.style.clipPath = `inset(-60% ${((1 - t) * 100).toFixed(1)}% -60% -20%)`;
        // down the symbol's left side, then up and across to its right shoulder
        const y = t < 0.45 ? r.top + r.height * (0.25 + t * 1.6) : r.bottom - r.height * (t - 0.45) * 1.3;
        place(L, r.left + r.width * t, y);
        onX(r.left + r.width * t);
      });
      g.style.clipPath = '';
    }
  };

  const park = (L, view) => {
    L.win.clearTimeout(L.idle);
    L.idle = L.win.setTimeout(async () => {
      if (destroyed || !L.pos) return;
      const r = view.dom.getBoundingClientRect();
      await fly(L, r.right + 80, r.top - 60, 700);
      L.pen.style.display = 'none';
      L.pos = null;
    }, 1400);
  };

  return {
    async edit(view, from, to, replacement) {
      if (destroyed) throw new Error('The pen was put away.');
      const doc = view.dom.ownerDocument, win = doc.defaultView || window;
      const still = prefersReducedMotion(win);
      const speed = Number(settings && settings.penSpeed) > 0 ? Number(settings.penSpeed) : 1;
      const k = 1 / speed;
      install(view);
      view.dispatch({ effects: EditorView.scrollIntoView(from, { y: 'center' }) });
      // Wait for the text to stop moving (Typewriter Mode and smooth scrolling keep it moving for a few frames).
      let rects = [], prev = null, steady = 0;
      for (let i = 0; i < 90 && steady < 4; i++) {
        await nextFrame(win);
        rects = rangeRects(view, from, Math.max(from, to));
        const top = rects.length ? rects[0].top : null;
        steady = prev !== null && top !== null && Math.abs(top - prev) < 0.5 ? steady + 1 : 0;
        prev = top;
      }
      if (still || !rects.length) {
        if (to > from) {
          view.dispatch({ effects: setGone.of(Decoration.set([goneMark.range(from, to)])) });
          await sleep(220 * k);
        }
        view.dispatch({ changes: { from, to, insert: replacement }, effects: setGone.of(null) });
        return;
      }
      const L = layerFor(doc);
      win.clearTimeout(L.idle);
      const vr = view.dom.getBoundingClientRect();
      if (!L.pos) place(L, Math.min(win.innerWidth - 20, vr.right + 80), Math.max(10, vr.top - 40));
      L.pen.style.display = '';
      const r0 = rects[0];
      const mid = r => r.top + r.height * 0.58;
      const ink = [];
      try {
        await fly(L, r0.left - 2, mid(r0), 650 * k);
        if (to > from) {
          ink.push(mk(doc, 'circle', { cx: r0.left - 2, cy: mid(r0), r: 1.6, fill: 'var(--lg-rubric)', opacity: 0.8 }, L.marks));
          view.dispatch({ effects: setGone.of(Decoration.set([goneMark.range(from, to)])) });
          for (let i = 0; i < rects.length && !destroyed; i++) {
            const r = rects[i], y0 = mid(r), x0 = r.left - 2, x1 = r.right + 2;
            const p = mk(doc, 'path', {
              d: `M${x0} ${y0} C ${x0 + (x1 - x0) * 0.3} ${y0 - 1.6}, ${x0 + (x1 - x0) * 0.7} ${y0 + 1.6}, ${x1} ${y0 - 0.6}`,
              fill: 'none', stroke: 'var(--lg-rubric)', 'stroke-width': 1.7, 'stroke-linecap': 'round',
            }, L.marks);
            ink.push(p);
            const len = p.getTotalLength();
            p.style.strokeDasharray = String(len);
            p.style.strokeDashoffset = String(len);
            if (i) await fly(L, x0, y0, 240 * k, 6);
            await tween(win, Math.min(len * 3.2, 900) * k, t => {
              p.style.strokeDashoffset = (len * (1 - t)).toFixed(1);
              const q = p.getPointAtLength(len * t);
              place(L, q.x, q.y);
            });
          }
        }
        let hand = null, handEnd = { x: r0.right, y: r0.top };
        const script = replacement && !destroyed ? penScript(replacement, 48) : [];
        if (script.length) {
          hand = doc.createElement('div');
          hand.className = 'lagrange-pen-hand';
          const typeset = script.some(g => g.type === 'math') && await mathReady();
          const pieces = [];
          for (const g of script) {
            const span = doc.createElement('span');
            const m = g.type === 'math' && typeset ? renderPenMath(g.source, g.display, obsidian.renderMath) : null;
            if (m) { span.className = 'lagrange-pen-math'; span.appendChild(m); }
            else span.textContent = g.type === 'math' ? (g.display ? `$$${g.source}$$` : `$${g.source}$`) : g.text;
            hand.appendChild(span);
            pieces.push({ el: span, math: Boolean(m) });
          }
          let fs = (parseFloat(win.getComputedStyle(view.contentDOM).fontSize) || 16) * 1.3;
          hand.style.fontSize = `${fs.toFixed(1)}px`;
          doc.body.appendChild(hand);
          ink.push(hand);
          if (pieces.some(q => q.math)) {
            // MathJax adds the styles for the symbols it used; wait for them, and for the fonts, before measuring.
            try { if (typeof obsidian.finishRenderMath === 'function') await Promise.race([obsidian.finishRenderMath(), sleep(1200)]); } catch (e) { /* drawn as it is */ }
            await nextFrame(win);
          }
          let hb = hand.getBoundingClientRect();
          const room = vr.width - 8;
          if (hb.width > room && room > 40) {              // too wide for the page: write it smaller
            fs = Math.max(fs * 0.55, fs * room / hb.width);
            hand.style.fontSize = `${fs.toFixed(1)}px`;
            hb = hand.getBoundingClientRect();
          }
          const cw = hb.width, ch = hb.height;
          // A replacement is written above the words it replaces. An insertion is written below its place: from
          // the start of the line when it opens a new paragraph (as an append does), else under the caret.
          let cx0 = r0.left + (r0.width - cw) / 2, cy0 = r0.top - ch * (ch > fs * 1.6 ? 0.85 : 0.62);
          if (to === from) {
            cy0 = r0.bottom + 2;
            if (/^\s*\n/.test(replacement) || from === view.state.doc.length) {
              const start = view.coordsAtPos(view.state.doc.lineAt(from).from);
              if (start) cx0 = start.left;
            }
          }
          cx0 = Math.max(vr.left + 4, Math.min(cx0, vr.right - cw - 4));
          cy0 = Math.max(vr.top + 2, Math.min(cy0, vr.bottom - ch - 2));
          hand.style.left = `${cx0}px`;
          hand.style.top = `${cy0}px`;
          // The ink shows up to x (viewport): the hand is uncovered from the left as the nib passes.
          const reveal = x => { hand.style.clipPath = `inset(-0.6em ${Math.max(0, cx0 + cw - x).toFixed(1)}px -0.6em -0.2em)`; };
          const by = cy0 + ch * 0.78;
          for (const piece of pieces) {
            if (destroyed) break;
            const pr = piece.el.getBoundingClientRect();
            const glyphs = piece.math ? mathGlyphs(piece.el) : [];
            if (glyphs.length && glyphs.length <= 90) {
              for (const g of glyphs) g.style.opacity = '0';
              let seen = pr.left;
              reveal(seen);
              const each = Math.min(170, 3600 / glyphs.length) * k;
              for (const g of glyphs) {
                if (destroyed) break;
                await drawGlyph(L, g, each, x => { if (x > seen) { seen = x; reveal(seen); } });
              }
              reveal(pr.right);
            } else {
              if (Math.hypot(pr.left - L.pos.x, by - L.pos.y) > 4) await fly(L, pr.left, by, 280 * k, 6);
              await tween(win, Math.min(2400, pr.width * 9) * k, t => {
                const x = pr.left + pr.width * t;
                reveal(x);
                place(L, x, by + Math.sin((x - cx0) * 0.55) * 3.2 - 2);
              });
            }
          }
          hand.style.clipPath = 'none';
          handEnd = { x: cx0 + cw, y: cy0 };
        }
        await fly(L, Math.min(vr.right - 12, handEnd.x + 30), handEnd.y - 18, 280 * k, 10);
        await sleep(380 * k);
      } finally {
        view.dispatch({ changes: { from, to, insert: replacement }, effects: setGone.of(null) });
        const fade = Math.round(300 * k);
        for (const n of ink) { n.style.transition = `opacity ${fade}ms ease`; n.style.opacity = '0'; }
        win.setTimeout(() => { for (const n of ink) n.remove(); }, fade + 40);
        park(L, view);
      }
    },
    destroy() {
      destroyed = true;
      for (const view of views) {
        try { if (view.state.field(goneField, false) !== undefined) view.dispatch({ effects: setGone.of(null) }); } catch (e) { /* view gone */ }
      }
      views.clear();
      for (const [doc, L] of layers) {
        try { L.win.clearTimeout(L.idle); } catch (e) { /* window closed */ }
        L.svg.remove();
        for (const n of doc.querySelectorAll('.lagrange-pen-hand')) n.remove();
      }
      layers.clear();
    },
  };
}
// ==== END LAGRANGE PEN ====


/* ---------------------------------------------------------------------------------------------------------------
 * 6. Edit runs
 *
 * A run applies one request's edits to an editor. With the pen, each edit is written in turn; meanwhile the editor is
 * locked (not editable, read-only) and no change goes into the undo history. At the end the run's changes are taken
 * back and made again in one transaction, which becomes a single undo step. Without the pen, all edits go in one
 * transaction straight away.
 * ------------------------------------------------------------------------------------------------------------- */

const lockCompartment = new Compartment();

function lockExtension(run) {
  return [
    EditorView.editable.of(false),
    EditorState.readOnly.of(true),
    EditorState.transactionExtender.of(tr => (tr.docChanged ? { annotations: Transaction.addToHistory.of(false) } : null)),
    EditorView.updateListener.of(update => {
      if (run.closed) return;
      for (const tr of update.transactions) if (tr.docChanged) run.composed = run.composed.compose(tr.changes);
    }),
    EditorView.editorAttributes.of({ class: 'lagrange-writing' }),
  ];
}

function setLock(view, content) {
  if (lockCompartment.get(view.state) === undefined) view.dispatch({ effects: StateEffect.appendConfig.of(lockCompartment.of(content)) });
  else view.dispatch({ effects: lockCompartment.reconfigure(content) });
}

/* Applies located edits ({from, to, matched, replace}, in document order, offsets in the current document) to view.
   Returns {applied, skipped, changes, docBefore}: changes is a ChangeSet from docBefore to the document after. */
async function runEdits(view, located, opts) {
  const applied = [];
  const skipped = [];
  const docBefore = view.state.doc;
  if (!opts.pen) {
    const ok = located.filter(e => view.state.sliceDoc(e.from, e.to) === e.matched);
    for (const e of located) if (!ok.includes(e)) skipped.push(Object.assign({}, e, { why: 'the text changed' }));
    if (!ok.length) return { applied, skipped, changes: ChangeSet.empty(docBefore.length), docBefore };
    const changes = ChangeSet.of(ok.map(e => ({ from: e.from, to: e.to, insert: e.replace })), docBefore.length);
    view.dispatch({ changes, userEvent: 'lagrange.edit', scrollIntoView: true });
    return { applied: ok, skipped, changes, docBefore };
  }

  const run = { composed: ChangeSet.empty(docBefore.length), closed: false, cancelled: false };
  const doc = view.dom.ownerDocument;
  const onKey = ev => { if (ev.key === 'Escape') run.cancelled = true; };
  doc.addEventListener('keydown', onKey, true);
  if (opts.signal) opts.signal.addEventListener('abort', () => { run.cancelled = true; }, { once: true });
  setLock(view, lockExtension(run));
  let failure = null;
  try {
    for (const e of located) {
      if (run.cancelled) { skipped.push(Object.assign({}, e, { why: 'stopped' })); continue; }
      const from = run.composed.mapPos(e.from, 1);
      const to = run.composed.mapPos(e.to, -1);
      if (to < from || view.state.sliceDoc(from, to) !== e.matched) {
        skipped.push(Object.assign({}, e, { why: 'the text changed' }));
        continue;
      }
      try {
        // The cursor goes to the edit first, so the edit is on screen even with typewriter scrolling (Typewriter
        // Mode keeps the cursor's line centred).
        view.dispatch({ selection: { anchor: from }, effects: EditorView.scrollIntoView(from, { y: 'center' }) });
        await opts.pen.edit(view, from, to, e.replace);
      } catch (err) {
        failure = err;
        skipped.push(Object.assign({}, e, { why: 'the pen failed' }));
        break;
      }
      applied.push(e);
    }
  } finally {
    doc.removeEventListener('keydown', onKey, true);
    run.closed = true;
    const cs = run.composed;
    if (cs.empty) {
      setLock(view, []);
    } else {
      // Back to the text as it was (outside the history), then all of the run's changes as one undo step.
      view.dispatch({ changes: cs.invert(docBefore), effects: lockCompartment.reconfigure([]), annotations: Transaction.addToHistory.of(false) });
      view.dispatch({ changes: cs, userEvent: 'lagrange.edit' });
    }
  }
  if (failure) {
    const leftover = located.slice(applied.length + skipped.length);
    for (const e of leftover) skipped.push(Object.assign({}, e, { why: 'not attempted' }));
    console.error('Lagrange: the pen failed', failure);
  }
  return { applied, skipped, changes: run.composed, docBefore, failure };
}


/* ---------------------------------------------------------------------------------------------------------------
 * 7. The chat view, the revise modal, the settings tab and the plugin
 * ------------------------------------------------------------------------------------------------------------- */

function renderMarkdown(app, markdown, el, sourcePath, component) {
  if (MarkdownRenderer.render) return MarkdownRenderer.render(app, markdown, el, sourcePath, component);
  return MarkdownRenderer.renderMarkdown(markdown, el, sourcePath, component);
}

let pickerUid = 0;   // radio groups need a name of their own in each picker drawn

class LagrangeChatView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.history = [];           // [{role: 'user'|'assistant', content}], what the model sees
    this.pending = null;         // {controller} while a chat reply is streaming
    this.clipNoted = new Set();  // notes whose clipping the writer has been told about
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return 'Lagrange'; }
  getIcon() { return ICON; }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass('lagrange-view');

    const head = root.createDiv({ cls: 'lagrange-head' });
    const titles = head.createDiv({ cls: 'lagrange-titles' });
    titles.createDiv({ cls: 'lagrange-title', text: 'Lagrange' });
    this.subjectEl = titles.createDiv({ cls: 'lagrange-subject' });
    const actions = head.createDiv({ cls: 'lagrange-actions' });
    const proof = actions.createEl('button', { cls: 'lagrange-icon clickable-icon', attr: { 'aria-label': 'Proofread the note' } });
    setIcon(proof, 'spell-check');
    proof.addEventListener('click', () => {
      const v = this.plugin.targetMarkdownView();
      if (v) this.plugin.proofread(v);
      else new Notice('Open a note to proofread first.');
    });
    const clear = actions.createEl('button', { cls: 'lagrange-icon clickable-icon', attr: { 'aria-label': 'Clear the conversation' } });
    setIcon(clear, 'eraser');
    clear.addEventListener('click', () => this.clear());

    this.logEl = root.createDiv({ cls: 'lagrange-log', attr: { 'aria-live': 'polite' } });
    this.logEl.addEventListener('click', ev => this.onLinkClick(ev));
    this.logEl.addEventListener('scroll', () => { this.stick = this.isNearBottom(); });

    const compose = root.createDiv({ cls: 'lagrange-compose' });
    this.inputEl = compose.createEl('textarea', {
      cls: 'lagrange-input',
      attr: { rows: '2', placeholder: this.plugin.settings.agenticEdits ? 'Ask about this note, or ask for a change…' : 'Ask about this note…', 'aria-label': 'Message to Lagrange' },
    });
    this.inputEl.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
        ev.preventDefault();
        this.send();
      }
    });
    this.inputEl.addEventListener('input', () => this.fitInput());
    const foot = compose.createDiv({ cls: 'lagrange-foot' });
    const left = foot.createDiv({ cls: 'lagrange-foot-left' });
    // The model and effort in use: a button that opens the picker (openPicker).
    this.modelEl = left.createEl('button', {
      cls: 'lagrange-model',
      attr: { type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false' },
    });
    this.modelEl.addEventListener('click', () => (this.picker ? this.closePicker() : this.openPicker()));
    left.createSpan({ cls: 'lagrange-hint', text: 'Enter to send, Shift+Enter for a new line' });
    this.composeEl = compose;
    this.picker = null;
    this.sendEl = foot.createEl('button', { cls: 'lagrange-send', text: 'Send' });
    this.sendEl.addEventListener('click', () => (this.pending ? this.stop() : this.send()));

    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.refreshSubject()));
    this.registerEvent(this.app.workspace.on('file-open', () => this.refreshSubject()));
    this.refreshSubject();
    this.refreshFoot();
    this.showEmpty();
  }

  async onClose() {
    this.stop();
    this.closePicker();
  }

  refreshSubject() {
    if (!this.subjectEl) return;
    const v = this.plugin.targetMarkdownView();
    this.subjectEl.empty();
    if (v && v.file) {
      this.subjectEl.appendText('on ');
      this.subjectEl.createEl('em', { text: v.file.basename });
    } else {
      this.subjectEl.setText('no note open');
    }
  }

  refreshFoot() {
    if (!this.modelEl) return;
    const s = this.plugin.settings;
    this.modelEl.empty();
    this.modelEl.createSpan({ cls: 'lagrange-model-name', text: footLabel(s) });
    this.modelEl.createSpan({ cls: 'lagrange-model-caret', text: '▾', attr: { 'aria-hidden': 'true' } });
    this.modelEl.setAttribute('aria-label', `Model: ${footLabel(s)}. Change the model or the effort`);
    this.modelEl.setAttribute('title', 'Change the model or the effort');
  }

  /* The picker: a small sheet over the footer with the current provider's models (and a field to type another), and
     the reasoning effort. Radio buttons, so the arrow keys move within a group and Tab between groups; Esc, a click
     elsewhere or the button again closes it. Every choice is saved at once. */
  openPicker() {
    if (this.picker || !this.composeEl) return;
    const doc = this.composeEl.ownerDocument;
    const el = this.composeEl.createDiv({ cls: 'lagrange-picker', attr: { role: 'dialog', 'aria-label': 'Model and effort' } });
    const onDown = ev => { if (!el.contains(ev.target) && !this.modelEl.contains(ev.target)) this.closePicker(); };
    const onKey = ev => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      this.closePicker(true);
    };
    doc.addEventListener('mousedown', onDown, true);
    el.addEventListener('keydown', onKey);
    this.picker = { el, close: () => { doc.removeEventListener('mousedown', onDown, true); el.remove(); } };
    this.modelEl.setAttribute('aria-expanded', 'true');
    this.modelEl.addClass('is-open');
    this.drawPicker();
    const first = el.querySelector('input[type="radio"]:checked:not(:disabled), input:not(:disabled), button');
    if (first) first.focus();
  }

  closePicker(refocus) {
    if (!this.picker) return;
    this.picker.close();
    this.picker = null;
    this.modelEl.setAttribute('aria-expanded', 'false');
    this.modelEl.removeClass('is-open');
    if (refocus) this.modelEl.focus();
  }

  drawPicker(focus) {
    if (!this.picker) return;
    const el = this.picker.el, s = this.plugin.settings;
    const choices = modelChoices(s);
    const uid = `lagrange-pick-${++pickerUid}`;
    const save = async keep => { await this.plugin.saveSettings(); this.drawPicker(keep); };
    el.empty();

    const models = el.createEl('fieldset', { cls: 'lagrange-pick-group' });
    const legend = models.createEl('legend');
    legend.createSpan({ text: 'Model' });
    legend.createSpan({ cls: 'lagrange-pick-provider', text: choices.provider });
    for (const o of choices.options) {
      const label = models.createEl('label', { cls: 'lagrange-pick' });
      const input = label.createEl('input', { attr: { type: 'radio', name: `${uid}-model`, value: o.value } });
      input.checked = o.value === choices.current;
      input.addEventListener('change', () => { if (input.checked) { setModel(s, o.value); save(`model:${o.value}`); } });
      label.createSpan({ text: o.label });
    }
    if (choices.free) {
      const row = models.createDiv({ cls: 'lagrange-pick-other' });
      const input = row.createEl('input', {
        cls: 'lagrange-pick-input',
        attr: { type: 'text', placeholder: choices.options.length ? `Another model: ${choices.placeholder}` : choices.placeholder,
          'aria-label': 'Another model', spellcheck: 'false', autocomplete: 'off' },
      });
      const use = () => {
        const v = input.value.trim();
        if (!v || v === choices.current) return;
        setModel(s, v);
        save(`model:${v}`);
      };
      input.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); use(); } });
      input.addEventListener('change', use);
    } else if (!choices.options.length) {
      models.createDiv({ cls: 'lagrange-pick-note', text: 'The demo has no model: its replies are canned.' });
    }

    const can = effortSupported(s);
    const efforts = el.createEl('fieldset', { cls: 'lagrange-pick-group lagrange-pick-efforts' });
    efforts.createEl('legend', { text: 'Effort' });
    if (!can) efforts.disabled = true;
    const row = efforts.createDiv({ cls: 'lagrange-pick-row' });
    for (const [value, name] of [['', 'Default']].concat(EFFORTS.map(e => [e, e[0].toUpperCase() + e.slice(1)]))) {
      const label = row.createEl('label', { cls: 'lagrange-pick' });
      const input = label.createEl('input', { attr: { type: 'radio', name: `${uid}-effort`, value } });
      input.checked = can ? value === s.effort : value === '';
      input.addEventListener('change', () => { if (input.checked) { s.effort = value; save(`effort:${value}`); } });
      label.createSpan({ text: name });
    }
    efforts.createDiv({
      cls: 'lagrange-pick-note',
      text: can ? 'How hard the model thinks before it answers. Default leaves it to the provider.'
        : (s.provider === 'demo' ? 'The demo does no thinking.' : 'This model takes no effort setting.'),
    });

    const foot = el.createDiv({ cls: 'lagrange-pick-foot' });
    const link = foot.createEl('button', { cls: 'lagrange-pick-settings', text: 'Provider and keys…', attr: { type: 'button' } });
    link.addEventListener('click', () => { this.closePicker(); this.plugin.openSettings(); });

    if (focus) {
      const [group, value] = [focus.slice(0, focus.indexOf(':')), focus.slice(focus.indexOf(':') + 1)];
      const again = Array.from(el.querySelectorAll(`input[name="${uid}-${group}"]`)).find(i => i.value === value);
      if (again) again.focus();
    }
  }

  fitInput() {
    const el = this.inputEl;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }

  showEmpty() {
    if (this.logEl.childElementCount) return;
    const e = this.logEl.createDiv({ cls: 'lagrange-empty' });
    e.createDiv({ cls: 'lagrange-fleuron', text: '❦', attr: { 'aria-hidden': 'true' } });
    const s = this.plugin.settings;
    e.createEl('p', {
      text: s.agenticEdits
        ? 'Ask about the note you are writing, or ask for a change: Lagrange reads the open note with each message and edits it with its pen.'
        : 'Ask about the note you are writing. Lagrange reads the open note with each question.',
    });
    const p = e.createEl('p', { cls: 'lagrange-quiet' });
    if (s.agenticEdits) {
      p.appendText('One undo takes back all the edits of a request. ');
      p.createEl('em', { text: 'Revise selection' });
      p.appendText(' and ');
      p.createEl('em', { text: 'Proofread note' });
      p.appendText(' are in the command palette too.');
    } else {
      p.appendText('To have it edit, select a passage and run ');
      p.createEl('em', { text: 'Revise selection' });
      p.appendText(', or run ');
      p.createEl('em', { text: 'Proofread note' });
      p.appendText(', from the command palette.');
    }
    if (s.provider === 'demo') {
      e.createEl('p', { cls: 'lagrange-quiet', text: 'Demo mode: replies and edits are canned, and nothing leaves Obsidian.' });
    } else if ((s.provider === 'claude-code' || s.provider === 'codex') && obsidian.Platform && obsidian.Platform.isDesktopApp === false) {
      const m = e.createEl('p', { cls: 'lagrange-quiet' });
      m.appendText('A subscription works only in Obsidian on a computer. On this device, choose an API key provider (or the Demo): ');
      const a = m.createEl('a', { text: 'open settings', attr: { href: '#' } });
      a.addEventListener('click', ev => { ev.preventDefault(); this.plugin.openSettings(); });
      m.appendText('.');
    }
  }

  clearEmpty() {
    const e = this.logEl.querySelector('.lagrange-empty');
    if (e) e.remove();
  }

  isNearBottom() {
    const el = this.logEl;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  }

  scrollDown(force) {
    if (force || this.stick) this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  clear() {
    this.stop();
    this.history = [];
    this.clipNoted.clear();
    this.logEl.empty();
    this.showEmpty();
  }

  stop() {
    if (this.pending) this.pending.controller.abort();
  }

  setPending(p) {
    this.pending = p;
    this.sendEl.setText(p ? 'Stop' : 'Send');
    this.sendEl.toggleClass('is-stop', Boolean(p));
  }

  onLinkClick(ev) {
    const a = ev.target.closest && ev.target.closest('a.internal-link');
    if (!a) return;
    ev.preventDefault();
    const href = a.getAttribute('data-href') || a.getAttribute('href');
    const v = this.plugin.targetMarkdownView();
    if (href) this.app.workspace.openLinkText(href, (v && v.file && v.file.path) || '', ev.ctrlKey || ev.metaKey);
  }

  addUser(text) {
    this.clearEmpty();
    const el = this.logEl.createDiv({ cls: 'lagrange-turn lagrange-turn--user' });
    el.createDiv({ cls: 'lagrange-turn-text', text });
    this.scrollDown(true);
    return el;
  }

  addAside(text, cls) {
    this.clearEmpty();
    const el = this.logEl.createDiv({ cls: `lagrange-aside ${cls || ''}`.trim(), text });
    this.scrollDown();
    return el;
  }

  /* A reply in the log: a loader until the first words, then Markdown, re-rendered as text streams in. */
  addReply(sourcePath) {
    this.clearEmpty();
    const el = this.logEl.createDiv({ cls: 'lagrange-turn lagrange-turn--reply' });
    const body = el.createDiv({ cls: 'lagrange-turn-body markdown-rendered' });
    let loader = mountLoader(body.createDiv({ cls: 'lagrange-loader-slot' }), this.plugin.settings.loaderTheme);
    let md = '', shown = null, timer = null, comp = null, status = null;
    const render = () => {
      timer = null;
      if (md === shown) return;
      shown = md;
      if (loader) { loader.stop(); loader = null; }
      const next = new Component();
      this.addChild(next);
      const box = createDiv();
      renderMarkdown(this.app, md, box, sourcePath || '', next);
      body.empty();
      body.appendChild(box);
      if (comp) this.removeChild(comp);
      comp = next;
      this.scrollDown();
    };
    return {
      el,
      update: text => {
        md = text;
        if (!timer) timer = window.setTimeout(render, 90);
      },
      // keep: the turn stays in the log although it has no prose (its edits are about to be listed in it)
      finish: (text, keep) => {
        if (timer) { window.clearTimeout(timer); timer = null; }
        if (status) { status.remove(); status = null; }
        md = text;
        if (md) render();
        if (loader) { loader.stop(); loader = null; }
        if (!md) { body.empty(); if (!keep) el.addClass('is-empty'); }
      },
      // one line under the reply while it streams ("Taking up the pen…"); finish() removes it
      status: text => {
        if (!status) status = el.createDiv({ cls: 'lagrange-turn-note is-quiet lagrange-turn-status' });
        if (status.textContent !== text) { status.setText(text); this.scrollDown(); }
      },
      note: (text, cls) => {
        el.createDiv({ cls: `lagrange-turn-note ${cls || ''}`.trim(), text });
        this.scrollDown();
      },
    };
  }

  addError(err, el) {
    const box = (el || this.logEl).createDiv({ cls: 'lagrange-error' });
    box.createSpan({ text: err.message || String(err) });
    if (err.kind === 'setup' || err.status === 401) {
      box.appendText(' ');
      const a = box.createEl('a', { text: 'Open settings', attr: { href: '#' } });
      a.addEventListener('click', ev => { ev.preventDefault(); this.plugin.openSettings(); });
    }
    this.scrollDown();
    return box;
  }

  async send() {
    if (this.pending) return;
    const text = this.inputEl.value.trim();
    if (!text) return;
    this.inputEl.value = '';
    this.fitInput();
    this.stick = true;

    const target = this.plugin.targetMarkdownView();
    const note = this.plugin.noteFrom(target);
    const limit = NOTE_LIMIT[this.plugin.settings.provider] || NOTE_LIMIT.anthropic;
    const clip = note ? clipText(note.text, limit, note.cursor) : null;

    this.addUser(text);
    if (clip && clip.clipped && !this.clipNoted.has(note.path)) {
      this.clipNoted.add(note.path);
      this.addAside(`“${note.title}” is long (${clip.total.toLocaleString()} characters), so Lagrange reads the ` +
        `${(clip.end - clip.start).toLocaleString()} characters around your cursor.`);
    }
    this.history.push({ role: 'user', content: text });
    const reply = this.addReply(note && note.path);
    const controller = new AbortController();
    this.setPending({ controller });
    const settings = this.plugin.settings;
    // With "Edit with the pen" on, the reply may end with edits to the note (parseAgentReply): the chat shows only its
    // prose, and the edits go to the pen once the reply is complete.
    const agentic = Boolean(settings.agenticEdits);
    const prose = full => {
      if (!agentic) return full;
      const part = splitAgentReply(full);
      if (part.blocks.length) reply.status('Taking up the pen…');
      return part.text;
    };
    let partial = '', raw = '';
    try {
      const res = await complete(settings, {
        purpose: 'chat',
        system: chatSystemPrompt(note, clip, agentic),
        messages: this.history.slice(),
        cache: true,
        demo: () => demoChatReply(text, note, agentic),
      }, {
        signal: controller.signal,
        onText: (d, full) => { raw = full; partial = prose(full); reply.update(partial); },
        onRetry: (status, ms) => reply.note(`Busy (${status}); trying again in ${Math.round(ms / 1000)} s…`, 'is-quiet'),
      }, this.plugin.session);
      const parsed = agentic ? parseAgentReply(res.text) : { text: res.text, ops: [], dropped: 0, error: null, open: false };
      const editing = parsed.ops.length > 0 && res.stopReason !== 'refusal';
      reply.finish(parsed.text, editing || Boolean(parsed.error));
      if (res.text && res.stopReason !== 'refusal') this.history.push({ role: 'assistant', content: res.text });
      else this.history.pop();
      if (editing) {
        await this.plugin.applyChatEdits(target, note, parsed, reply, controller.signal);
      } else if (parsed.error) {
        reply.note(`Lagrange meant to edit the note, but its edits could not be read. ${parsed.error}` +
          `${res.stopReason === 'max_tokens' ? ' (The reply reached its length limit.)' : ''} Nothing was changed; ask again.`, 'is-warn');
      }
      if (res.stopReason === 'refusal') {
        const cat = res.stopDetails && res.stopDetails.category;
        reply.note(`Claude declined to continue${cat ? ` (${cat})` : ''}. Try rephrasing the question.`, 'is-warn');
      } else if (res.stopReason === 'max_tokens') {
        reply.note('The reply reached its length limit.', 'is-quiet');
      }
      if (res.fallbackTo) reply.note(`Answered by ${res.fallbackTo} after a refusal.`, 'is-quiet');
    } catch (err) {
      if (isAbort(err)) {
        // Stopped mid-reply: what was said stays; edits that had not finished arriving are not made.
        reply.finish(partial);
        reply.note(raw !== partial && splitAgentReply(raw).blocks.length ? 'Stopped before any edit was made.' : 'Stopped.', 'is-quiet');
        if (partial) this.history.push({ role: 'assistant', content: partial });
        else this.history.pop();
      } else {
        reply.finish(partial);
        this.history.pop();
        if (!partial) reply.el.remove();
        this.addError(err);
        if (!this.inputEl.value) { this.inputEl.value = text; this.fitInput(); }
      }
    } finally {
      this.setPending(null);
    }
  }

  /* A task (proofread, revise) in the log: a heading, a loader while the model works, then the edits. */
  beginTask(title, subtitle, controller) {
    this.clearEmpty();
    this.stick = true;
    const el = this.logEl.createDiv({ cls: 'lagrange-turn lagrange-turn--task' });
    const head = el.createDiv({ cls: 'lagrange-task-head' });
    head.createSpan({ cls: 'lagrange-task-title', text: title });
    if (subtitle) head.createSpan({ cls: 'lagrange-task-subtitle', text: subtitle });
    let stopEl = null;
    if (controller) {
      stopEl = head.createEl('button', { cls: 'lagrange-task-stop', text: 'Stop' });
      stopEl.addEventListener('click', () => controller.abort());
    }
    const status = el.createDiv({ cls: 'lagrange-task-status' });
    let loader = mountLoader(el.createDiv({ cls: 'lagrange-loader-slot' }), this.plugin.settings.loaderTheme);
    const stopLoader = () => { if (loader) { loader.stop(); loader = null; } };
    const end = () => { stopLoader(); if (stopEl) { stopEl.remove(); stopEl = null; } };
    this.scrollDown(true);
    return {
      el,
      status: text => { status.setText(text); this.scrollDown(); },
      stopLoader,
      fail: err => { end(); status.empty(); this.addError(err, el); },
      done: text => { end(); status.setText(text); this.scrollDown(); },
      report: (result, onUndo) => { end(); status.empty(); this.renderReport(el, result, onUndo); },
    };
  }

  renderReport(el, result, onUndo) {
    const { applied, skipped } = result;
    const n = applied.length, m = skipped.length;
    const summary = n
      ? `${n} edit${n === 1 ? '' : 's'} made${m ? `, ${m} skipped` : ''}.`
      : (m ? `No edits made; ${m} skipped.` : 'Nothing to correct.');
    el.createDiv({ cls: 'lagrange-task-summary', text: summary });
    const item = (list, e, why) => {
      const li = list.createEl('li');
      const line = li.createDiv({ cls: 'lagrange-edit-line' });
      if (e.insert) line.createSpan({ cls: 'lagrange-arrow', text: '+ ' });       // an insertion: nothing is struck
      else {
        line.createEl('del', { cls: 'lagrange-del', text: excerpt(e.matched || e.find, 160) });
        line.createSpan({ cls: 'lagrange-arrow', text: ' → ' });
      }
      if (e.replace) line.createEl('ins', { cls: 'lagrange-ins', text: excerpt(e.insert ? e.replace.trim() : e.replace, 160) });
      else line.createEl('span', { cls: 'lagrange-ins is-deletion', text: 'deleted' });
      const reason = why ? `${e.reason ? e.reason + '; ' : ''}skipped: ${why}${e.insert && e.find ? ` (“${excerpt(e.find, 60)}”)` : ''}` : e.reason;
      if (reason) li.createDiv({ cls: 'lagrange-reason', text: reason });
    };
    if (n) {
      const list = el.createEl('ol', { cls: 'lagrange-edits' });
      for (const e of applied) item(list, e);
    }
    if (m) {
      el.createDiv({ cls: 'lagrange-skipped-head', text: 'Skipped' });
      const list = el.createEl('ul', { cls: 'lagrange-edits is-skipped' });
      for (const e of skipped) item(list, e, e.why);
    }
    if (n && onUndo) {
      const b = el.createEl('button', { cls: 'lagrange-undo', text: 'Undo Lagrange’s edits' });
      b.addEventListener('click', () => {
        if (onUndo()) { b.setText('Edits undone'); b.disabled = true; }
      });
    }
    this.scrollDown();
  }
}

class ReviseModal extends Modal {
  constructor(app, passage, onSubmit) {
    super(app);
    this.passage = passage;
    this.onSubmit = onSubmit;
  }

  onOpen() {
    this.modalEl.addClass('lagrange-modal');
    this.titleEl.setText('Revise selection');
    const { contentEl } = this;
    contentEl.createEl('blockquote', { cls: 'lagrange-modal-passage', text: excerpt(this.passage.trim(), 240) });
    const input = contentEl.createEl('textarea', {
      cls: 'lagrange-modal-input',
      attr: { rows: '2', placeholder: 'How should it change? For example: tighter, more formal, a better rhythm', 'aria-label': 'Instruction' },
    });
    const row = contentEl.createDiv({ cls: 'lagrange-modal-buttons' });
    const cancel = row.createEl('button', { text: 'Cancel' });
    const go = row.createEl('button', { cls: 'mod-cta', text: 'Revise' });
    const submit = () => {
      const v = input.value.trim();
      if (!v) { input.focus(); return; }
      this.close();
      this.onSubmit(v);
    };
    input.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); submit(); }
    });
    go.addEventListener('click', submit);
    cancel.addEventListener('click', () => this.close());
    window.setTimeout(() => input.focus(), 0);
  }

  onClose() {
    this.contentEl.empty();
  }
}

class LagrangeSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    const save = async redraw => { await this.plugin.saveSettings(); if (redraw) this.display(); };
    containerEl.empty();
    containerEl.addClass('lagrange-settings');

    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: 'Lagrange sends the open note and your messages to the provider chosen here, and only when you ask it ' +
        'something or run one of its commands. It makes no other network requests and collects nothing.',
    });

    new Setting(containerEl)
      .setName('Provider')
      .setDesc('Who writes the replies and edits.')
      .addDropdown(d => d
        .addOption('claude-code', 'Claude: my subscription (via Claude Code)')
        .addOption('anthropic', 'Claude: API key')
        .addOption('codex', 'ChatGPT: my subscription (via Codex)')
        .addOption('openai-api', 'OpenAI: API key')
        .addOption('openai', 'OpenAI-compatible server (Ollama, LM Studio…)')
        .addOption('demo', 'Demo (offline)')
        .setValue(s.provider)
        .onChange(async v => { s.provider = v; await save(true); }));

    if (s.provider === 'anthropic') {
      new Setting(containerEl).setName('Anthropic').setHeading();
      new Setting(containerEl)
        .setName('API key')
        .setDesc(createFragment(f => {
          f.appendText('Create one at console.anthropic.com. Like other Obsidian AI plugins, Lagrange keeps it in plain ' +
            'text in this vault’s ');
          f.createEl('code', { text: '.obsidian/plugins/lagrange/data.json' });
          f.appendText(' and sends it only to api.anthropic.com; keep that file out of anything you share.');
        }))
        .addText(t => {
          t.inputEl.type = 'password';
          t.inputEl.autocomplete = 'off';
          t.inputEl.spellcheck = false;
          t.setPlaceholder('sk-ant-…').setValue(s.anthropicApiKey).onChange(async v => { s.anthropicApiKey = v.trim(); await save(); });
        });
      new Setting(containerEl)
        .setName('Model')
        .setDesc('Sonnet is quick and capable; Opus is the most careful; Haiku is the fastest and cheapest.')
        .addDropdown(d => {
          for (const m of ANTHROPIC_MODELS) d.addOption(m.id, m.name);
          d.addOption('custom', 'Another model…');
          d.setValue(s.anthropicModel).onChange(async v => { s.anthropicModel = v; await save(true); });
        });
      if (s.anthropicModel === 'custom') {
        new Setting(containerEl)
          .setName('Model ID')
          .setDesc('The exact model ID, as listed in Anthropic’s documentation.')
          .addText(t => t.setPlaceholder('claude-…').setValue(s.anthropicCustomModel)
            .onChange(async v => { s.anthropicCustomModel = v.trim(); await save(); }));
      }
      new Setting(containerEl)
        .setName('Refusal fallback')
        .setDesc('If Claude’s safety screening declines a request, let Anthropic retry it on another Claude model in the ' +
          'same call (a beta feature, for Sonnet 5.5 and Opus 5.5). Turned off automatically if your account lacks it.')
        .addToggle(t => t.setValue(s.refusalFallback).onChange(async v => { s.refusalFallback = v; await save(); }));
    } else if (s.provider === 'claude-code' || s.provider === 'codex') {
      const claude = s.provider === 'claude-code';
      new Setting(containerEl).setName(claude ? 'Claude subscription' : 'ChatGPT subscription').setHeading();
      containerEl.createEl('p', {
        cls: 'setting-item-description',
        text: claude
          ? 'Uses your Claude Pro or Max plan through Claude Code, Anthropic’s command-line tool, signed in to your ' +
            'account: no API key, and requests count against your plan’s usage. Install Claude Code, run “claude” once ' +
            'in a terminal and sign in. Lagrange runs it with every tool, setting file and saved session turned off. ' +
            'Works in Obsidian on a computer only.'
          : 'Uses your ChatGPT Plus or Pro plan through Codex, OpenAI’s command-line tool, signed in to your account: no ' +
            'API key, and requests count against your plan’s usage. Install Codex, run “codex login” and choose “Sign ' +
            'in with ChatGPT”. Lagrange runs it read-only, in a temporary folder, without saving sessions. Works in ' +
            'Obsidian on a computer only.',
      });
      const pathKey = claude ? 'claudeCodePath' : 'codexPath', modelKey = claude ? 'claudeCodeModel' : 'codexModel';
      let status;
      new Setting(containerEl)
        .setName(claude ? 'Claude Code' : 'Codex')
        .setDesc('Leave empty to look in the usual places; or give the full path to the program.')
        .addText(t => t.setPlaceholder(claude ? '~/.local/bin/claude' : '/usr/local/bin/codex').setValue(s[pathKey])
          .onChange(async v => { s[pathKey] = v.trim(); await save(); }))
        .addButton(b => b.setButtonText('Check').onClick(async () => {
          status.setText('Checking…');
          status.setText(await checkCli(claude ? 'claude' : 'codex', s[pathKey]));
        }));
      status = containerEl.createEl('p', { cls: 'setting-item-description lagrange-cli-status' });
      new Setting(containerEl)
        .setName('Model')
        .setDesc(claude ? 'sonnet, opus or haiku (or a full model ID). Empty: Claude Code’s default.'
          : 'A model your plan includes, as Codex names it. Empty: Codex’s default.')
        .addText(t => t.setPlaceholder(claude ? 'sonnet' : 'default').setValue(s[modelKey])
          .onChange(async v => { s[modelKey] = v.trim(); await save(); }));
      if (obsidian.Platform && obsidian.Platform.isDesktopApp === false) {
        containerEl.createEl('p', {
          cls: 'setting-item-description mod-warning',
          text: 'This device can’t run it: a subscription works only in Obsidian on a computer. Choose an API key provider (or the Demo) here.',
        });
      }
    } else if (s.provider === 'openai-api') {
      new Setting(containerEl).setName('OpenAI').setHeading();
      new Setting(containerEl)
        .setName('API key')
        .setDesc('Create one at platform.openai.com. Stored in plain text in this vault’s .obsidian/plugins/lagrange/data.json ' +
          'and sent only to api.openai.com.')
        .addText(t => {
          t.inputEl.type = 'password';
          t.inputEl.autocomplete = 'off';
          t.inputEl.spellcheck = false;
          t.setPlaceholder('sk-…').setValue(s.openaiPlatformKey).onChange(async v => { s.openaiPlatformKey = v.trim(); await save(); });
        });
      new Setting(containerEl)
        .setName('Model')
        .setDesc('The model ID, as listed at platform.openai.com/docs/models.')
        .addText(t => t.setPlaceholder('model ID').setValue(s.openaiPlatformModel)
          .onChange(async v => { s.openaiPlatformModel = v.trim(); await save(); }));
    } else if (s.provider === 'openai') {
      new Setting(containerEl).setName('OpenAI-compatible server').setHeading();
      new Setting(containerEl)
        .setName('Base URL')
        .setDesc('The server’s OpenAI-compatible address, ending in /v1. Ollama: http://localhost:11434/v1; LM Studio: ' +
          'http://localhost:1234/v1. The server must accept requests from Obsidian (CORS): Ollama does by default.')
        .addText(t => t.setPlaceholder('http://localhost:11434/v1').setValue(s.openaiBaseUrl)
          .onChange(async v => { s.openaiBaseUrl = v.trim(); await save(); }));
      new Setting(containerEl)
        .setName('Model')
        .setDesc('The model name the server knows, for example llama3.1 or qwen2.5:14b.')
        .addText(t => t.setPlaceholder('llama3.1').setValue(s.openaiModel)
          .onChange(async v => { s.openaiModel = v.trim(); await save(); }));
      new Setting(containerEl)
        .setName('API key')
        .setDesc('Only if the server asks for one. Stored in plain text in this vault’s .obsidian/plugins/lagrange/data.json.')
        .addText(t => {
          t.inputEl.type = 'password';
          t.inputEl.autocomplete = 'off';
          t.setPlaceholder('optional').setValue(s.openaiApiKey).onChange(async v => { s.openaiApiKey = v.trim(); await save(); });
        });
    } else {
      new Setting(containerEl).setName('Demo').setHeading();
      containerEl.createEl('p', {
        cls: 'setting-item-description',
        text: 'Canned replies and edits, made without a model and without the network: try the chat, the pen and ' +
          'undo without an API key.',
      });
    }

    if (s.provider !== 'demo') {
      const can = effortSupported(s);
      new Setting(containerEl)
        .setName('Effort')
        .setDesc(can ? 'How hard the model thinks before it answers. Also at the foot of the chat, with the model.'
          : 'This model takes no effort setting.')
        .addDropdown(d => {
          d.addOption('', 'The provider’s default');
          for (const e of EFFORTS) d.addOption(e, e[0].toUpperCase() + e.slice(1));
          d.setValue(can ? s.effort : '').onChange(async v => { s.effort = v; await save(); });
        })
        .setDisabled(!can);
    }

    new Setting(containerEl).setName('Editing').setHeading();
    new Setting(containerEl)
      .setName('Edit with the pen from the chat')
      .setDesc('When you ask in the chat for a change to the open note, Lagrange makes it with its pen (one undo takes ' +
        'it back). Off: the chat only talks, and edits come from the Revise selection and Proofread note commands.')
      .addToggle(t => t.setValue(s.agenticEdits).onChange(async v => { s.agenticEdits = v; await save(); }));

    new Setting(containerEl).setName('Appearance').setHeading();
    new Setting(containerEl)
      .setName('Loading animation')
      .setDesc('What the chat shows while Lagrange thinks.')
      .addDropdown(d => d.addOption('random', 'A different plate each time').addOption('clockwork', 'Clockwork').addOption('alchemy', 'Alchemy').addOption('orbit', 'The five Lagrange points')
        .setValue(s.loaderTheme).onChange(async v => { s.loaderTheme = v; await save(); }));
    new Setting(containerEl)
      .setName('Show the pen')
      .setDesc('Write each edit with a pen: strike the old text, write the new, then set it in the note. Off: edits ' +
        'are applied at once. Either way, one undo takes back all the edits of a request.')
      .addToggle(t => t.setValue(s.showPen).onChange(async v => { s.showPen = v; await save(true); }));
    new Setting(containerEl)
      .setName('Pen speed')
      .setDesc('From unhurried (0.5) to brisk (3).')
      .addSlider(sl => sl.setLimits(0.5, 3, 0.25).setValue(s.penSpeed).setDynamicTooltip()
        .onChange(async v => { s.penSpeed = v; await save(); }))
      .setDisabled(!s.showPen);
    new Setting(containerEl)
      .setName('Ink trail')
      .setDesc('A thin line of ink follows the pen as it moves and fades at once. Never shown when your system asks for reduced motion.')
      .addToggle(t => t.setValue(s.penTrail).onChange(async v => { s.penTrail = v; await save(); }))
      .setDisabled(!s.showPen);
  }
}

class LagrangePlugin extends Plugin {
  async onload() {
    // One settings object for the plugin's lifetime: the pen keeps a reference to it.
    this.settings = sanitizeSettings(await this.loadData());
    this.session = { noFallback: false, noEffort: {} };
    this.editing = false;
    this.lastEdit = null;
    this.pen = createPen(this.app, this.settings);

    this.registerEditorExtension([
      lockCompartment.of([]),
      EditorView.updateListener.of(update => this.trackLastEdit(update)),
    ]);
    this.registerView(VIEW_TYPE, leaf => new LagrangeChatView(leaf, this));
    this.addRibbonIcon(ICON, 'Open Lagrange', () => { this.activateView(); });

    this.addCommand({ id: 'open', name: 'Open', callback: () => { this.activateView(); } });
    this.addCommand({
      id: 'revise-selection',
      name: 'Revise selection',
      editorCheckCallback: (checking, editor, ctx) => {
        if (!(ctx instanceof MarkdownView) || !editor.somethingSelected()) return false;
        if (!checking) this.reviseSelection(ctx, editor);
        return true;
      },
    });
    this.addCommand({
      id: 'proofread-note',
      name: 'Proofread note',
      checkCallback: checking => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view || !view.file) return false;
        if (!checking) this.proofread(view);
        return true;
      },
    });
    this.addSettingTab(new LagrangeSettingTab(this.app, this));

    this.lastMarkdownLeaf = null;
    this.registerEvent(this.app.workspace.on('active-leaf-change', leaf => {
      if (leaf && leaf.view instanceof MarkdownView) this.lastMarkdownLeaf = leaf;
    }));
  }

  onunload() {
    if (this.pen) this.pen.destroy();
  }

  async saveSettings() {
    await this.saveData(this.settings);
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view instanceof LagrangeChatView) leaf.view.refreshFoot();
    }
  }

  openSettings() {
    try {
      this.app.setting.open();
      this.app.setting.openTabById(this.manifest.id);
    } catch (e) {
      new Notice('Open Settings → Lagrange.');
    }
  }

  /* Opens the chat in the right sidebar (or finds it) and shows it; focus moves to it only when focus is true, so a
     task started from the editor leaves the cursor where it is. */
  async activateView(focus = true) {
    const ws = this.app.workspace;
    let leaf = ws.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = ws.getRightLeaf(false);
      if (!leaf) return null;
      await leaf.setViewState({ type: VIEW_TYPE, active: focus });
    }
    await ws.revealLeaf(leaf);
    const view = leaf.view instanceof LagrangeChatView ? leaf.view : null;
    if (focus) {
      ws.setActiveLeaf(leaf, { focus: true });
      if (view && view.inputEl) view.inputEl.focus();
    }
    return view;
  }

  /* The note Lagrange talks about: the active Markdown view, or, while the chat itself has focus, the last one. */
  targetMarkdownView() {
    const ws = this.app.workspace;
    const active = ws.getActiveViewOfType(MarkdownView);
    if (active && active.file) return active;
    const last = this.lastMarkdownLeaf;
    if (last && last.view instanceof MarkdownView && last.view.file && last.view.containerEl.isConnected) return last.view;
    const recent = ws.getMostRecentLeaf && ws.getMostRecentLeaf();
    if (recent && recent.view instanceof MarkdownView && recent.view.file) return recent.view;
    const any = ws.getLeavesOfType('markdown').map(l => l.view).find(v => v instanceof MarkdownView && v.file);
    return any || null;
  }

  noteFrom(view) {
    if (!view || !view.file) return null;
    let cursor;
    try {
      if (view.getMode() === 'source') cursor = view.editor.posToOffset(view.editor.getCursor());
    } catch (e) { /* no cursor */ }
    return { title: view.file.basename, path: view.file.path, text: view.getViewData(), cursor };
  }

  /* Watches the editor where Lagrange last made edits, so "Undo Lagrange's edits" still works after later typing. */
  trackLastEdit(update) {
    const le = this.lastEdit;
    if (!le || le.undone || update.view !== le.view || !update.docChanged) return;
    for (const tr of update.transactions) {
      if (tr.docChanged && (tr.isUserEvent('undo') || tr.isUserEvent('redo'))) le.viaHistory = true;
    }
    le.since = le.since.compose(update.changes);
  }

  /* "Undo Lagrange's edits": the editor's own undo if nothing has happened since; the inverse of the edits if the
     text is back as Lagrange left it; the inverse carried through later typing otherwise. After the editor's undo or
     redo has been used, the last of these isn't reliable, so it says to use Undo in the editor instead. */
  undoLastEdit(record) {
    const le = this.lastEdit;
    const stale = () => { new Notice('The note has changed since; use Undo in the editor instead.'); return false; };
    if (!le || le !== record || le.undone) return stale();
    if (!le.view.dom.isConnected) { new Notice('That note is no longer open.'); return false; }
    const doc = le.view.state.doc;
    if (doc.eq(le.docBefore)) { new Notice('Those edits are already undone.'); le.undone = true; return true; }
    if (le.since.empty && le.editor) le.editor.undo();
    else if (doc.eq(le.docAfter)) le.view.dispatch({ changes: le.inverse, userEvent: 'lagrange.undo' });
    else if (!le.viaHistory) le.view.dispatch({ changes: le.inverse.map(le.since), userEvent: 'lagrange.undo' });
    else return stale();
    le.undone = true;
    return true;
  }

  async ensureEditing(view) {
    if (view.getMode() === 'source') return;
    const state = view.leaf.getViewState();
    await view.leaf.setViewState(Object.assign({}, state, { state: Object.assign({}, state.state, { mode: 'source', source: false }) }));
    await nextFrame();
    await nextFrame();
  }

  /* Applies edits that were located in the editor's current text; reports in the chat (if open) and in a notice. */
  async applyEdits(view, located, skippedBefore, task, signal) {
    const cm = view.editor && view.editor.cm;
    let result;
    if (!cm) {
      // No CodeMirror 6 view (should not happen in current Obsidian): apply everything at once through the Editor API.
      const ed = view.editor;
      ed.transaction({ changes: located.map(e => ({ from: ed.offsetToPos(e.from), to: ed.offsetToPos(e.to), text: e.replace })) });
      result = { applied: located, skipped: [] };
    } else {
      const writing = this.settings.showPen ? new Notice('Lagrange is writing… (Esc to stop)', 0) : null;
      try {
        result = await runEdits(cm, located, { pen: this.settings.showPen ? this.pen : null, signal });
      } finally {
        if (writing) writing.hide();
      }
      if (result.failure) {
        this.pen.destroy();
        this.pen = createPen(this.app, this.settings);
      }
      if (this.app.workspace.getActiveViewOfType(MarkdownView) === view) cm.focus();
    }
    const skipped = skippedBefore.concat(result.skipped);
    let record = null;
    if (cm && result.applied.length && result.changes && !result.changes.empty) {
      record = {
        view: cm, editor: view.editor, docBefore: result.docBefore, docAfter: cm.state.doc,
        inverse: result.changes.invert(result.docBefore), since: ChangeSet.empty(cm.state.doc.length),
        viaHistory: false, undone: false,
      };
      this.lastEdit = record;
    }
    const onUndo = record ? () => this.undoLastEdit(record) : null;
    if (task) task.report({ applied: result.applied, skipped }, onUndo);
    const n = result.applied.length;
    if (n) {
      const frag = createFragment(f => {
        f.createSpan({ text: `Lagrange made ${n} edit${n === 1 ? '' : 's'}${skipped.length ? ` (${skipped.length} skipped)` : ''}. ` });
        if (onUndo) {
          const b = f.createEl('button', { cls: 'lagrange-notice-undo', text: 'Undo Lagrange’s edits' });
          b.addEventListener('click', ev => { ev.stopPropagation(); onUndo(); notice.hide(); });
        }
      });
      const notice = new Notice(frag, 10000);
    } else if (!task) {
      new Notice(skipped.length ? `Lagrange made no edits (${skipped.length} skipped).` : 'Lagrange found nothing to change.');
    }
    return result;
  }

  /* Makes the edits a chat reply asked for (parsed: parseAgentReply's result) in the note the message was about, by
     the same road as the commands: located in the editor's current text, written by the pen, one undo step, listed
     under the reply. */
  async applyChatEdits(view, note, parsed, reply, signal) {
    const task = {
      el: reply.el,
      stopLoader: () => {},
      status: text => reply.status(text),
      report: (result, onUndo) => { if (this.chatView()) this.chatView().renderReport(reply.el, result, onUndo); },
      done: text => reply.note(text, 'is-quiet'),
      fail: err => { const v = this.chatView(); if (v) v.addError(err, reply.el); },
    };
    if (!view || !view.file || !note || view.file.path !== note.path || !view.containerEl.isConnected) {
      reply.note('The note is no longer open, so Lagrange’s edits were not made.', 'is-warn');
      return;
    }
    if (this.editing) { reply.note('Lagrange is already editing, so these edits were not made.', 'is-warn'); return; }
    this.editing = true;
    try {
      await this.ensureEditing(view);
      const cm = view.editor && view.editor.cm;
      const docText = cm ? cm.state.doc.toString() : view.editor.getValue();
      const { located, skipped } = locateOps(docText, parsed.ops);
      if (parsed.error) reply.note(`Some of the edits could not be read. ${parsed.error}`, 'is-warn');
      if (parsed.dropped) reply.note(`${parsed.dropped} item${parsed.dropped === 1 ? '' : 's'} in the reply ${parsed.dropped === 1 ? 'was' : 'were'} not an edit and ${parsed.dropped === 1 ? 'was' : 'were'} left out.`, 'is-quiet');
      await this.applyEdits(view, located, skipped, task, signal);
    } catch (err) {
      this.reportFailure(err, task);
    } finally {
      this.editing = false;
    }
  }

  chatView() {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    return leaf && leaf.view instanceof LagrangeChatView ? leaf.view : null;
  }

  async proofread(view) {
    if (this.editing) { new Notice('Lagrange is already editing.'); return; }
    const note = this.noteFrom(view);
    if (!note) return;
    if (!note.text.trim()) { new Notice('This note is empty.'); return; }
    this.editing = true;
    const chat = await this.activateView(false);
    const controller = new AbortController();
    const task = chat ? chat.beginTask('Proofread', note.title, controller) : null;
    try {
      const limit = NOTE_LIMIT[this.settings.provider] || NOTE_LIMIT.anthropic;
      const clip = clipText(note.text, limit, note.cursor);
      if (task && clip.clipped) task.status(`The note is long: proofreading the ${(clip.end - clip.start).toLocaleString()} characters around the cursor.`);
      const res = await complete(this.settings, {
        purpose: 'proofread',
        system: PROOFREAD_SYSTEM,
        messages: [{ role: 'user', content: proofreadUserMessage(note, clip) }],
        demo: () => 'Here are the corrections I would make:\n\n```json\n' +
          JSON.stringify(demoProofreadEdits(note.text), null, 2) + '\n```\n',
      }, { signal: controller.signal }, this.session);
      if (res.stopReason === 'refusal') throw new LagrangeError('Claude declined to proofread this note.');
      const parsed = parseEdits(res.text);
      if (parsed.error) {
        throw new LagrangeError(`${parsed.error}${res.stopReason === 'max_tokens' ? ' (It reached its length limit.)' : ''} ` +
          'Try again, or choose another model.', { reply: res.text });
      }
      if (!parsed.edits.length) {
        if (task) task.report({ applied: [], skipped: [] });
        else new Notice('Lagrange found nothing to correct.');
        return;
      }
      await this.ensureEditing(view);
      const cm = view.editor && view.editor.cm;
      const docText = cm ? cm.state.doc.toString() : view.editor.getValue();
      const { located, skipped } = locateEdits(docText, parsed.edits);
      if (task) task.stopLoader();
      await this.applyEdits(view, located, skipped, task, controller.signal);
    } catch (err) {
      this.reportFailure(err, task);
    } finally {
      this.editing = false;
    }
  }

  reviseSelection(view, editor) {
    if (this.editing) { new Notice('Lagrange is already editing.'); return; }
    const a = editor.getCursor('from'), b = editor.getCursor('to');
    const from = editor.posToOffset(a), to = editor.posToOffset(b);
    const passage = editor.getRange(a, b);
    if (!passage.trim()) { new Notice('Select a passage to revise first.'); return; }
    new ReviseModal(this.app, passage, instruction => { this.revise(view, from, to, passage, instruction); }).open();
  }

  async revise(view, from, to, passage, instruction) {
    if (this.editing) { new Notice('Lagrange is already editing.'); return; }
    const note = this.noteFrom(view);
    if (!note) return;
    this.editing = true;
    const chat = await this.activateView(false);
    const controller = new AbortController();
    const task = chat ? chat.beginTask('Revise', `“${excerpt(instruction, 80)}”`, controller) : null;
    try {
      const limit = NOTE_LIMIT[this.settings.provider] || NOTE_LIMIT.anthropic;
      const clip = clipText(note.text, limit, from);
      const res = await complete(this.settings, {
        purpose: 'revise',
        system: REVISE_SYSTEM,
        messages: [{ role: 'user', content: reviseUserMessage(note, clip, passage, instruction) }],
        demo: () => demoRevise(passage, instruction),
      }, { signal: controller.signal }, this.session);
      if (res.stopReason === 'refusal') throw new LagrangeError('Claude declined to revise this passage.');
      const replacement = cleanRevision(res.text, passage);
      if (replacement === null) throw new LagrangeError('Lagrange returned an empty revision; nothing was changed.');
      if (replacement === passage) {
        if (task) task.done('No change: the passage already reads that way.');
        else new Notice('No change: the passage already reads that way.');
        return;
      }
      const cm = view.editor && view.editor.cm;
      const docText = cm ? cm.state.doc.toString() : view.editor.getValue();
      let at = [from, to];
      if (docText.slice(from, to) !== passage) {
        const hits = findAll(docText, passage);
        if (hits.length !== 1) throw new LagrangeError('The passage changed while Lagrange was working; nothing was changed.');
        at = hits[0];
      }
      const edit = { find: passage, replace: replacement, reason: instruction, from: at[0], to: at[1], matched: passage };
      if (task) task.stopLoader();
      await this.applyEdits(view, [edit], [], task, controller.signal);
    } catch (err) {
      this.reportFailure(err, task);
    } finally {
      this.editing = false;
    }
  }

  reportFailure(err, task) {
    if (isAbort(err)) {
      if (task) task.done('Stopped.');
      return;
    }
    if (!(err instanceof LagrangeError)) console.error('Lagrange', err);
    if (task) {
      task.fail(err);
      if (err.reply) {
        const d = task.el.createEl('details', { cls: 'lagrange-raw' });
        d.createEl('summary', { text: 'The reply' });
        d.createEl('pre', { text: excerpt(err.reply, 4000) });
      }
    } else {
      new Notice(`Lagrange: ${err.message || err}`);
    }
  }
}

module.exports = LagrangePlugin;
// The replaceable pieces and the pure helpers, for plugins-tests/ and for the animation work.
LagrangePlugin.mountLoader = mountLoader;
LagrangePlugin.createPen = createPen;
LagrangePlugin.rangeRects = rangeRects;
LagrangePlugin.internals = {
  DEFAULT_SETTINGS, ANTHROPIC_MODELS, ANTHROPIC_VERSION, FALLBACK_BETA, sanitizeSettings, anthropicModelId,
  LOADER_THEMES, LOADER_CAPTIONS, EFFORTS, CLAUDE_CODE_MODELS, effortSupported, effortFor, modelChoices, setModel, footLabel, modelLabel,
  splitAgentReply, parseAgentReply, locateOps, demoChatEdits, mathSegments, hasMath, penScript, renderPenMath, trailBands,
  createSSEParser, jsonValuesIn, parseEdits, findAll, looseFindAll, locateEdits, clipText, cleanRevision,
  parseErrorBody, describeError, noteStats, excerpt, demoProofreadEdits, demoRevise, demoChatReply,
  applyAnthropicEvent, applyOpenAIEvent, streamAnthropic, streamOpenAI, streamDemo, complete, fetchWithRetry,
  chatSystemPrompt, proofreadUserMessage, reviseUserMessage, runEdits, LagrangeError,
  transcriptPrompt, applyClaudeCodeLine, applyCodexLine, cliErrorMessage, findCli, runCli, streamClaudeCode, streamCodex, checkCli,
};

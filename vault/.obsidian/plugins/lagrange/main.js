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
 *   2. Pure helpers: SSE parsing, edit JSON parsing, locating edits, edits in a chat reply, a look at the page
 *      asked for in one (the request, the part of the page it means, its pages, and the page described in words), the
 *      pen's script (with its mathematics) and trail, clipping notes, error messages, demo replies. They touch
 *      neither the DOM nor Obsidian; plugins-tests/lagrange.test.js tests them under Node.
 *   3. Providers: Anthropic Messages API, OpenAI API and OpenAI-compatible chat completions, a Claude subscription
 *      through Claude Code, a ChatGPT subscription through Codex, Demo (offline). The only requests the plugin makes
 *      are to the provider chosen in its settings, when the writer asks for something.
 *   4. The loader, a replaceable section:  mountLoader(containerEl, theme) -> { stop() }
 *   5. Pen helpers shared by any pen (rangeRects, sleep, nextFrame), then the pen, a replaceable section:
 *      createPen(app, settings) -> { edit(view, from, to, replacement, run, how), finish(), destroy(), extension, pens }
 *      Each replaceable section runs from its "==== LAGRANGE … (replaceable) ====" line to its "==== END …" line,
 *      here and in styles.css.
 *   6. Edit runs: the pen writes each edit in turn, or several pens write the edits that stand well apart on the
 *      page at the same time (penTargets, penWave; the rule itself is penLanes, among the pure helpers); a click or
 *      a key ends the run at once (or the writer edits alongside it), and all of a request's edits become one undo
 *      step
 *   7. The page as rendered: lookAtPage(app, view, spec, opts) sets the note as Reading view does, in a page of its
 *      own that is never shown (renderPage), measures its blocks (measurePage) and takes pictures of the part asked
 *      for (picturePage). Nothing here touches the note, the editor or the workspace.
 *   8. The chat view (with the model and effort picker in its footer), the revise modal, the settings tab and the
 *      plugin. A chat message may edit the note: the reply's edits block goes to the pen (applyChatEdits). A reply
 *      may also ask to look at the page (its look block: the plugin's lookAtPage), and the turn goes on with what
 *      was seen. Each run of edits can be undone and redone (recordEdit, undoEdit, redoEdit), and each message is a
 *      checkpoint the conversation and the note can be rewound to (rewind, restoreNote).
 */
'use strict';

const obsidian = require('obsidian');
const { Plugin, ItemView, Modal, Notice, PluginSettingTab, Setting, MarkdownRenderer, MarkdownView, Component, setIcon } = obsidian;
const { StateField, StateEffect, EditorState, Transaction, ChangeSet, Annotation } = require('@codemirror/state');
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

/* A look at the page (see "Looking at the page" among the pure helpers). A picture is at most LOOK_WIDTH by
   LOOK_HEIGHT pixels: Claude's standard tier takes 1568 on the long edge, and a page of text is still easy to read at
   that size. A look is at most LOOK_PAGES pictures, a message of the writer's at most LOOKS_PER_MESSAGE looks. */
const LOOKS_PER_MESSAGE = 2;
const LOOK_PAGES = 4;
const LOOK_WIDTH = 1024, LOOK_HEIGHT = 1536;
const LOOK_PICTURE_CHARS = 2000000;   // one picture, in base64; a PNG over this is sent as a JPEG instead
const LOOK_DESCRIPTION_CHARS = 6000;  // the page described in words
const LOOK_SOURCE_CHARS = 250000;     // a longer note is rendered around the part asked for only
const LOOK_BLOCKS = 150;              // how many blocks of a look are measured in full (the description holds fewer)
const LOOK_PICTURES = ['auto', 'on', 'off'];

const PEN_MAX = 4;                    // pens that may write at once, at most (the pen's styles know as many; see penLanes)

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
  openaiImageModel: 'gpt-image-2.5-sunburst',   // the Images API model that draws drop caps (OpenAI API provider)
  claudeCodePath: '',                  // Claude subscription via Claude Code; empty = look in the usual places
  claudeCodeModel: 'sonnet',
  codexPath: '',                       // ChatGPT subscription via Codex; empty = look in the usual places
  codexModel: '',
  effort: '',                         // '' (the provider's default) | 'low' | 'medium' | 'high'; see effortFor
  agenticEdits: true,                 // a chat message may edit the open note with the pen; off: the chat only talks
  lookAtPage: true,                   // Lagrange may look at the note as rendered; off: the page is never rendered or captured
  lookPictures: 'auto',               // 'auto' (pictures where the model takes them) | 'on' | 'off' (a description only)
  loaderTheme: 'random',              // 'random' | 'clockwork' | 'alchemy' | 'orbit'
  showPen: true,
  penSpeed: 1,                        // 0.5 (slow) to 3 (fast)
  penTrail: true,                     // a fading line of ink behind the pen's nib as it moves
  penLines: 3,                        // how many lines of a long edit the pen writes out before the rest is set down (1 to 8)
  severalPens: true,                  // edits that stand well apart on the page are written at the same time, each by a pen of its own
  maxPens: 3,                         // how many pens may write at once (2 to 4; see penLanes)
  editWhileWriting: false,            // off: a click or a key in the note ends the pen's animation; on: the writer edits alongside it
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
  if (!(Number.isInteger(s.penLines) && s.penLines >= 1 && s.penLines <= 8)) s.penLines = DEFAULT_SETTINGS.penLines;
  if (!(Number.isInteger(s.maxPens) && s.maxPens >= 2 && s.maxPens <= PEN_MAX)) s.maxPens = DEFAULT_SETTINGS.maxPens;
  if (!EFFORTS.includes(s.effort)) s.effort = '';
  if (!LOOK_PICTURES.includes(s.lookPictures)) s.lookPictures = DEFAULT_SETTINGS.lookPictures;
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

/* Which models take pictures. Every current Claude model does (only Claude 2 and Instant did not); OpenAI's GPT-4o,
   GPT-4.1, GPT-5 and later and the o-series do, except the small early reasoning models and the audio, realtime and
   embedding ones. A local server's model is known by its name where the name says so (LLaVA, a "vision" or "vl"
   model, Gemma 3 and so on); any other is taken to read text only, which the writer can overrule ("Pictures of the
   page" in the settings). */
const ANTHROPIC_TEXT_ONLY_RE = /^claude-(?:2|instant)/i;
const OPENAI_PICTURES_RE = /^(?:gpt-4o|gpt-4\.[15]|gpt-4-turbo|gpt-[5-9]|chatgpt-4o|o[1-9])/i;
const OPENAI_TEXT_ONLY_RE = /^(?:o1-mini|o1-preview|o3-mini)|audio|realtime|transcribe|tts|embedding|instruct/i;
const LOCAL_PICTURES_RE = /vision|llava|moondream|minicpm-?v|pixtral|gemma-?3|qwen[\d.]*-?vl|qvq|internvl|molmo|smolvlm|idefics|cogvlm|paligemma|llama-?4|multimodal|gpt-4o|gpt-4\.1|gpt-[5-9]|claude|gemini/i;

function picturesSupported(s) {
  if (s.provider === 'claude-code' || s.provider === 'codex') return true;
  if (s.provider === 'anthropic') return !ANTHROPIC_TEXT_ONLY_RE.test(anthropicModelId(s));
  if (s.provider === 'openai-api') {
    const m = String(s.openaiPlatformModel || '').trim();
    return OPENAI_PICTURES_RE.test(m) && !OPENAI_TEXT_ONLY_RE.test(m);
  }
  if (s.provider === 'openai') return LOCAL_PICTURES_RE.test(String(s.openaiModel || ''));
  return false;
}

/* The provider and model, as the key under which a session remembers what they would not take. */
function providerKey(s) {
  if (s.provider === 'anthropic') return `anthropic:${anthropicModelId(s)}`;
  if (s.provider === 'openai-api') return `openai:${String(s.openaiPlatformModel || '').trim()}`;
  if (s.provider === 'openai') return `openai:${String(s.openaiModel || '').trim()}`;
  if (s.provider === 'codex') return `codex:${String(s.codexModel || '').trim()}`;
  return s.provider;
}

/* Whether a look sends pictures of the page, or only its description in words: pictures on a computer (they are
   taken there only), when the provider and model take them or the writer says they do, and unless this session has
   seen them refused. The demo has no model to show anything to. */
function lookSendsPictures(s, desktop, session) {
  if (!desktop || s.provider === 'demo' || s.lookPictures === 'off') return false;
  if (session && session.noPictures && session.noPictures[providerKey(s)]) return false;
  return s.lookPictures === 'on' || picturesSupported(s);
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

/* Models are asked to escape backslashes in the JSON they write, and sometimes do not: "$\frac{a}{b}$" then reads
   as a form feed and "rac", "\times" as a tab, and "\alpha" is not JSON at all. Given the text of a reply, this
   doubles the backslashes that are plainly LaTeX's, but only when the reply shows that it was not escaped (it has a
   backslash that no JSON string can hold, or \frac, \beta and the like, and no properly escaped command): then
   every backslash is LaTeX's except \" and the JSON escapes \n, \t, \r, \b, \f where they do not start a LaTeX
   command inside $…$. Text that was escaped properly comes back as it was. */
const LATEX_BF_RE = /^(?:b(?:egin|eta|ar|ig{1,2}[lrm]?|inom|oldsymbol|mod|ot|ullet|oxed|ackslash)|f(?:rac|orall|lat|rown))(?![A-Za-z])/;
const LATEX_NRT_RE = /^(?:n(?:abla|u|eq?|eg|ot(?:in)?|leq|geq|mid|onumber|ewline|i|parallel|subseteq|exists)|r(?:ho|ight(?:arrow)?|angle|ceil|floor|m|brace|[vV]ert)|t(?:heta|au|imes|ext(?:bf|it|rm|sf|tt)?|frac|o|op|anh?|ilde|riangle|ag|herefore|binom))(?![A-Za-z])/;
function repairJsonLatex(text) {
  const s = String(text == null ? '' : text);
  if (s.indexOf('\\') < 0 || /\\\\[A-Za-z]{2,}/.test(s)) return s;
  let evidence = false;
  for (let i = 0; i < s.length && !evidence; i++) {
    if (s[i] !== '\\') continue;
    const n = s[i + 1] || '';
    if (n === '\\') { i++; continue; }
    if (/[bf]/.test(n)) evidence = LATEX_BF_RE.test(s.slice(i + 1, i + 14));
    else if (n === 'u') evidence = !/^u[0-9a-fA-F]{4}/.test(s.slice(i + 1, i + 6));
    else evidence = /[A-Za-z]/.test(n) && !/[nrt]/.test(n);
  }
  if (!evidence) return s;
  let out = '', math = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i], n = s[i + 1] || '';
    if (c === '$') { math = !math; out += c; if (n === '$') { out += n; i++; } continue; }
    if (c === '"') { math = false; out += c; continue; }
    if (c !== '\\') { out += c; continue; }
    if (n === '"' || n === '/') { out += c + n; i++; continue; }
    if (n === '\\') { out += '\\\\\\\\'; i++; continue; }           // LaTeX's line break
    const word = s.slice(i + 1, i + 14);
    let latex = true;
    if (/[bf]/.test(n)) latex = LATEX_BF_RE.test(word) || /^[bf][A-Za-z]/.test(word) && math;
    else if (/[nrt]/.test(n)) latex = math && LATEX_NRT_RE.test(word);
    else if (n === 'u') latex = !/^u[0-9a-fA-F]{4}/.test(word);
    out += latex ? '\\\\' : '\\';
  }
  return out;
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
  const raw = repairJsonLatex(text).trim();
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
  return chainSkipped(doc, located, skipped);
}

/* Edits that build on one another. An edit of a reply may name words that are only in the note once an earlier
   edit of the same reply is made (it rewrites a sentence, then adds one after the new sentence). Such an edit is not
   found in the note as it is; it is looked for in the note as the edits located so far leave it, and joined to the
   edit whose text it touches, so that the two are one change of the note as it is (the pen writes them as one).
   workingText(doc, located) -> {text, spans}: the note with the located edits (sorted, not overlapping) made, and
   where each one's new text stands in it. Pure. */
function workingText(doc, located) {
  let text = '', at = 0;
  const spans = [];
  for (const e of located) {
    text += doc.slice(at, e.from);
    spans.push({ e, start: text.length, end: text.length + e.replace.length });
    text += e.replace;
    at = e.to;
  }
  return { text: text + doc.slice(at), spans };
}

/* Makes one more change, of [a, b) of the working text into `replace`, part of the located edits: an edit of its own
   if it touches none of them, else joined with those it touches. -> the new list of located edits. Pure. */
function foldEdit(doc, located, a, b, replace, extra) {
  const { text, spans } = workingText(doc, located);
  const hit = s => (s.end > a && s.start < b) || (s.start === s.end && a < s.start && s.start < b) || (a === b && s.start <= a && a <= s.end);
  const first = spans.findIndex(hit);
  // where an offset of the working text that is in none of the edits' new text stands in the note
  const inNote = x => { let d = 0; for (const s of spans) if (s.end <= x) d += (s.e.to - s.e.from) - (s.end - s.start); return x + d; };
  if (first < 0) {
    const from = inNote(a), to = inNote(b);
    return located.concat(Object.assign({ find: doc.slice(from, to), matched: doc.slice(from, to), replace, from, to }, extra, from === to ? { insert: true } : {}))
      .sort((x, y) => x.from - y.from || x.to - y.to);
  }
  let last = first;
  for (let i = first; i < spans.length; i++) if (hit(spans[i])) last = i;
  const wa = Math.min(a, spans[first].start), wb = Math.max(b, spans[last].end);
  const from = wa < spans[first].start ? inNote(wa) : spans[first].e.from, to = wb > spans[last].end ? inNote(wb) : spans[last].e.to;
  const joined = spans.slice(first, last + 1).map(s => s.e);
  const reasons = joined.map(e => e.reason).concat(extra && extra.reason).filter(Boolean);
  const merged = {
    find: doc.slice(from, to), matched: doc.slice(from, to), replace: text.slice(wa, a) + replace + text.slice(b, wb),
    reason: Array.from(new Set(reasons)).join('; '), from, to, chained: joined.reduce((n, e) => n + (e.chained || 1), 1),
  };
  if (from === to) merged.insert = true;
  return located.filter(e => !joined.includes(e)).concat(merged).sort((x, y) => x.from - y.from || x.to - y.to);
}

/* Gives the edits that were not found in the note a second look, in the note as the located edits leave it
   (see above). skipped entries: a replacement {find, replace}, or an insertion {insert: true, find: the anchor,
   side: 'after' | 'before', replace: the text}. -> {located, skipped}. Pure. */
function chainSkipped(doc, located, skipped) {
  // (again for as long as one more is placed: an edit may build on one that comes after it in the list)
  for (let n = skipped.length + 1; skipped.length < n;) {
    n = skipped.length;
    const once = chainOnce(doc, located, skipped);
    located = once.located;
    skipped = once.skipped;
  }
  return { located, skipped };
}
function chainOnce(doc, located, skipped) {
  const left = [];
  for (const e of skipped) {
    if (!/not found in the note$/.test(e.why || '') || !e.find || !located.length) { left.push(e); continue; }
    const text = workingText(doc, located).text;
    let hits = findAll(text, e.find);
    if (!hits.length) hits = looseFindAll(text, e.find);
    if (hits.length !== 1) {
      left.push(hits.length ? Object.assign({}, e, { why: `${e.why}, and ${hits.length} times in the note as the edits before it leave it` }) : e);
      continue;
    }
    const [a, b] = hits[0];
    if (e.insert) { const at = e.side === 'before' ? a : b; located = foldEdit(doc, located, at, at, e.replace, { reason: e.reason }); }
    else located = foldEdit(doc, located, a, b, e.replace, { reason: e.reason });
  }
  return { located, skipped: left };
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

/* Splits a chat reply at its blocks of one name (lagrange-edits, lagrange-look): {text, blocks: [string], open}. text
   is the reply without them. `open` is true when the last block has no closing line, as while the reply is still
   streaming, or when it was cut off; everything from its opening line on is then left out of the text. */
function splitBlocks(reply, name) {
  const opening = new RegExp(`(?:^|\\n)[ \\t]*(?:(\`{3,}|~{3,})[ \\t]*${name}\\b[^\\n]*(?:\\n|$)|<${name}>)`, 'i');
  let rest = String(reply == null ? '' : reply);
  let text = '';
  const blocks = [];
  let open = false;
  for (;;) {
    const m = opening.exec(rest);
    if (!m) { text += rest; break; }
    text += rest.slice(0, m.index) + '\n';
    const body = rest.slice(m.index + m[0].length);
    const close = m[1]
      ? new RegExp(`(?:^|\\n)[ \\t]*${m[1][0]}{${m[1].length},}[ \\t]*(?=\\n|$)`).exec(body)
      : new RegExp(`</${name}>`, 'i').exec(body);
    if (!close) { blocks.push(body); open = true; break; }
    blocks.push(body.slice(0, close.index));
    rest = body.slice(close.index + close[0].length);
  }
  return { text: text.replace(/\n{3,}/g, '\n\n').trim(), blocks, open };
}

/* Splits a chat reply into the prose to show and the edit blocks: {text, blocks: [string], open}, as splitBlocks
   describes. */
function splitAgentReply(reply) {
  return splitBlocks(reply, 'lagrange-edits');
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
  for (const written of blocks) {
    const block = repairJsonLatex(written);
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
  const skip = (o, find, why) => skipped.push({ find, matched: '', replace: o.text, reason: o.reason, why, insert: true, side: o.after ? 'after' : 'before' });
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
  return chainSkipped(doc, located, skipped);
}

/* ---- Looking at the page ----
   The model reads the note's Markdown; the writer reads the page Scriptorium sets from it. A chat reply may therefore
   ask to look at the page: after its prose, one block
       ```lagrange-look
       {"target": "note"}
       ```
   (or the same between <lagrange-look> and </lagrange-look>). The target is the whole note, "view" (what the writer
   has on screen), a section by its heading, a passage by words from it, or a range of source lines. The plugin sets
   the note as Reading view does, in a page that is never shown, measures its blocks and takes pictures of the part
   asked for (section 7), and the model's turn goes on with them in a new message. A reply may hold an edits block
   too: the pen writes first, and the look shows the page as it then stands. At most LOOKS_PER_MESSAGE looks follow
   one message of the writer's, and with "Let Lagrange look at the rendered page" off there are none. */

/* What a look block asks for: {target: 'note'}, {target: 'view'}, {target: 'section', heading}, {target: 'passage',
   near} or {target: 'lines', from, to}; and {target: 'auto'} (the whole note if it is short, else what is on screen)
   when the block says nothing that can be read, since a model that asks to look should be shown something.
   Forgiving about the shape: {"heading": "…"}, {"lines": [12, 40]}, {"lines": "12-40"}, a list of one request, and
   the bare words note, view, "section: …" and "lines 12-40" are understood too. */
function normalizeLook(value) {
  const auto = { target: 'auto' };
  if (Array.isArray(value)) return value.length ? normalizeLook(value[0]) : auto;
  if (typeof value === 'string') {
    const t = value.replace(/\s+/g, ' ').trim().replace(/^["'“‘]+|["'”’.]+$/g, '').trim();
    let m;
    if (/^(?:the )?(?:whole |entire |full )?(?:note|page|document|all|everything)$/i.test(t)) return { target: 'note' };
    if (/^(?:the )?(?:current |visible )?(?:view|viewport|screen|window|visible)$/i.test(t)) return { target: 'view' };
    if ((m = /^(?:section|heading)\s*[:=]?\s*(.+)$/i.exec(t))) return normalizeLook({ heading: m[1] });
    if ((m = /^lines?\s*[:=]?\s*(\d+)(?:\s*(?:-|–|—|to|,|\.\.)\s*(\d+))?$/i.exec(t))) return normalizeLook({ from: m[1], to: m[2] === undefined ? m[1] : m[2] });
    if ((m = /^(?:passage|near|find)\s*[:=]\s*(.+)$/i.exec(t))) return normalizeLook({ near: m[1] });
    return auto;
  }
  if (!value || typeof value !== 'object') return auto;
  const str = keys => { for (const k of keys) if (typeof value[k] === 'string' && value[k].trim()) return value[k].trim(); return ''; };
  const target = str(['target', 'look', 'at', 'region', 'what']).toLowerCase();
  const named = target ? normalizeLook(target) : auto;
  if (named.target === 'note' || named.target === 'view') return named;
  const heading = str(['heading', 'section']).replace(/^#+\s*/, '');
  const near = str(['near', 'passage', 'find', 'quote', 'text']);
  let from = value.from, to = value.to;
  const lines = value.lines !== undefined ? value.lines : value.range;
  if (Array.isArray(lines)) [from, to] = lines;
  else if (typeof lines === 'number') from = to = lines;
  else if (typeof lines === 'string') { const m = /(\d+)(?:\D+(\d+))?/.exec(lines); if (m) { from = m[1]; to = m[2] === undefined ? m[1] : m[2]; } }
  if (to === undefined || to === null || to === '') to = from;
  from = Math.floor(Number(from)); to = Math.floor(Number(to));
  const ranged = Number.isFinite(from) && Number.isFinite(to) && from >= 1 && to >= 1;
  const range = { target: 'lines', from: Math.min(from, to), to: Math.max(from, to) };
  // what the target names, if what it needs is there; otherwise whatever is there
  if (heading && /^(?:section|heading)/.test(target)) return { target: 'section', heading };
  if (near && /^(?:passage|near)/.test(target)) return { target: 'passage', near };
  if (ranged && /^line/.test(target)) return range;
  if (heading) return { target: 'section', heading };
  if (near) return { target: 'passage', near };
  if (ranged) return range;
  return named;
}

/* A chat reply's look: {text, look, open}. text is the reply without its look blocks (its edits block is still in
   it, for parseAgentReply); look is what the first of them asks for, or null if there is none; open is true while a
   look block has no closing line (as while the reply streams). */
function parseLookReply(reply) {
  const { text, blocks, open } = splitBlocks(reply, 'lagrange-look');
  if (!blocks.length) return { text, look: null, open: false };
  let look = null;
  for (const value of jsonValuesIn(blocks[0])) { look = normalizeLook(value); break; }
  return { text, look: look || normalizeLook(blocks[0]), open };
}

/* What a look is of, in words for the chat and for the model. */
function lookLabel(spec) {
  const s = spec || {};
  if (s.target === 'note') return 'the whole note';
  if (s.target === 'view') return 'what is on screen';
  if (s.target === 'section') return `the section “${excerpt(s.heading, 60)}”`;
  if (s.target === 'passage') return `the passage near “${excerpt(s.near, 60)}”`;
  if (s.target === 'lines') return s.from === s.to ? `line ${s.from}` : `lines ${s.from} to ${s.to}`;
  return 'the page';
}

/* Which source lines each rendered block comes from. Obsidian's parser gives the note's sections ({type, from, to},
   lines counted from 0) and its renderer one element for each, in the same order, except that a footnote's
   definition, a link's definition and a comment render nothing where they stand, and the footnotes come as one
   <section> at the foot. tags are the elements' tag names. Returns [{from, to} | null], one for each element (lines
   counted from 1), or null when the two do not go together (an HTML block with blank lines in it is one element but
   several sections), and then nothing is said about lines. */
const SECTION_TAGS = { heading: /^h[1-6]$/, paragraph: /^p$/, blockquote: /^blockquote$/, list: /^[uo]l$/, table: /^table$/, thematicBreak: /^hr$/, yaml: /^pre$/ };
const SECTION_SILENT = new Set(['footnoteDefinition', 'definition', 'comment', 'text', 'element']);
function alignSections(sections, tags) {
  const list = Array.isArray(sections) ? sections : [];
  const out = [];
  let k = 0;
  for (const tag of tags) {
    if (tag === 'section') { out.push(null); continue; }
    while (k < list.length && SECTION_SILENT.has(list[k].type)) k++;
    const s = list[k++];
    if (!s) return null;
    const want = SECTION_TAGS[s.type];
    if (want && !want.test(tag)) return null;
    out.push({ from: s.from + 1, to: s.to + 1 });
  }
  for (; k < list.length; k++) if (!SECTION_SILENT.has(list[k].type)) return null;
  return out;
}

/* The source to render for a look. A note of ordinary length is rendered whole, so that everything that depends on
   what comes before (which paragraph opens a chapter, the numbering of footnotes) comes out as in Reading view. A
   note longer than limit characters would take too long: then only the part around `line` (counted from 1) is
   rendered, cut where a blank line stands, after the note's front matter. Returns {text, shift, cut}: a line of the
   part after its front matter is that line number plus shift in the note, and cut says whether anything was left
   out. */
function lookSource(text, line, limit) {
  text = String(text == null ? '' : text);
  if (text.length <= limit) return { text, shift: 0, cut: false };
  const front = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  const head = front ? front[0] : '';
  const starts = [0];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  const at = starts[Math.max(0, Math.min(starts.length - 1, (Number(line) || 1) - 1))];
  let from = Math.max(head.length, Math.min(text.length - limit, Math.round(at - limit / 3)));
  let to = Math.min(text.length, from + limit);
  if (from > head.length) { const gap = text.indexOf('\n\n', from); from = gap >= 0 && gap < to - 2 ? gap + 2 : from; }
  if (to < text.length) { const gap = text.lastIndexOf('\n\n', to); if (gap > from) to = gap + 1; }
  let first = 0;
  while (first + 1 < starts.length && starts[first + 1] <= from) first++;
  const headLines = head ? head.split('\n').length - 1 : 0;
  return { text: head + text.slice(from, to), shift: first - headLines, cut: true };
}

/* The blocks of the page a look is of: {first, last, remark}, indices into blocks (measurePage's records: {kind,
   level, text, from, to, …}), or null when the page has no blocks. remark says, for the model, why it is shown
   something other than it asked for (a heading that is not there, lines that cannot be told), or is ''. ctx: {seen:
   {from, to} | {texts} | null, what the writer has on screen (visibleLines); near: {from, to} | null, the lines
   holding the words of a passage}. A passage is shown with the block before it and the block after. 'auto' is the
   whole note here; lookAtPage turns it into what is on screen when the note is too long for one look. */
function lookRange(spec, blocks, ctx) {
  const n = blocks.length;
  if (!n) return null;
  const whole = remark => ({ first: 0, last: n - 1, remark: remark || '' });
  const byLines = (from, to) => {
    let first = -1, last = -1;
    for (let i = 0; i < n; i++) {
      const b = blocks[i];
      if (!(b.from >= 1) || b.to < from || b.from > to) continue;
      if (first < 0) first = i;
      last = i;
    }
    if (first >= 0) return { first, last };
    // no block holds those lines (they are blank, or between blocks): the block that follows them, or the last
    let next = blocks.findIndex(b => b.from >= 1 && b.from > to);
    if (next < 0) { for (let i = n - 1; i >= 0; i--) if (blocks[i].from >= 1) { next = i; break; } }
    return next < 0 ? null : { first: next, last: next };
  };
  const norm = t => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const s = spec || {};
  if (s.target === 'section') {
    const want = norm(String(s.heading || '').replace(/^#+\s*/, ''));
    const heads = blocks.map((b, i) => ({ b, i })).filter(x => x.b.kind === 'heading' || x.b.kind === 'title');
    const hit = heads.find(x => norm(x.b.text) === want) || heads.find(x => want && norm(x.b.text).includes(want));
    if (!hit) return whole(`No heading reads “${excerpt(s.heading, 80)}”, so this is the whole note.`);
    if (hit.b.kind === 'title') return whole('');
    let last = n - 1;
    for (let i = hit.i + 1; i < n; i++) if (blocks[i].kind === 'heading' && blocks[i].level <= hit.b.level) { last = i - 1; break; }
    return { first: hit.i, last, remark: '' };
  }
  if (s.target === 'lines' || s.target === 'passage') {
    const lines = s.target === 'lines' ? { from: s.from, to: s.to } : ctx && ctx.near;
    if (!lines) return whole(`Those words were not found in the note${s.target === 'passage' ? ' (or are there more than once)' : ''}, so this is the whole note.`);
    const r = byLines(lines.from, lines.to);
    if (!r) return whole('The page’s blocks could not be matched to the note’s lines, so this is the whole note.');
    if (s.target === 'passage') { r.first = Math.max(0, r.first - 1); r.last = Math.min(n - 1, r.last + 1); }
    return { first: r.first, last: r.last, remark: '' };
  }
  if (s.target === 'view') {
    const seen = ctx && ctx.seen;
    let r = null;
    if (seen && seen.from >= 1) r = byLines(seen.from, seen.to);
    else if (seen && Array.isArray(seen.texts) && seen.texts.length) {
      // the blocks in sight, by their words: the first and the last of them that have words and are on the page
      // say where the others (a picture, a rule) are, since the page has the same blocks in the same order
      const words = b => norm(b.key !== undefined ? b.key : b.text);
      const texts = seen.texts.map(norm), m = texts.length;
      let a = -1, i = -1, z = -1, j = -1;
      for (let k = 0; k < m && i < 0; k++) if (texts[k]) { i = blocks.findIndex(b => words(b) === texts[k]); a = k; }
      for (let k = m - 1; k >= 0 && j < 0; k--) {
        if (!texts[k]) continue;
        for (let q = n - 1; q >= Math.max(i, 0); q--) if (words(blocks[q]) === texts[k]) { j = q; break; }
        z = k;
      }
      if (i >= 0 && j >= 0) r = { first: Math.max(0, i - a), last: Math.min(n - 1, j + (m - 1 - z)) };
    }
    if (r) return { first: r.first, last: Math.max(r.first, r.last), remark: '' };
    return whole('What is on screen could not be told, so this is the note from its beginning.');
  }
  return whole('');
}

/* How much a page of the given width (in CSS pixels) is scaled for its pictures: never enlarged, and no wider than
   LOOK_WIDTH pixels. */
function lookScale(width) {
  return width > LOOK_WIDTH ? LOOK_WIDTH / width : 1;
}

/* Cuts the stretch of the page from top to bottom (CSS pixels) into pictures no taller than height: [{top, bottom}],
   at most max of them, and `more`, how many further pictures the rest would have taken. A picture ends where a block
   ends (breaks: the tops of the blocks) if that leaves it at least half full; a block taller than a picture is cut
   through, and the next picture then begins a little earlier (overlap), so that the line cut through is whole in it. */
function lookPages(top, bottom, breaks, height, max, overlap) {
  const pages = [];
  let more = 0, y = top;
  const cuts = (breaks || []).slice().sort((a, b) => a - b);
  for (let guard = 0; y < bottom - 1 && guard < 10000; guard++) {
    let end = Math.min(bottom, y + height), next = end;
    if (end < bottom) {
      let cut = null;
      for (const c of cuts) { if (c > end) break; if (c >= y + height / 2) cut = c; }
      if (cut !== null) end = next = cut;
      else next = Math.max(y + 1, end - (overlap || 0));
    }
    if (pages.length < max) pages.push({ top: y, bottom: end }); else more++;
    y = next;
  }
  return { pages, more };
}

/* The page of a look in words, for a model that takes no pictures and beside the pictures for one that does (what
   is measured is exact where an eye judges): a line about the page, then one line for each block. look: {title,
   label, page: {width, column: {left, width}, theme, font, size, margin, cut}, blocks, pictures: [{top, bottom}],
   more, remarks}. A block: {kind, level, text, from, to, top, bottom, align, font, size, italic, smallCaps, lines,
   dropcap: {letter, font, size, image}, firstLineCaps, overflow, notes: [{label, where}], math: [source], images:
   [{alt, width, height, broken}], items, rows, cols, language, callout, inMargin}. No more than limit characters:
   the blocks that do not fit are counted. */
function describeLook(look, limit) {
  const px = v => `${Math.round(v * 10) / 10} px`;
  const page = look.page || {};
  const head = [`“${look.title}”, set as in Reading view (${page.theme === 'dark' ? 'dark' : 'light'} theme)`];
  if (page.width) head.push(`pane ${Math.round(page.width)} px wide`);
  if (page.column && page.column.width) head.push(`text column ${Math.round(page.column.width)} px wide, ${Math.round(page.column.left)} px from the left`);
  if (page.font) head.push(`body text ${page.font}${page.size ? ` ${px(page.size)}` : ''}`);
  const lines = [`The page: ${head.join('; ')}.`];
  if (page.margin) lines.push('Footnotes and margin notes are set in the right margin, beside the lines they belong to.');
  const pictures = look.pictures || [];
  const pictureOf = b => {
    for (let i = 0; i < pictures.length; i++) if (b.top < pictures[i].bottom - 1 && b.bottom > pictures[i].top) return i + 1;
    return 0;
  };
  const ALIGN = { left: 'flush left', right: 'flush right', center: 'centred', justify: 'justified', full: 'the full width of the column' };
  const one = (b, k) => {
    const parts = [];
    const where = b.from >= 1 ? (b.from === b.to ? `line ${b.from}` : `lines ${b.from}–${b.to}`) : '';
    let name = b.kind === 'heading' ? `heading ${b.level}` : b.kind;
    if (b.kind === 'callout') name = b.inMargin ? 'margin note' : `callout (${b.callout || 'note'})`;
    if (b.kind === 'code' && b.language) name = `code (${b.language})`;
    if (b.kind === 'list') name = `list of ${b.items} item${b.items === 1 ? '' : 's'}`;
    if (b.kind === 'table') name = `table, ${b.rows} row${b.rows === 1 ? '' : 's'} by ${b.cols}`;
    parts.push(`${k}. ${name}${where ? `, ${where}` : ''}${b.text ? `: “${excerpt(b.text, 56)}”` : ''}`);
    if (b.inMargin) parts.push('set in the margin');
    else if (b.align && b.kind !== 'rule') parts.push(ALIGN[b.align] || b.align);
    if (b.dropcap) {
      parts.push(`drop cap “${b.dropcap.letter}” (${b.dropcap.image ? 'a picture' : b.dropcap.font || 'a large initial'}` +
        `${b.dropcap.size ? `, ${px(b.dropcap.size)}` : ''}${b.dropcap.deep ? `, ${b.dropcap.deep} lines deep` : ''})`);
    }
    if (b.firstLineCaps) parts.push('first line in small capitals');
    if (b.font) parts.push(`${b.font} ${px(b.size)}${b.italic ? ' italic' : ''}${b.smallCaps ? ' small capitals' : ''}`);
    if (b.lines) parts.push(`${b.lines} line${b.lines === 1 ? '' : 's'}`);
    for (const m of (b.math || []).slice(0, 4)) parts.push(`math $${excerpt(m, 90)}$`);
    if (b.math && b.math.length > 4) parts.push(`${b.math.length - 4} more formulas`);
    for (const im of (b.images || []).slice(0, 3)) {
      parts.push(`picture${im.alt ? ` “${excerpt(im.alt, 40)}”` : ''} ${Math.round(im.width)}×${Math.round(im.height)} px` +
        `${im.broken ? ' (did not load)' : ''}${im.remote ? ' (from the web)' : ''}`);
    }
    for (const note of (b.notes || []).slice(0, 6)) parts.push(`footnote ${note.label} ${note.where === 'margin' ? 'in the margin' : 'at the foot'}`);
    if (b.overflow > 1) parts.push(`${Math.round(b.overflow)} px too wide for its column${b.scrolls ? ' (it scrolls)' : ''}`);
    const p = pictureOf(b);
    if (p && pictures.length > 1) parts.push(`picture ${p}`);
    return parts.join(' | ');
  };
  const blocks = look.blocks || [];
  let used = lines.join('\n').length, shown = 0;
  for (; shown < blocks.length; shown++) {
    const line = one(blocks[shown], shown + 1);
    if (used + line.length + 1 > limit - 80 && shown > 0) break;
    lines.push(line);
    used += line.length + 1;
  }
  if (shown < blocks.length) lines.push(`… and ${blocks.length - shown} more block${blocks.length - shown === 1 ? '' : 's'}, not described.`);
  return lines.join('\n');
}

/* The message that carries a look to the model: {content, alt, kept}. content is the message as it is sent: a list
   of parts when there are pictures ([{type: 'image', mediaType, data}, …, {type: 'text', text}]), else text. alt is
   the same in words alone, for a provider that turns the pictures down; kept is what stays in the conversation
   afterwards (the pictures are sent once and not kept). opts: {left, how many looks remain for this message; by:
   'writer' when the writer showed the page with the command, with text, their message; failed, a sentence, when the
   page could not be looked at}. */
function lookMessage(look, opts) {
  const o = opts || {};
  const carry = o.by === 'writer'
    ? `The writer has shown you the page as it is rendered, above. Their message:\n\n${o.text || ''}`
    : 'That is your look at the page. ' + (o.left > 0
      ? `You may look ${o.left === 1 ? 'once more' : `${o.left} more times`} for this message, if you need another part of it. `
      : 'You cannot look again for this message. ') + 'Now carry on with your reply to the writer.';
  if (o.failed) {
    const text = `<rendered_page>\nThe page could not be looked at: ${o.failed}\n</rendered_page>\n\n` +
      (o.by === 'writer' ? o.text || '' : 'Carry on with your reply to the writer from the note’s source, and say that you could not look at the page.');
    return { content: text, alt: text, kept: text };
  }
  const pictures = look.pictures || [];
  const n = pictures.length, total = n + (look.more || 0);
  const part = `The page of “${look.title}” as Reading view renders it: ${look.label}` +
    `${look.page && look.page.cut ? ' (the note is very long, so only the part around it was rendered)' : ''}. ` +
    (look.page && look.page.properties ? `The note’s properties stand above its text, as the view shows them (${look.page.properties}).` : 'The note’s properties are not shown on the page.');
  const remarks = (look.remarks || []).map(r => `\n${r}`).join('');
  const rest = look.more ? ` They are the first ${n} of ${total} pages of it: look at a section, a passage or a range of lines to see further on.` : '';
  const text = how => `<rendered_page>\n${part} ${how}${remarks}\n\n${look.description}\n</rendered_page>\n\n${carry}`;
  const measured = ' What follows was measured on the page.';
  const seen = `${n === 1 ? 'One picture of it is' : `${n} pictures of it are`} attached${n > 1 ? ', in reading order' : ''}.${rest}${measured}`;
  const told = (look.problem ? `No picture of it could be taken (${look.problem}), so` : 'There is no picture of it:') +
    ' here it is in words, as measured on the page.';
  const was = `${n === 1 ? 'One picture of it was' : `${n} pictures of it were`} shown to you at this point; ` +
    `${n === 1 ? 'it is' : 'they are'} not kept in the conversation.${rest}${measured}`;
  if (!n) return { content: text(told), alt: text(told), kept: text(told) };
  const content = pictures.map(p => ({ type: 'image', mediaType: p.mediaType, data: p.data })).concat([{ type: 'text', text: text(seen) }]);
  return { content, alt: text('It could not be shown to you as a picture: here it is in words, as measured on the page.'), kept: text(was) };
}

/* A look in a line, for the chat: what it was of, and how it was shown. */
function lookCaption(look) {
  const n = (look.pictures || []).length;
  const label = look.label.charAt(0).toUpperCase() + look.label.slice(1);
  if (!n) return `${label}, in words${look.problem ? ' (no picture could be taken)' : ''}`;
  return `${label}, in ${n === 1 ? 'one picture' : `${n} pictures`}${look.more ? ` (the first ${n} of ${n + look.more} pages)` : ''} and its measurements`;
}

/* Who a look goes to, for the writer. */
function lookRecipient(s) {
  if (s.provider === 'demo') return 'Demo mode: nothing is sent anywhere.';
  const who = { anthropic: 'Anthropic', 'claude-code': 'Anthropic, through Claude Code', 'openai-api': 'OpenAI', codex: 'OpenAI, through Codex',
    openai: `your server at ${String(s.openaiBaseUrl || '').trim() || 'the address in the settings'}` }[s.provider] || 'the provider chosen in the settings';
  return `A look goes to ${who} (${modelLabel(s)}) with the conversation, and to no one else.`;
}

/* A message's words, whatever shape its content has: the text of its parts, with a line where each picture was. */
function messageText(m) {
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  if (!Array.isArray(m.content)) return '';
  let k = 0;
  return m.content.map(p => (p && p.type === 'image' ? `[Picture ${++k} of the page is attached.]` : (p && typeof p.text === 'string' ? p.text : ''))).filter(Boolean).join('\n\n');
}

/* The pictures in a list of messages, in order: [{mediaType, data}]. */
function messagePictures(messages) {
  const out = [];
  for (const m of messages || []) if (m && Array.isArray(m.content)) for (const p of m.content) if (p && p.type === 'image' && p.data) out.push(p);
  return out;
}

/* The messages in words alone: each message with pictures becomes its alt (see lookMessage), or its text. */
function withoutPictures(messages) {
  return (messages || []).map(m => (m && Array.isArray(m.content) ? { role: m.role, content: typeof m.alt === 'string' ? m.alt : messageText(m) } : { role: m.role, content: m.content }));
}

/* The messages as the Messages API takes them: text as it is, a picture as an image block with its bytes in base64
   (pictures first, then the words about them, which is the order Claude reads best). */
function anthropicMessages(messages) {
  return (messages || []).map(m => ({
    role: m.role,
    content: !Array.isArray(m.content) ? m.content : m.content.map(p => (p.type === 'image'
      ? { type: 'image', source: { type: 'base64', media_type: p.mediaType || 'image/png', data: p.data } }
      : { type: 'text', text: p.text })),
  }));
}

/* The messages as chat completions take them: a picture is an image_url part holding a data URL. */
function openaiMessages(messages) {
  return (messages || []).map(m => ({
    role: m.role,
    content: !Array.isArray(m.content) ? m.content : m.content.map(p => (p.type === 'image'
      ? { type: 'image_url', image_url: { url: `data:${p.mediaType || 'image/png'};base64,${p.data}` } }
      : { type: 'text', text: p.text })),
  }));
}

/* Text that an XML parser takes: the characters XML 1.0 has no place for (control characters, lone surrogates) are
   left out. A page is drawn from its markup as XML (picturePage), and one such character would spoil all of it. */
function xmlSafe(text) {
  return String(text == null ? '' : text).replace(/[^\x09\x0A\x0D\x20-퟿-�\u{10000}-\u{10FFFF}]/gu, '');
}

/* The page of a note as the picture a browser can draw: its markup (XHTML) inside an SVG of the page's size. The
   root's font size is the document's, so that rem lengths come out the same. */
function pageSvg(xhtml, width, height, rootFontSize) {
  const w = Math.ceil(width), h = Math.ceil(height);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"` +
    `${rootFontSize ? ` style="font-size:${String(rootFontSize).replace(/[^0-9a-z.%]/gi, '')}"` : ''}>` +
    `<foreignObject x="0" y="0" width="${w}" height="${h}">${xmlSafe(xhtml)}</foreignObject></svg>`;
}

/* The addresses in a style rule's text that are not data already: [{whole, url}], whole being the url(…) as written. */
function cssUrls(text) {
  const out = [];
  const re = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s]+))\s*\)/g;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const url = m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3];
    if (url && !/^(?:data:|#)/i.test(url) && !out.some(o => o.whole === m[0])) out.push({ whole: m[0], url });
  }
  return out;
}

/* ---- Rewinding a conversation ----
   Each message the writer sends is a checkpoint: {text, historyLength, path, before, after, expired}. historyLength
   is how long the model's history was before the message; path is the note it was about; before is that note's text
   when the message was sent and after its text once the turn was over (null: there was no change to remember, or
   the checkpoint has expired). Rewinding to a checkpoint drops it and everything after it from the conversation,
   puts the message back to be edited, and can put the note back to `before`. */

const CHECKPOINTS_KEPT = 20;          // how many checkpoints keep their copy of the note
const CHECKPOINT_CHARS = 4000000;     // and how many characters those copies may hold in all

/* The conversation as it was before checkpoint k: {history, checkpoints}. */
function rewindTo(history, checkpoints, k) {
  const cp = checkpoints[k];
  if (!cp) return { history: history.slice(), checkpoints: checkpoints.slice() };
  return { history: history.slice(0, Math.max(0, cp.historyLength)), checkpoints: checkpoints.slice(0, k) };
}

/* Whether the note of checkpoint k holds changes that are not Lagrange's own since that checkpoint: typing between
   turns, or after the last one. `current` is the note's text now. Each turn is known to have taken the note from
   its `before` to its `after`; anything else is the writer's. Where a copy has expired it cannot be told, and the
   answer is yes, so that the writer is asked. */
function userChangedSince(checkpoints, k, current) {
  const cp = checkpoints[k];
  if (!cp || cp.before == null) return true;
  let expected = cp.before;
  for (let j = k; j < checkpoints.length; j++) {
    const c = checkpoints[j];
    if (c.path !== cp.path) continue;
    if (c.before == null) return true;
    if (c.before !== expected) return true;
    if (c.userTyped) return true;        // the writer typed while the pen wrote: the turn's changes are not all Lagrange's
    expected = c.after == null ? c.before : c.after;
  }
  return current !== expected;
}

/* Forgets the copies of the note held by the oldest checkpoints, so that at most `keep` checkpoints hold one and
   they hold at most `maxChars` characters; the newest always keeps its own. Returns the checkpoints that expired. */
function pruneCheckpoints(checkpoints, keep, maxChars) {
  const expired = [];
  let held = 0, chars = 0;
  for (let j = checkpoints.length - 1; j >= 0; j--) {
    const c = checkpoints[j];
    if (c.before == null) continue;
    const size = c.before.length + (c.after == null ? 0 : c.after.length);
    if (held > 0 && (held >= keep || chars + size > maxChars)) {
      c.before = null;
      c.after = null;
      c.expired = true;
      expired.push(c);
      continue;
    }
    held++;
    chars += size;
  }
  return expired;
}

/* The one change that turns text a into text b: {from, to, insert} (what is common at both ends stays as it is, so
   the cursor and the scroll position are kept where they can be); null if they are the same. */
function spliceChange(a, b) {
  if (a === b) return null;
  const max = Math.min(a.length, b.length);
  let start = 0;
  while (start < max && a.charCodeAt(start) === b.charCodeAt(start)) start++;
  let end = 0;
  while (end < max - start && a.charCodeAt(a.length - 1 - end) === b.charCodeAt(b.length - 1 - end)) end++;
  // never cut a surrogate pair in two
  if (start > 0 && /[\uD800-\uDBFF]/.test(a[start - 1])) start--;
  if (end > 0 && /[\uDC00-\uDFFF]/.test(a[a.length - end])) end--;
  return { from: start, to: a.length - end, insert: b.slice(start, b.length - end) };
}

/* Which of Lagrange's runs of edits the Undo and Redo buttons act on. records are oldest first: {undone, redo,
   undoneAt}. Undo takes back the latest run still in the note; Redo makes again the run most lately taken back,
   if it still can be (redo is null once the note has moved on). */
function undoTarget(records) {
  for (let i = records.length - 1; i >= 0; i--) if (!records[i].undone) return records[i];
  return null;
}

function redoTarget(records) {
  let best = null;
  for (const r of records) if (r.undone && r.redo && (!best || r.undoneAt > best.undoneAt)) best = r;
  return best;
}

/* ---- What the pen writes ----
   The pen writes a short form of each replacement above the line. Mathematics in it ($…$ or $$…$$, as Obsidian reads
   them) is kept whole, so it can be typeset and drawn symbol by symbol. Code in it (a fenced block, or a code span of
   a few characters or more) is kept apart too: it is not written by the pen but typed, on a typewriter. */

/* Splits text into [{type: 'text', text} | {type: 'math', source, display}]. Inline math opens with a $ that is not
   escaped and not followed by white space, and closes with one not preceded by white space and not followed by a
   digit, on the same line (so "$5 and $10" is text); $$…$$ is display math and may span lines. Models also write
   mathematics in LaTeX's own delimiters, which Obsidian does not typeset but the pen can: \(…\) on one line and
   \[…\] (when what is inside reads as mathematics, see looksLikeMath: in Markdown they are also escaped brackets),
   and a bare \begin{align}…\end{align} (or another display environment). Those segments also carry {open, close},
   the delimiters as written, so the source can be put back exactly (mathSource). Code spans and fenced
   code are text, unless opts.code is set: then a fenced block, and a code span of at least CODE_SPAN_MIN characters,
   come out as {type: 'code', text, block, lang} (text is the code itself, without its fence or backticks). */
const CODE_SPAN_MIN = 4;
const MATH_ENV_RE = /^\\begin\{((?:equation|align|alignat|flalign|gather|multline|eqnarray|split|aligned|gathered|cases|array|[pbBvV]?matrix)\*?)\}/;

/* Whether the inside of \(…\) or \[…\] reads as mathematics and not as prose in escaped brackets ("\[sic\]"): a
   command, a script, an equals sign, a sum or comparison, or a single letter. */
function looksLikeMath(body) {
  const b = String(body).trim();
  return /\\[A-Za-z]+|[\^_=]|[0-9A-Za-z)}]\s*[+<>]\s*[0-9A-Za-z({\\]/.test(b) || /^[A-Za-z]$/.test(b);
}

/* A math segment as it was written, delimiters and all. */
function mathSource(g) {
  if (typeof g.open === 'string') return g.open + g.source + g.close;
  return g.display ? `$$${g.source}$$` : `$${g.source}$`;
}
function mathSegments(text, opts) {
  const wantCode = Boolean(opts && opts.code);
  const src = String(text == null ? '' : text);
  const out = [];
  let buf = '';
  const flush = () => { if (buf) { out.push({ type: 'text', text: buf }); buf = ''; } };
  for (let i = 0; i < src.length;) {
    const c = src[i];
    if (c === '\\' && (src[i + 1] === '(' || src[i + 1] === '[')) {
      const display = src[i + 1] === '[', close = display ? '\\]' : '\\)';
      const end = src.indexOf(close, i + 2);
      const body = end < 0 ? '' : src.slice(i + 2, end);
      if (body.trim() && (display || !body.includes('\n')) && looksLikeMath(body)) {
        flush();
        out.push({ type: 'math', source: body.trim(), display, open: src.slice(i, i + 2) + body.slice(0, body.length - body.trimStart().length), close: body.slice(body.trimEnd().length) + close });
        i = end + 2;
        continue;
      }
    }
    if (c === '\\' && src.startsWith('\\begin{', i)) {
      const m = MATH_ENV_RE.exec(src.slice(i, i + 24));
      const close = m ? `\\end{${m[1]}}` : '';
      const end = m ? src.indexOf(close, i) : -1;
      if (end > 0) {
        flush();
        out.push({ type: 'math', source: src.slice(i, end + close.length), display: true, open: '', close: '' });
        i = end + close.length;
        continue;
      }
    }
    if (c === '\\' && i + 1 < src.length) { buf += src.slice(i, i + 2); i += 2; continue; }
    if (c === '`') {
      const ticks = src.slice(i).match(/^`+/)[0];
      const end = src.indexOf(ticks, i + ticks.length);
      const stop = end < 0 ? (ticks.length >= 3 ? src.length : i + ticks.length) : end + ticks.length;
      if (wantCode && (end >= 0 || ticks.length >= 3)) {
        const inner = src.slice(i + ticks.length, end < 0 ? src.length : end);
        const fenced = ticks.length >= 3 && (i === 0 || src[i - 1] === '\n') && inner.includes('\n');
        if (fenced) {
          const nl = inner.indexOf('\n');
          flush();
          out.push({ type: 'code', text: inner.slice(nl + 1).replace(/\n[ \t]*$/, ''), block: true, lang: inner.slice(0, nl).trim() });
          i = stop;
          continue;
        }
        if (inner.trim().length >= CODE_SPAN_MIN) {
          flush();
          out.push({ type: 'code', text: inner.replace(/\s+/g, ' ').trim(), block: false, lang: '' });
          i = stop;
          continue;
        }
      }
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
          if (src[j] === '`') break;                 // a code span is not mathematics
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

/* Whether the typewriter has something to type: a fenced block, or a code span of a few characters or more. */
function hasCode(text) {
  return mathSegments(text, { code: true }).some(g => g.type === 'code');
}

/* The pauses of a typewriter typing `text`, in milliseconds, one per character: uneven, as a typist's are (a little
   quicker inside a word, a breath after a space or punctuation), a carriage return at each line end, and never more
   than `budget` ms in all. `seed` makes the unevenness repeatable. */
function typeCadence(text, budget, seed) {
  let x = (seed >>> 0) || 0x9e3779b9;
  const rand = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
  const out = [];
  for (const c of String(text)) {
    if (c === '\n') out.push(190);
    else if (c === ' ') out.push(38 + rand() * 40);
    else if (/[.,;:(){}\[\]=]/.test(c)) out.push(62 + rand() * 60);
    else out.push(30 + rand() * 46);
  }
  const total = out.reduce((a, b) => a + b, 0);
  const scale = budget > 0 && total > budget ? budget / total : 1;
  return out.map(ms => ms * scale);
}

/* The pen's script for a replacement: its segments, white space collapsed in the prose, cut to about `limit`
   characters of prose. An equation is never cut in two and never left out for want of room, however long it is or
   however far into a long paragraph it comes (it counts for at most 24 characters, and the pen writes smaller if it
   must): where the prose has run out, the few words that lead up to an equation are still written, after an
   ellipsis. Only after SCRIPT_EQUATIONS equations does the script end, with an ellipsis. Code is never left out
   either, and keeps its line breaks and its spacing:
   a block is cut to CODE_LINES lines of CODE_COLS characters, a span to CODE_COLS characters, each with an ellipsis. */
const CODE_LINES = 6, CODE_COLS = 56;
const SCRIPT_EQUATIONS = 8, SCRIPT_LEAD = 18;
/* The first `max` characters of text, cut back to the end of a whole word (a word is never cut in two, unless it is
   the only one and longer than max). Pure. */
function wordCut(text, max) {
  const t = String(text == null ? '' : text);
  if (t.length <= max) return t.trimEnd();
  let head = t.slice(0, Math.max(0, max));
  if (/\S/.test(t[head.length] || '') && /\S$/.test(head)) {
    const whole = head.replace(/\S+$/, '');
    if (whole.trim()) head = whole;
  }
  return head.trimEnd();
}
/* A line that only marks where Scriptorium centres text or sets it to the right ("::: center", "::: right", ":::";
   see ALIGN_STYLE). The note does not show it as text, so the pen never writes it. */
const ALIGN_MARK = /^[ \t]*:{3,}[ \t]*(?:\{?[ \t]*\.?(?:cent(?:er|re|ered|red)|right)(?![\w-])[^\n]*)?$/;
/* Prose as the page shows it: without the Markdown marks that the rendered text hides. Emphasis (*…*, _…_, **…**,
   __…__), ~~struck~~ and ==marked== text and code spans keep their words; a link keeps its text, a wikilink its
   alias or its target; a comment (%%…%%) and HTML tags go; a heading's # and a quotation's > at the start of a line
   go; an escaped character (\*) stays as the character. What is not closed stays as it is written. Pure. */
function plainInline(text) {
  // (an escaped character is put out of the way as a private-use character, and put back at the end)
  let t = String(text == null ? '' : text)
    .replace(/\\([\\`*_{}[\]()#+\-.!~=|>$%])/g, (m, c) => String.fromCharCode(0xE100 + c.charCodeAt(0)))
    .replace(/(^|\n)[ \t]*(?:#{1,6}[ \t]+|>[ \t]?)+/g, '$1')
    .replace(/%%[\s\S]*?%%/g, '')
    .replace(/!?\[\[([^\]|\n]*)\|([^\]\n]*)\]\]/g, '$2')
    .replace(/!?\[\[([^\]\n]*)\]\]/g, '$1')
    .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/<\/?[A-Za-z][^<>\n]*>/g, '');
  for (let i = 0; i < 3; i++) {
    t = t.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
      .replace(/\*(?=[^\s*])([^*\n]*?[^\s*])\*/g, '$1')
      .replace(/(^|[^A-Za-z0-9_])_(?=[^\s_])([^_\n]*?[^\s_])_(?![A-Za-z0-9_])/g, '$1$2')
      .replace(/~~(?=\S)([^\n]*?\S)~~/g, '$1')
      .replace(/==(?=\S)([^\n]*?\S)==/g, '$1');
  }
  return t.replace(/[\uE100-\uE1FF]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xE100));
}

/* (plain: the text is written as Live Preview shows it, without its Markdown marks; see plainInline) */
function penScript(replacement, limit, plain) {
  const max = limit || 48;
  const segs = mathSegments(String(replacement == null ? '' : replacement).split('\n').filter(l => !ALIGN_MARK.test(l)).join('\n').trim(), { code: true })
    .map(g => (g.type === 'text' ? { type: 'text', text: (plain ? plainInline(g.text) : g.text).replace(/\s+/g, ' ') } : g))
    .filter(g => g.type !== 'text' || g.text);
  if (segs.length && segs[0].type === 'text') segs[0].text = segs[0].text.trimStart();
  if (segs.length && segs[segs.length - 1].type === 'text') segs[segs.length - 1].text = segs[segs.length - 1].text.trimEnd();
  const out = [];
  let used = 0, full = false, equations = 0, over = false;   // full: no more prose; over: no more equations either
  const dotted = () => { const last = out[out.length - 1]; return Boolean(last && last.type === 'text' && /…\s*$/.test(last.text)); };
  const stop = () => { if (!full) { full = true; out.push({ type: 'text', text: ' …' }); } };
  // The last few words of prose, from the start of a word.
  const lead = text => {
    if (text.length <= SCRIPT_LEAD) return text;
    const tail = text.slice(text.length - SCRIPT_LEAD);
    return tail.slice(tail.indexOf(' ') + 1);
  };
  segs.forEach((g, i) => {
    const room = max - used;
    if (g.type === 'math') {
      if (over || equations >= SCRIPT_EQUATIONS) { over = true; if (!dotted()) out.push({ type: 'text', text: ' …' }); full = true; return; }
      equations++;
      out.push(g);
      used += Math.min(g.source.length, 24);
    } else if (g.type === 'code') {                     // never left out for want of room
      const clip = l => (l.length > CODE_COLS ? l.slice(0, CODE_COLS - 1) + '…' : l);
      let lines = g.block ? g.text.replace(/\t/g, '  ').split('\n') : [g.text];
      if (lines.length > CODE_LINES) lines = lines.slice(0, CODE_LINES - 1).concat('…');
      out.push({ type: 'code', text: lines.map(clip).join('\n'), block: g.block, lang: g.lang });
      used += Math.min(g.text.length, 24);
    } else if (!full) {
      if (g.text.length > room) {
        const head = wordCut(g.text, Math.max(0, room - 2));
        const next = segs[i + 1], toMath = Boolean(next && next.type === 'math' && equations < SCRIPT_EQUATIONS);
        full = true;
        // prose that runs up to an equation: its last words are written too, or all of it when little would be left out
        if (toMath && g.text.length - head.length <= SCRIPT_LEAD) out.push(g);
        else {
          out.push({ type: 'text', text: head + ' …' });
          if (toMath) out.push({ type: 'text', text: ' ' + lead(g.text) });
        }
      } else {
        out.push(g);
        used += g.text.length;
        if (used >= max && i < segs.length - 1 && !segs.slice(i + 1).some(n => n.type === 'math')) stop();
        else if (used >= max) full = true;
      }
    } else if (!over) {
      // out of room: only the words that lead up to the next equation are written, or an ellipsis after the last one
      const next = segs[i + 1];
      if (next && next.type === 'math' && equations < SCRIPT_EQUATIONS) out.push({ type: 'text', text: (g.text.length <= SCRIPT_LEAD ? '' : dotted() ? ' ' : ' … ') + lead(g.text) });
      else if (!dotted()) out.push({ type: 'text', text: ' …' });
    }
  });
  return out;
}

/* About how many lines of the page the pen needs under the place where an edit starts: the lines of handwriting it
   may write (`wanted`: the setting, see penLines; the rest of a long text is set down unwritten), the empty lines
   the text opens with, and with them the lines of a code block it types (CODE_LINES at most, and its fence) and the
   height of a displayed equation. The pen brings an edit to the middle of the editor first when it starts low on
   the screen and would run off it otherwise (see edit). A guess, as textLines is. Pure. */
function penRoom(text, wanted, width, fontSize) {
  const t = String(text == null ? '' : text);
  let room = Math.max(1, Math.min(8, Math.round(Number(wanted) || 3))) + (/^\s*/.exec(t)[0].match(/\n/g) || []).length;
  if (/^[ \t]*(?:```|~~~)/m.test(t)) room += CODE_LINES + 2;
  if (/\$\$|\\\[|\\begin\{/.test(t)) room += 3;
  return Math.min(textLines(t, 0, width, fontSize), room);
}

/* How far into a piece of Markdown its first written character is: past white space and past what opens a block
   (a heading's #, a list's bullet or number, a quotation's >, the marker line of centred or right-aligned text),
   which Live Preview does not show as text. The pen starts writing there. Equal to the text's length when it has
   nothing to write. */
function inkOffset(text) {
  const t = String(text == null ? '' : text);
  let at = 0;
  for (;;) {                                           // marker lines first ("::: center" and the line break after it)
    const m = /^\s*:{3,}[^\n]*(?:\n|$)/.exec(t.slice(at));
    if (!m || !ALIGN_MARK.test(m[0].trim())) break;
    at += m[0].length;
  }
  const m = /^\s*(?:(?:#{1,6}|[-*+]|\d{1,9}[.)])[ \t]+|>[ \t]?)*/.exec(t.slice(at));
  return at + (m ? m[0].length : 0);
}

/* How many lines of handwriting an edit gets, and how fast they are written.
   penLines(wanted, textLines, spent, speed): the pen writes at most `wanted` lines of the text column (the setting,
   3 by default) and never more lines than the text itself takes (`textLines`); what does not fit ends in an ellipsis
   and is set down with the rest. In a run of many edits, once the handwriting of the run has taken PEN_RUN_MS (at
   pen speed 1; `spent` is in real ms), later edits get one line each, so a long run does not take minutes.
   penPace(width): ms per px of handwriting at speed 1: the released 9 ms for short pieces, faster for long ones so
   that PEN_LINE_PX-long lines take about PEN_LINES_MS / 3 each (three lines in 2.5 to 4 s). Pure. */
const PEN_RUN_MS = 10000, PEN_LINES_MS = 3300;
function penLines(wanted, textLines, spent, speed) {
  const want = Math.max(1, Math.min(8, Math.round(Number(wanted) || 3)));
  const sp = Number(speed) > 0 ? Number(speed) : 1;
  const allowed = Number(spent) * sp >= PEN_RUN_MS ? 1 : want;
  return Math.max(1, Math.min(allowed, Math.max(1, Math.round(Number(textLines) || 1))));
}
function penPace(width) {
  const w = Math.max(1, Number(width) || 0);
  return Math.min(9, Math.max(1.2, PEN_LINES_MS / w));
}

/* ---- Several pens at once ----
   A run's edits are written one after another by one pen, unless some of them stand well apart on the page: those
   are written at the same time, each by a pen of its own (see runEdits and penWave). penLanes is the rule.

   penLanes(edits, page, opts) -> {lanes, count}
     edits: the run's next edits, in the order of the note: {top, bottom, para, paraEnd, grow} each, or null for one
       that cannot be measured. top and bottom: where the words it replaces stand on the page now, in px (for an
       insertion, the line it goes into); para and paraEnd: the first and the last line of the note that it touches
       (a paragraph is one line of the note); grow: by how many px it will push down what stands below it.
     page: {top, bottom, lineHeight, width}: the part of the editor in view that may be written in (in px, measured
       as top and bottom above are), the height of a line of text, and the width of the text column.
     opts: {pens}: how many pens may write at once (the setting "Pens at most").
     lanes: for each pen, the edits it writes one after another (indices into `edits`, each lane in order, the lanes
       from the top of the page down); count: how many edits, from the first on, the lanes hold. No lanes, and a
       count of 0, when one pen is to write as it always has.
   The rule:
   - only edits that are in view take part, and that are still in view once the edits above them have pushed them
     down: the first one that is not ends the list (it and all after it wait for the next round);
   - two edits go to the same pen, the second waiting for the first, when they are in the same paragraph or when
     fewer than PEN_GAP_LINES lines of the page lie clear between them, or less than PEN_GAP_PX (in small type a pen,
     which is always as large, would lie across the line above its own), so that neither handwriting nor pens meet;
   - there are never more pens than opts.pens, than PEN_MAX, or than one for every PEN_LANE_PX of the page's height;
     the edits past the last pen's wait for the next round;
   - a text column narrower than PEN_MIN_WIDTH is written by one pen (several would crowd it);
   - a single lane is no lanes.
   Pure. */
const PEN_GAP_LINES = 2.5, PEN_GAP_PX = 76, PEN_LANE_PX = 180, PEN_MIN_WIDTH = 440;
const PEN_STAGGER_MS = 220;           // each further pen sets out this much after the one before it (at pen speed 1)
function penLanes(edits, page, opts) {
  const none = { lanes: [], count: 0 };
  const list = Array.isArray(edits) ? edits : [];
  if (!page || !(page.bottom > page.top) || list.length < 2) return none;
  const lineHeight = Number(page.lineHeight) > 0 ? Number(page.lineHeight) : 24;
  const max = Math.min(PEN_MAX, Math.floor(Number(opts && opts.pens) || 0), Math.floor((page.bottom - page.top) / PEN_LANE_PX));
  if (max < 2 || !(Number(page.width) >= PEN_MIN_WIDTH)) return none;
  const gap = Math.max(PEN_GAP_LINES * lineHeight, PEN_GAP_PX);
  const lanes = [];
  let pushed = 0, last = null, count = 0;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (!e || !(e.bottom >= e.top)) break;
    const grow = Math.max(0, Number(e.grow) || 0);
    if (e.top < page.top || e.bottom + pushed + grow > page.bottom) break;
    const joins = Boolean(last) && (e.para <= last.paraEnd || e.top - last.bottom < gap);
    if (!joins && lanes.length === max) break;
    if (joins) {
      lanes[lanes.length - 1].push(i);
      last = { paraEnd: Math.max(last.paraEnd, e.paraEnd), bottom: Math.max(last.bottom, e.bottom) };
    } else {
      lanes.push([i]);
      last = { paraEnd: e.paraEnd, bottom: e.bottom };
    }
    pushed += grow;
    count++;
  }
  return lanes.length < 2 ? none : { lanes, count };
}

/* About how many lines of the page a piece of text takes, set from `indent` px into a column `width` px wide in type
   of size `fontSize`. A guess from the count of its characters (0.45 em each, about what running text takes), for
   planning only (penTargets, penRoom): the pen itself measures the text where it stands. Pure. */
function textLines(text, indent, width, fontSize) {
  const em = Number(fontSize) > 0 ? Number(fontSize) : 16, each = em * 0.45;
  const w = Math.max(each * 8, Number(width) || 0);
  let lines = 0;
  String(text == null ? '' : text).split('\n').forEach((line, i) => {
    lines += Math.max(1, Math.ceil(((i ? 0 : Math.max(0, Number(indent) || 0)) + line.length * each) / w));
  });
  return lines;
}

/* Where the lines of a piece of laid-out text begin. tops[i] is the vertical middle of character i on the page, or
   null for a character that takes no room (white space at a line's end): a character more than `tol` below the line
   so far starts a new line. -> the index of the first character of each line, starting with 0. Pure. */
function lineStarts(tops, tol) {
  const starts = [0];
  let cur = null;
  for (let i = 0; i < tops.length; i++) {
    const t = tops[i];
    if (t == null) continue;
    if (cur !== null && Math.abs(t - cur) > tol) starts.push(i);
    cur = t;
  }
  return starts;
}

/* Whether a key press in the note would change it (or is about to, through an input method): a character, Enter,
   Backspace, Delete, Tab, and paste, cut, undo and redo. Moving the cursor, selecting, copying and the modifier keys
   alone change nothing. ev: {key, ctrlKey, metaKey, altKey, isComposing}. Pure. */
function isEditKey(ev) {
  if (!ev) return false;
  const key = String(ev.key || '');
  if (ev.isComposing || key === 'Process' || key === 'Dead') return true;
  if (ev.ctrlKey || ev.metaKey) return !ev.altKey && ['v', 'x', 'z', 'y'].includes(key.toLowerCase());
  if (['Enter', 'Backspace', 'Delete', 'Tab'].includes(key)) return true;
  return Array.from(key).length === 1;
}

/* Where a position of a text stands after changes to it: changes is a list of {from, to, insert} (insert a string, or
   its length), each in the coordinates of the text as it was before all of them, in order and not overlapping. A
   position inside replaced text goes to the start of what replaced it (assoc < 0, the default) or to its end; one
   exactly where text was put in stays before it (assoc < 0) or goes after it. As CodeMirror's ChangeSet.mapPos, which the plugin uses in the
   editor; this is for the tests and for texts that are not in an editor. Pure. */
function mapOffset(changes, pos, assoc) {
  let shift = 0;
  const before = assoc == null || assoc < 0;
  for (const c of changes || []) {
    const len = typeof c.insert === 'number' ? c.insert : String(c.insert == null ? '' : c.insert).length;
    const to = c.to == null ? c.from : c.to;
    if (pos < c.from) break;
    if (pos > to || (pos === to && (to > c.from || !before))) { shift += len - (to - c.from); continue; }
    if (pos === c.from && to === c.from) break;          // an insertion exactly here, and the position stays before it
    return c.from + shift + (pos === c.from || before ? 0 : len);
  }
  return pos + shift;
}

/* An edit that was located before the note changed, in the note as it is now. edit: {from, to, matched}; mapPos(pos,
   assoc) carries a position through the changes since (ChangeSet.mapPos, or mapOffset); slice(from, to) reads the
   note now. -> {from, to}, or {skip: why} when the words the edit was to replace are no longer what they were.
   An insertion (from === to) is never spoiled: it goes where its place went. Pure. */
function remapEdit(edit, mapPos, slice) {
  if (edit.from === edit.to) { const p = mapPos(edit.from, 1); return { from: p, to: p }; }
  const from = mapPos(edit.from, 1), to = mapPos(edit.to, -1);
  if (to < from || slice(from, to) !== edit.matched) return { skip: 'the text changed' };
  return { from, to };
}

/* Whether the chat's log should keep to its bottom after a scroll. It keeps to the bottom while the writer is there
   (within `slack` px), lets go when they scroll up, and takes hold again when they come back down; the log's own
   scrolling (always downwards) and its growing never let go. stick: as it was; prevTop, top: the scroll offset before
   and now. Pure. */
function stickAfterScroll(stick, prevTop, top, scrollHeight, clientHeight, slack) {
  if (scrollHeight - top - clientHeight < (slack == null ? 48 : slack)) return true;
  if (top < prevTop - 1) return false;
  return Boolean(stick);
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

/* How the pen sets an equation down, and why: {how: 'draw' | 'text', why}. 'draw' is the typeset equation, drawn
   symbol by symbol; 'text' is the fallback, the source written like other words, and `why` then says what was
   missing (it goes to the console).
   env: {renderer (obsidian.renderMath exists), loaded (MathJax is there after loadMathJax),
   error (what loading threw, if anything), typeset (renderMath gave an element), failed (MathJax marked a TeX
   error in it), symbols (how many it has)}. Pure. */
function equationPlan(env) {
  const e = env || {};
  const text = why => ({ how: 'text', why });
  if (!e.renderer) return text('this Obsidian has no renderMath');
  if (e.error) return text(`MathJax did not load (${e.error})`);
  if (!e.loaded) return text('MathJax did not load in time');
  if (!e.typeset) return text('MathJax could not typeset it');
  if (e.failed) return text('MathJax reported a TeX error');
  if (!(e.symbols > 0)) return text('the typeset equation has no symbols to draw');
  return { how: 'draw', why: '' };
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
   or "correct" proofreads; "equation" or "formula" adds one; "code" or "function" adds a code block; "add" or
   "append" adds a line. */
function demoChatEdits(question, note) {
  const q = String(question || '').toLowerCase();
  let ops = null;
  if (/\b(equation|formula|math)/.test(q)) {
    ops = [{ append: 'The Euler–Lagrange equation: $$\\frac{d}{dt}\\frac{\\partial L}{\\partial \\dot{q}} - \\frac{\\partial L}{\\partial q} = 0$$' }];
  } else if (/\b(code|function|script|snippet|program)/.test(q)) {
    ops = [{ append: 'The distance to the first Lagrange point, with `hill_radius(m1, m2, r)`:\n\n```python\ndef hill_radius(m1, m2, r):\n    # where a small body between two masses can rest\n    return r * (m2 / (3 * m1)) ** (1 / 3)\n```' }];
  } else if (/\b(fix|proofread|correct|tidy|clean)/.test(q)) {
    ops = demoProofreadEdits(note.text);
  } else if (/\b(add|append|write)\b/.test(q)) {
    ops = [{ append: 'A line added by Lagrange in demo mode.' }];
  }
  return ops && ops.length ? '```lagrange-edits\n' + JSON.stringify(ops, null, 2) + '\n```' : '';
}

/* The demo looks at the page when the message is about how it looks. */
const DEMO_LOOK_RE = /\b(?:looks?|rendered|renders?|the page|drop ?caps?|cent(?:re|er)(?:ed|d)?|align(?:ed|ment)?|margins?|layout|typeset)\b/i;

function demoChatReply(question, note, agentic, look) {
  const parts = ['*Demo mode: a canned reply, written without a model. Choose a Claude or ChatGPT subscription, an ' +
    'API key or an OpenAI-compatible server in Settings → Lagrange for real answers.*'];
  if (look && note && DEMO_LOOK_RE.test(String(question || ''))) {
    return parts.concat(`Let me look at the page of **${note.title}** as it is rendered.`, '```lagrange-look\n{"target": "note"}\n```').join('\n\n');
  }
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
    (agentic ? '- Ask here to *fix the typography*, to *add a line*, to *add an equation* or to *add some code*, and the pen does it.\n' : '') +
    '- **Proofread note** finds typographic slips (straight quotes, spaced hyphens, doubled spaces) and sets the ' +
    'corrections down with the pen.\n' +
    '- **Revise selection** rewrites the selected passage: ask for it *shorter*, *in title case* or *in capitals*.\n\n' +
    'One undo (Ctrl+Z or Cmd+Z) takes back all the edits of a request.');
  return parts.join('\n\n');
}

/* The demo's reply after a look: what was measured on the page, in a few sentences (no model has seen anything). */
function demoLookReply(look) {
  if (!look) return '*Demo mode.* The page could not be looked at.';
  const blocks = look.blocks || [];
  const pl = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const count = kind => blocks.filter(b => b.kind === kind).length;
  const ALIGN = { left: 'flush left', right: 'flush right', center: 'centred', justify: 'justified' };
  const parts = [`*Demo mode: this is what was measured on the page, not a model’s reading of it.* I looked at the page of **${look.title}** (${look.label}): ` +
    `${pl(blocks.length, 'block')}, among them ${pl(count('heading'), 'heading')} and ${pl(count('paragraph'), 'paragraph')}` +
    (look.page && look.page.column && look.page.column.width ? `, in a column ${Math.round(look.page.column.width)} px wide.` : '.')];
  const head = blocks.find(b => b.kind === 'heading' || b.kind === 'title');
  if (head) parts.push(`The ${head.kind === 'title' ? 'title' : 'first heading'}, “${excerpt(head.text, 60)}”, is ${ALIGN[head.align] || head.align || 'set'}.`);
  const caps = blocks.filter(b => b.dropcap);
  parts.push(caps.length
    ? `${caps.length === 1 ? 'One paragraph opens' : `${caps.length} paragraphs open`} with a drop cap: ${caps.slice(0, 6).map(b => `“${b.dropcap.letter}”`).join(', ')}.`
    : 'No paragraph opens with a drop cap.');
  const wide = blocks.filter(b => b.overflow > 1);
  if (wide.length) parts.push(`${pl(wide.length, 'block')} ${wide.length === 1 ? 'is' : 'are'} too wide for the column (${wide.map(b => b.kind).slice(0, 4).join(', ')}).`);
  if (look.page && look.page.margin) parts.push('The footnotes are set in the margin.');
  return parts.join('\n\n');
}


/* ---------------------------------------------------------------------------------------------------------------
 * 3. Providers
 *
 * complete(settings, req, hooks, session) -> Promise<{text, stopReason, stopDetails, model, fallbackTo}>
 *   req:     {purpose: 'chat'|'proofread'|'revise', system, messages: [{role, content}], cache, demo: () => string}
 *   hooks:   {signal, onText(delta, fullText), onRetry(status, ms), fetch, retryDelays}
 *   session: {noFallback, noEffort: {}, noPictures: {}}, what this run of Obsidian has learnt a provider won't take
 * The reasoning effort (settings.effort) goes out only where the provider and model take one (effortFor); if a
 * provider still rejects it, the request is sent again without it and the session remembers.
 * A message's content is text, or, when it carries a look at the page, a list of parts: pictures ({type: 'image',
 * mediaType, data: base64}) and text, with the same in words alone as the message's alt (lookMessage). Each provider
 * is handed the pictures in its own way: image blocks (Anthropic), image_url parts (OpenAI and compatible servers),
 * image blocks on stdin (Claude Code), files in a temporary folder that is deleted afterwards (Codex). If a provider
 * turns them down, the request goes again with the words alone, the reply says so (picturesRefused) and the session
 * remembers.
 * Throws LagrangeError with a sentence for the writer, or an AbortError when stopped.
 * ------------------------------------------------------------------------------------------------------------- */

/* ---- Drawing a drop cap ----
   "Lagrange: Draw a drop cap" has the provider draw an ornamental initial, which the Scriptorium plugin keeps as a
   set of drop caps in the vault and inks into the note. How it is drawn depends on the provider (dropcapRoute):
     - 'image-api': OpenAI's Images API (the OpenAI API provider), a PNG.
     - 'codex-image': Codex's own image tool (the ChatGPT subscription provider), a PNG.
     - 'svg': every other provider has no image model to call, so the language model writes the initial as an SVG
       drawing; the Demo has one of its own.
   An existing initial can be changed: an image goes back to the image model with the instruction (the Images API's
   edits, or attached to Codex); an SVG goes back to the language model as text. */

function dropcapRoute(s) {
  if (s.provider === 'openai-api') return 'image-api';
  if (s.provider === 'codex') return 'codex-image';
  return 'svg';
}

/* How the chosen provider would draw, in a sentence for the dialogue. */
function dropcapRouteNote(s) {
  const route = dropcapRoute(s);
  if (route === 'image-api') {
    return `OpenAI’s image model (${String(s.openaiImageModel || '').trim() || DEFAULT_SETTINGS.openaiImageModel}) will paint it, through your API key; OpenAI charges for each image. Experimental: this route has not been tried against the live API.`;
  }
  if (route === 'codex-image') return 'ChatGPT will paint it with Codex’s image tool, on your subscription. It takes a minute or so.';
  if (s.provider === 'demo') return 'The Demo has one drawing of its own, the same for every description. Choose a provider in Settings → Lagrange for a real one.';
  return `${modelLabel(s)} has no image model that Lagrange can call, so it will write the initial as a line drawing (SVG). For a painted one, choose “ChatGPT: my subscription” or “OpenAI API” in Settings → Lagrange. (Image connectors such as Canva’s are not used: through Claude Code, Canva’s hands back only a thumbnail.)`;
}

function dropcapLetter(text) {
  const m = String(text || '').match(/\p{L}/u);
  const c = m ? m[0].normalize('NFD')[0].toUpperCase() : '';
  return /^[A-Z]$/.test(c) ? c : '';
}

/* The request to an image model. req: {letter, style, mono, change}; change is the instruction when an existing
   image is being changed. */
function dropcapImagePrompt(req) {
  const style = String(req.style || '').trim() || 'a woodcut initial with vine leaves';
  const ink = req.mono
    ? 'Pure black ink only, on a plain white ground: no grey wash, no colour, no paper texture.'
    : 'On a plain, even ground with nothing else on it.';
  const rules = `One letter only, large, upright and plainly legible as a capital ${req.letter}; square; the design fills the square to its edges; no other letters, words, signature or border of text.`;
  if (req.change) {
    return `This image is an ornamental drop cap: the capital letter ${req.letter}, the initial that opens a chapter in a printed book. ` +
      `Change it as follows, keeping the letter and the manner of the drawing otherwise: ${String(req.change).trim()}. ${ink} ${rules}`;
  }
  return `An ornamental drop cap: the capital letter ${req.letter}, the initial that opens a chapter in a finely printed book. Style: ${style}. ${ink} ${rules}`;
}

const DROPCAP_SVG_SYSTEM =
  'You draw ornamental initials (drop caps) for a book page as SVG. Answer with one complete SVG document and nothing ' +
  'else: no prose, no code fence. Rules: <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">; the letter ' +
  'drawn with paths (no <text>, no fonts), large, bold and plainly legible; ornament around and behind it; a clear ' +
  'ground (no background rectangle); no scripts, links, images, external references or animation; under 16 kB.';

function dropcapSvgMessage(req) {
  const style = String(req.style || '').trim() || 'a woodcut initial with vine leaves and a ruled square frame';
  const ink = req.mono ? 'Use pure black only (fill="#000" or stroke="#000"): it will be printed in the page’s own ink colour.' : 'Use a few flat colours that suit a book page.';
  if (req.change && req.base) {
    return `Here is a drop cap, the capital letter ${req.letter}, as SVG:\n\n${req.base}\n\nChange it as follows, keeping the letter and the manner of the drawing otherwise: ${String(req.change).trim()}. ${ink} Answer with the whole changed SVG.`;
  }
  return `Draw the capital letter ${req.letter} as a drop cap. Style: ${style}. ${ink}`;
}

/* The SVG document in a reply ('' if it has none). */
function extractSvg(text) {
  const t = String(text || '');
  const a = t.search(/<svg[\s>]/i), b = t.toLowerCase().lastIndexOf('</svg>');
  return a >= 0 && b > a ? t.slice(a, b + 6) : '';
}

/* The Demo's drop cap: a ruled frame with corner leaves, and the letter in the reader's serif. */
function demoDropcapSvg(letter) {
  const leaf = (x, y, r) => `<path transform="translate(${x} ${y}) rotate(${r})" d="M0 0C14-22 44-26 62-8C44 6 16 10 0 0ZM6-2C24-10 40-10 54-7" fill="none" stroke="#000" stroke-width="3.5" stroke-linecap="round"/>`;
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">' +
    '<rect x="14" y="14" width="372" height="372" fill="none" stroke="#000" stroke-width="8"/>' +
    '<rect x="30" y="30" width="340" height="340" fill="none" stroke="#000" stroke-width="2.5"/>' +
    leaf(52, 78, -20) + leaf(348, 78, 200) + leaf(52, 322, 20) + leaf(348, 322, 160) +
    '<path d="M70 200C110 150 150 250 200 200S290 150 330 200" fill="none" stroke="#000" stroke-width="3" stroke-dasharray="2 9" stroke-linecap="round"/>' +
    `<text x="200" y="296" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="300" font-weight="700" fill="#000">${dropcapLetter(letter) || 'A'}</text>` +
    '</svg>';
}

function bytesFromBase64(b64) {
  const bin = atob(String(b64 || '').replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function base64FromBytes(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function isPng(bytes) {
  return Boolean(bytes && bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47);
}

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

/* This provider and model (providerKey) would not take pictures: looks describe the page in words from now on. */
function forgetPictures(session, key) {
  if (!session) return;
  if (!session.noPictures) session.noPictures = {};
  session.noPictures[key] = true;
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
    messages: anthropicMessages(req.messages),
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
  let messages = req.messages, picturesRefused = false;
  // Only OpenAI's own reasoning models are sent an effort (effortSupported); a local server never is.
  let effort = sessionEffort(s, session, `openai:${model}`);
  let res;
  for (;;) {
    const body = { model, stream: true, messages: [{ role: 'system', content: req.system }].concat(openaiMessages(messages)) };
    const b = effort ? Object.assign({ reasoning_effort: effort }, body) : body;
    res = await fetchWithRetry('openai', url, { method: 'POST', headers, body: JSON.stringify(b), signal: hooks.signal }, hooks);
    if (res.ok) break;
    const text = await safeText(res);
    if (effort && res.status === 400 && /reasoning|effort/i.test(parseErrorBody(text).message || text)) {
      forgetEffort(session, `openai:${model}`);
      effort = '';
      continue;
    }
    // A model that reads text only turns a request with pictures down (400, 415 or 422, in as many wordings as
    // there are servers): the page goes again in words.
    if (!picturesRefused && [400, 415, 422].includes(res.status) && messagePictures(messages).length) {
      forgetPictures(session, `openai:${model}`);
      messages = withoutPictures(messages);
      picturesRefused = true;
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
  return { text: st.text, stopReason: st.stopReason, stopDetails: null, model, fallbackTo: null, picturesRefused };
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
  const msgs = (messages || []).filter(m => m && (typeof m.content === 'string' || Array.isArray(m.content)))
    .map(m => ({ role: m.role, content: messageText(m) }));   // a picture leaves a line saying that it is attached
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
   code and stderr; rejects on a missing executable. hooks.signal stops it; hooks.cwd is the folder it runs in (the
   temporary folder if none) and hooks.env adds environment variables. Scriptorium's Google Drive backup runs Claude
   Code through this too (runCliTakesEnv says that cwd and env are honoured). */
function runCli(which, exe, args, input, onLine, hooks) {
  const cp = nodeModule('child_process'), os = nodeModule('os'), path = nodeModule('path');
  const win = process.platform === 'win32';
  const env = Object.assign({}, process.env, hooks.env);
  env.PATH = [path.dirname(exe), env.PATH || ''].filter(Boolean).join(path.delimiter);
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = cp.spawn(exe, args, { cwd: hooks.cwd || os.tmpdir(), env, windowsHide: true, shell: win && /\.cmd$/i.test(exe), stdio: ['pipe', 'pipe', 'pipe'] });
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
  // Pictures of the page go in on stdin with the prompt, as one message in Claude Code's stream-json form (image
  // blocks, then the words). No tool is turned on for them, and nothing is written to disk.
  let pictures = messagePictures(req.messages), picturesRefused = false;
  let st;
  try {
    for (;;) {
      st = { text: '', streamed: false, stopReason: null, model: null, error: null, done: false };
      const run = (effort ? args.concat('--effort', quote(effort)) : args).concat(pictures.length ? ['--input-format', 'stream-json'] : []);
      const input = pictures.length ? claudeCodeInput(req.messages, pictures) : transcriptPrompt(picturesRefused ? withoutPictures(req.messages) : req.messages);
      const { code, stderr } = await runCli('claude', exe, run, input, line => {
        const delta = applyClaudeCodeLine(st, line);
        if (delta && hooks.onText) hooks.onText(delta, st.text);
      }, hooks);
      const said = `${st.error || ''} ${stderr}`;
      // A Claude Code from before `--effort` stops at once, naming the option: run it again without.
      if (effort && !st.text && /effort/i.test(said) && /unknown|unrecogni[sz]ed|invalid|unexpected|not supported/i.test(said)) {
        forgetEffort(session, 'claude-code');
        effort = '';
        continue;
      }
      // One that will not take the pictures (it does not know the input format, or says so): the page goes in words.
      if (pictures.length && !st.text && /input-format|stream-json|image|unknown option|unrecogni[sz]ed|unexpected/i.test(said)) {
        forgetPictures(session, 'claude-code');
        pictures = [];
        picturesRefused = true;
        continue;
      }
      if (st.error) throw new LagrangeError(cliErrorMessage('claude', st.error), { kind: 'stream' });
      if (!st.text) throw new LagrangeError(cliErrorMessage('claude', stderr || `exit code ${code}`), { kind: 'stream' });
      break;
    }
  } finally {
    try { fs.unlinkSync(sysFile); } catch (e) { /* already gone */ }
  }
  return { text: st.text, stopReason: st.stopReason || 'end_turn', stopDetails: null, model: st.model || model || 'Claude Code', fallbackTo: null, picturesRefused };
}

/* What Claude Code reads on stdin with `--input-format stream-json` when there are pictures: one line, a user
   message whose content is the pictures and then the prompt. */
function claudeCodeInput(messages, pictures) {
  const content = pictures.map(p => ({ type: 'image', source: { type: 'base64', media_type: p.mediaType || 'image/png', data: p.data } }));
  content.push({ type: 'text', text: transcriptPrompt(messages) });
  return JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n';
}

async function streamCodex(s, req, hooks, session) {
  const exe = findCli('codex', s.codexPath);
  if (!exe) throw new LagrangeError(`Codex wasn’t found${s.codexPath ? ` at ${s.codexPath}` : ''}. ${CLI.codex.install}`, { kind: 'setup' });
  const fs = nodeModule('fs'), os = nodeModule('os'), path = nodeModule('path');
  const model = String(s.codexModel || '').trim();
  const instructions = '<instructions>\n' + (req.system || '') + '\n\nAnswer in text only: do not run commands, and do not ' +
    'read or write files. Everything you need is in this message.\n</instructions>\n\n';
  let effort = sessionEffort(s, session, `codex:${model}`);
  // Pictures of the page are attached with `-i`, which takes files: they are written to a folder of their own in the
  // temporary folder (which only this user can read), and the folder is deleted when Codex has finished.
  let pictures = messagePictures(req.messages), picturesRefused = false;
  const quote = a => (process.platform === 'win32' && /\.cmd$/i.test(exe) ? `"${String(a).replace(/"/g, '""')}"` : a);
  let dir = null, st;
  try {
    for (;;) {
      const args = ['exec', '--json', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only'];
      if (pictures.length) {
        if (!dir) dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lagrange-look-'));
        pictures.forEach((p, i) => {
          const file = path.join(dir, `page-${i + 1}.${p.mediaType === 'image/jpeg' ? 'jpg' : 'png'}`);
          fs.writeFileSync(file, Buffer.from(p.data, 'base64'));
          args.push('-i', quote(file));
        });
      }
      args.push('-C', os.tmpdir());
      if (model) args.push('-m', model);
      const input = instructions + transcriptPrompt(picturesRefused ? withoutPictures(req.messages) : req.messages);
      st = { text: '', error: null, done: false };
      // `-c key=value` overrides Codex's config for this run; a bare word is taken as a string.
      const { code, stderr } = await runCli('codex', exe, args.concat(effort ? ['-c', `model_reasoning_effort=${effort}`] : [], '-'), input, line => {
        const delta = applyCodexLine(st, line);
        if (delta && hooks.onText) hooks.onText(delta, st.text);
      }, hooks);
      const said = `${st.error || ''} ${stderr}`;
      // A model or a Codex that won't take this effort says so: run it again without.
      if (effort && !st.text && /reasoning|effort/i.test(said)) {
        forgetEffort(session, `codex:${model}`);
        effort = '';
        continue;
      }
      // One that will not take the pictures: the page goes in words.
      if (pictures.length && !st.text && /image|unexpected argument|unrecogni[sz]ed|unknown/i.test(said)) {
        forgetPictures(session, `codex:${model}`);
        pictures = [];
        picturesRefused = true;
        continue;
      }
      if (st.error) throw new LagrangeError(cliErrorMessage('codex', st.error), { kind: 'stream' });
      if (!st.text) throw new LagrangeError(cliErrorMessage('codex', stderr || `exit code ${code}`), { kind: 'stream' });
      break;
    }
  } finally {
    if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* left in the temporary folder */ } }
  }
  return { text: st.text, stopReason: 'end_turn', stopDetails: null, model: model || 'Codex', fallbackTo: null, picturesRefused };
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

/* ---- Drawing a drop cap (see "Drawing a drop cap" among the pure helpers) ----
   Each returns {bytes: Uint8Array, kind: 'png' | 'svg', model}. req: {letter, style, mono, change, base: {bytes,
   kind} | null}. */

const OPENAI_IMAGES_URL = 'https://api.openai.com/v1/images';

/* OpenAI's Images API: POST /v1/images/generations, or /v1/images/edits with the present image as a data URL. GPT
   Image models answer with the image in base64. */
async function drawOpenAIImage(s, req, hooks) {
  const key = String(s.openaiPlatformKey || '').trim();
  if (!key) throw new LagrangeError('Add your OpenAI API key in Settings → Lagrange, or choose “ChatGPT: my subscription” to draw with a ChatGPT plan.', { kind: 'setup' });
  const model = String(s.openaiImageModel || '').trim() || DEFAULT_SETTINGS.openaiImageModel;
  const body = { model, prompt: dropcapImagePrompt(req), n: 1, size: '1024x1024', output_format: 'png', background: req.mono ? 'opaque' : 'transparent' };
  const change = Boolean(req.change && req.base && req.base.kind === 'png');
  if (req.change && !change) throw new LagrangeError('The present drop cap is a line drawing (SVG), which an image model cannot be handed. Draw a new one instead.', { kind: 'setup' });
  if (change) body.images = [{ image_url: `data:image/png;base64,${base64FromBytes(req.base.bytes)}` }];
  const url = `${OPENAI_IMAGES_URL}/${change ? 'edits' : 'generations'}`;
  const res = await fetchWithRetry('openai-api', url, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(body), signal: hooks.signal,
  }, hooks);
  const text = await safeText(res);
  if (!res.ok) throw httpError('openai-api', res, text, model);
  let b64 = '';
  try { const data = JSON.parse(text).data; b64 = (data && data[0] && data[0].b64_json) || ''; } catch (e) { /* not JSON */ }
  if (!b64) throw new LagrangeError('OpenAI answered without an image. Try again, or try another image model in Settings → Lagrange.', { kind: 'stream' });
  let bytes;
  try { bytes = bytesFromBase64(b64); } catch (e) { bytes = null; }
  if (!isPng(bytes)) throw new LagrangeError('OpenAI answered with something that is not a PNG image.', { kind: 'stream' });
  return { bytes, kind: 'png', model };
}

/* Codex's image tool, on a ChatGPT subscription: Codex runs once in an empty temporary folder that it may write to
   (and nowhere else), paints the image, and leaves it there as dropcap.png. */
async function drawCodexImage(s, req, hooks) {
  const exe = findCli('codex', s.codexPath);
  if (!exe) throw new LagrangeError(`Codex wasn’t found${s.codexPath ? ` at ${s.codexPath}` : ''}. ${CLI.codex.install}`, { kind: 'setup' });
  const fs = nodeModule('fs'), os = nodeModule('os'), path = nodeModule('path');
  const change = Boolean(req.change && req.base && req.base.kind === 'png');
  if (req.change && !change) throw new LagrangeError('The present drop cap is a line drawing (SVG), which an image model cannot be handed. Draw a new one instead.', { kind: 'setup' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lagrange-dropcap-'));
  try {
    const args = ['exec', '--json', '--skip-git-repo-check', '--ephemeral', '-s', 'workspace-write', '-C', dir];
    const model = String(s.codexModel || '').trim();
    if (model) args.push('-m', model);
    if (change) { fs.writeFileSync(path.join(dir, 'present.png'), Buffer.from(req.base.bytes)); args.push('-i', path.join(dir, 'present.png')); }
    const input = 'Use your built-in image generation tool (do not write code, a script or an SVG) to make one image' +
      (change ? ', a changed version of the attached image' : '') + ':\n\n' + dropcapImagePrompt(req) +
      '\n\nSave it in the current directory as dropcap.png and do nothing else. If you have no image generation tool, reply exactly NO-IMAGE-TOOL.';
    const st = { text: '', error: null, done: false };
    const { code, stderr } = await runCli('codex', exe, args.concat('-c', 'model_reasoning_effort=low', '-'), input, line => { applyCodexLine(st, line); }, hooks);
    const out = path.join(dir, 'dropcap.png');
    if (!fs.existsSync(out)) {
      if (/NO-IMAGE-TOOL/.test(st.text)) throw new LagrangeError('This Codex has no image tool. Update Codex (npm install -g @openai/codex), or choose “OpenAI API” in Settings → Lagrange.', { kind: 'setup' });
      throw new LagrangeError(st.error || (!st.text && (stderr || code)) ? cliErrorMessage('codex', st.error || stderr || `exit code ${code}`)
        : `Codex finished without leaving an image. It said: ${excerpt(st.text, 300)}`, { kind: 'stream' });
    }
    const bytes = new Uint8Array(fs.readFileSync(out));
    if (!isPng(bytes)) throw new LagrangeError('Codex left a file that is not a PNG image.', { kind: 'stream' });
    return { bytes, kind: 'png', model: model || 'Codex' };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* left in the temporary folder */ }
  }
}

/* The language model writes the initial as an SVG drawing. */
async function drawSvg(settings, req, hooks, session) {
  let base = '';
  if (req.change) {
    if (!req.base || req.base.kind !== 'svg') throw new LagrangeError('The present drop cap is a picture, and this provider can only change a line drawing (SVG). Draw a new one, or choose “ChatGPT: my subscription” in Settings → Lagrange.', { kind: 'setup' });
    base = new TextDecoder().decode(req.base.bytes);
  }
  const res = await complete(settings, {
    purpose: 'dropcap',
    system: DROPCAP_SVG_SYSTEM,
    messages: [{ role: 'user', content: dropcapSvgMessage(Object.assign({}, req, { base })) }],
    demo: () => demoDropcapSvg(req.letter),
  }, hooks, session);
  if (res.stopReason === 'refusal') throw new LagrangeError('The model declined to draw this.');
  const svg = extractSvg(res.text);
  if (!svg) {
    throw new LagrangeError(`The reply had no SVG drawing in it${res.stopReason === 'max_tokens' ? ' (it reached its length limit)' : ''}. Try again, or choose another model.`, { reply: res.text });
  }
  return { bytes: new TextEncoder().encode(svg), kind: 'svg', model: res.model };
}

function drawDropcap(settings, req, hooks, session) {
  hooks = hooks || {};
  if (!dropcapLetter(req.letter)) return Promise.reject(new LagrangeError('A drop cap is one letter, A to Z.', { kind: 'setup' }));
  const route = dropcapRoute(settings);
  if (route === 'image-api') return drawOpenAIImage(settings, req, hooks);
  if (route === 'codex-image') return drawCodexImage(settings, req, hooks);
  return drawSvg(settings, req, hooks, session);
}


/* ---- Prompts ---- */

function noteBlock(note, clip) {
  if (!note) return 'No note is open.';
  const where = clip.clipped
    ? ` The note is long (${clip.total} characters), so only the part around the writer’s cursor is included.`
    : '';
  return `The note is titled “${note.title}”.${where}\n\n<note>\n${clip.text}\n</note>`;
}

// Obsidian typesets $…$ and $$…$$ only; \\( \\) and \\[ \\] stay as they are typed.
const MATH_STYLE =
  'Write mathematics the way Obsidian reads it: $…$ inside a sentence, and $$…$$ on lines of its own for a displayed ' +
  'equation (an align or other environment goes inside $$…$$); never \\( \\) or \\[ \\].';

// Centred and right-aligned text: the marker lines the Scriptorium plugin reads (its "Centred and right-aligned
// text"). In every system prompt, so that verse is centred whoever writes it and the markers are left alone.
const ALIGN_STYLE =
  'Scriptorium centres a block of text, or sets it to the right, between two marker lines: "::: center" (or ' +
  '"::: right") on a line of its own, then the lines of text, then ":::" on a line of its own, with a blank line ' +
  'before the opening marker and after the closing one. Between the markers every line of the note is a line on the ' +
  'page (no two spaces or backslash at a line’s end), and a blank line parts two stanzas. Always centre poetry and ' +
  'verse this way, whether you write it, quote it or revise it: a poem, a stanza, song lyrics, a few lines of ' +
  'verse; and an epigraph or a dedication of a line or two where centring suits it. Set an attribution or a ' +
  'signature (a line such as "— Emily Dickinson") to the right with "::: right" when the writer asks for that. ' +
  'Centred and right-aligned text has no drop cap: never write "dropcap" on a marker line ("::: center dropcap" ' +
  'asks for one) unless the writer asks for a drop cap on that text. Leave the marker lines that are already in ' +
  'the note as they are unless the writer asks for another alignment, and never use HTML or a callout to align text.';

const CHAT_INTRO =
  'You are Lagrange, a writing companion inside Obsidian. The writer uses Scriptorium, a configuration that ' +
  'sets notes like the pages of a printed book. You talk with the writer about the note they have open: answer ' +
  'questions about it, suggest improvements, and explain your thinking briefly. Write plain, warm, precise prose, ' +
  'and use Markdown lightly (a short list or some emphasis when it helps). Quote the note exactly when you quote ' +
  'it. ' + MATH_STYLE + ' ' + ALIGN_STYLE + ' ';

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

// The contract for a look at the page in a chat reply (see "Looking at the page" among the pure helpers). It stands
// by itself, after whichever of the two paragraphs above applies, and is left out when looking is turned off.
const CHAT_LOOK =
  'You can also look at the page. What you are given is the note’s Markdown source; the writer reads the page that ' +
  'Scriptorium sets from it (drop caps, small capitals, centred headings, notes in the margin, mathematics, callouts, ' +
  'pictures), and how that comes out depends on their theme, fonts and the width of their window, none of which the ' +
  'source shows. When your answer depends on how the page actually looks (alignment, spacing, where a line breaks, ' +
  'whether a drop cap, an equation, a table or a picture came out right, what is in the margin), or the writer asks ' +
  'how something looks, do not guess: say in a few words what you are checking, and end your reply with one block ' +
  'in exactly this form:\n\n' +
  '```lagrange-look\n' +
  '{"target": "note"}\n' +
  '```\n\n' +
  'The block holds one JSON object, and the target is one of:\n' +
  '- {"target": "note"}: the whole note, from its beginning;\n' +
  '- {"target": "view"}: the part the writer has on screen now;\n' +
  '- {"target": "section", "heading": "the heading’s text"}: one section;\n' +
  '- {"target": "passage", "near": "exact words from the note"}: the paragraph holding those words, and its neighbours;\n' +
  '- {"target": "lines", "from": 12, "to": 40}: a range of the source’s lines.\n' +
  'Stop after the block. The page as Reading view renders it is then shown to you, in pictures where the model you ' +
  'run on takes them, and always with what was measured on it (each block’s alignment, font, lines, drop cap, ' +
  'footnotes, and whether it is too wide for its column), and you carry on with your reply to the writer. The writer ' +
  'sees that you looked, and can open what you were shown. You may look at most twice for one message of the ' +
  'writer’s, and a long note takes more than one look, so choose the target with care; do not look when the source ' +
  'already answers the question.';

// With the pen as well: the two blocks in one reply.
const CHAT_LOOK_AFTER_EDITS =
  ' A reply may hold an edits block and, after it, a look block: your pen writes the edits first, and the look then ' +
  'shows the page as it stands after them, which is how to check a change you have made.';

function chatSystemPrompt(note, clip, agentic, look) {
  return CHAT_INTRO + (agentic ? CHAT_AGENTIC : CHAT_TALK_ONLY) +
    (look && note ? '\n\n' + CHAT_LOOK + (agentic ? CHAT_LOOK_AFTER_EDITS : '') : '') + '\n\n' +
    (note ? noteBlock(note, clip) : 'No note is open at the moment; talk with the writer about their writing in general.');
}

const PROOFREAD_SYSTEM =
  'You are Lagrange, a careful proofreader working inside Obsidian. You will receive one note written in Markdown. ' +
  'Find mistakes of spelling, grammar, punctuation and typography, and nothing else: do not rewrite for style, do not ' +
  'change the meaning, and leave Markdown syntax, links, code, YAML front matter and deliberately foreign text (such ' +
  'as Latin placeholder text) as they are.\n\n' +
  'One piece of that syntax, so that you leave it as it is: ' + ALIGN_STYLE + '\n\n' +
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
  'nothing outside the passage. ' + MATH_STYLE + ' ' + ALIGN_STYLE;

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
// The pen that sets Lagrange's edits down in the note: a fountain pen flies to each edit and strikes the old words
// through in rubric ink; the new text then takes its place in the note, unseen at first, and the pen writes it in its
// own handwriting exactly where it will stand: the first stroke is where the first letter of the new text is (same
// left edge, same baseline), each further line starts at the left edge of the note's own line and wraps where the
// text column does, and the lines are the note's lines. Text that the note centres or sets to the right (between
// Scriptorium's marker lines "::: center" and "::: right", which are never written) is written line for line as the
// note sets it: each line of handwriting starts where the note starts that line (noteRows), and is no wider than
// the column. The handwriting may be larger than the note's type. A long
// edit is written for a few lines (settings.penLines, 3 by default; see penLines) and ends in an ellipsis; then the
// handwriting gives way to the text itself, which is already in its place, so nothing moves. Between edits the pen
// hovers; a moment after the last one it flies off.
// Several pens may write at once, each an edit of its own (how.slot: pen 0 is the one that writes alone; the others
// are a little smaller and fainter, held at a slightly different angle, and come and go by the right-hand edge at
// the height of their work, each a moment after the one before): every pen has its own graphic, typewriter, trail
// of ink and handwriting, and its own marks in the note. They share the sheet and its one animation frame. Whatever
// one pen puts into the note moves the text the others are at: each edit looks once a frame (and at once after any
// pen's change) at where its words stand, and what it has drawn (its strike-through, its handwriting, its pen)
// follows them there.
// Mathematics in a replacement ($…$, $$…$$, and LaTeX's \(…\), \[…\] and bare environments) is drawn symbol by
// symbol, the nib following each one, where the note typesets it: in Live Preview the pen draws on the note's own
// typeset equation (an inline one in its line, a displayed one in its centred block), after the words around it are
// set down. Where the note shows the source instead (Source mode, or an equation the cursor is in) the equation is
// typeset with Obsidian's MathJax (loaded first, and waited for) in the pen's script; if it can't be typeset (no
// MathJax, or a TeX error) the pen writes its source like other text, and says why on the console (equationPlan).
// A short line of ink trails behind the nib as it moves (settings.penTrail) and fades in half a second.
// Code in a replacement (a fenced block, or a code span of a few characters) is not written but typed: the pen gives
// way to a small typewriter, and the code appears in the monospace font one character at a time, at a typist's uneven
// pace, with a carriage return at each line end and no trail of ink; for the prose around it the pen comes back.
//
// Where it is drawn: on a sheet inside the editor's scroller (layerFor), which scrolls with the note and is clipped
// where the note is; nothing of the pen is fixed to the window. Each line of handwritten words is a box of its own
// (cutLines, .lagrange-pen-seg), unseen until the pen comes to it and then uncovered up to the nib through a soft
// edge, with room around it for the tails and loops of its letters: one line's ink never shows through another's.
// The editor is not locked while the pen writes. The writer's selection is left where it is, and whatever they type
// meanwhile moves the places the pen holds (track); see runEdits for what a click or a key does to a run.
//
// Contract
//   createPen(app, settings) -> { edit(view, from, to, replacement, run, how), finish(), destroy(), extension, pens }
//     settings.penSpeed (0.5 slow .. 3 fast), settings.penTrail and settings.penLines are read on every edit. Lagrange
//     calls edit() for one edit at a time, in document order, or for several at once (as many as `pens`, each with a
//     slot of its own, and never two in one paragraph), and folds all changes into one undo step; see runEdits.
//     run (optional) is an object shared by the edits of one run: the pen keeps in run.spent how long its handwriting
//     has taken, and writes less of each later edit once that is long (penLines); with a run the pen's change stays
//     out of the undo history (the run makes its own step).
//     how (optional) is for an edit written while others are: {slot, delay, stay, leave, tally}. slot: which pen
//     writes it (0 to pens - 1; two edits never have the same slot at the same time). delay: ms (at pen speed 1) it
//     waits before setting out. stay: the note is not scrolled to it (it is in view: the caller saw to that).
//     leave: the pen goes as soon as it is done, instead of hovering a while (it comes back if it is given another
//     edit meanwhile). tally: an object like run whose .spent this edit's handwriting counts against, in place of
//     run's (each pen has its own measure of time).
//   pen.edit(view, from, to, replacement): bring the edit into view if it is not comfortably there, or has not the
//     room under it for what will be written (penRoom); strike [from, to], view.dispatch the change (annotated
//     penWrite), write `replacement` over it,
//     and remove every mark it added. The change is dispatched exactly once, whatever happens, unless the writer
//     changed the words to be replaced before the pen had struck them: then it is not made, and edit() resolves to
//     {skipped: why}. With prefers-reduced-motion the pen does not fly, leaves no trail and draws no equation: the
//     old words dim briefly and the change is made.
//   pen.finish(): ends every edit being written, synchronously: their changes are made if they had not been, and
//     the pens, their ink and their handwriting are gone when it returns.
//   pen.pens: how many edits the pen can write at the same time (1 for a pen that writes one at a time: runEdits
//     then never asks for more).
//   pen.extension: the editor extension the pen needs; the plugin registers it in every editor (else the pen adds it
//     at its first edit there).
//   pen.destroy(): removes the pen, its ink and its decorations from every editor, and stops its timers.
const penWrite = Annotation.define();   // on every change Lagrange itself makes to a note during a run of edits
function createPen(app, settings) {
  const SLOTS = Array.from({ length: PEN_MAX }, (_, i) => i);
  const penOwner = Annotation.define();   // on a change of the pen's own: the edit (its place, see track) that made it
  /* The marks each pen has on the note (the struck words, the text not yet written): one set for each slot, so that
     a pen puts its own on and takes its own off. The effect: {slot, deco}, deco a DecorationSet or null; or null,
     which takes every pen's marks off. */
  const setGone = StateEffect.define();
  const goneField = StateField.define({
    create: () => SLOTS.map(() => Decoration.none),
    update(sets, tr) {
      if (tr.docChanged && sets.some(d => d !== Decoration.none)) sets = sets.map(d => d.map(tr.changes));
      for (const e of tr.effects) {
        if (!e.is(setGone)) continue;
        if (!e.value) sets = SLOTS.map(() => Decoration.none);
        else sets = sets.map((d, i) => (i === e.value.slot ? e.value.deco || Decoration.none : d));
      }
      return sets;
    },
    provide: f => SLOTS.map(i => EditorView.decorations.from(f, sets => sets[i])),
  });
  const goneMark = Decoration.mark({ class: 'lagrange-pen-gone' });
  // new text a pen has yet to write, and a line that is all new text (its box is unseen too): marked with the pen's
  // slot, for each pen shows its own text when its own handwriting fades (the styles: .lagrange-pen-revealing-N)
  const unwrittenMark = SLOTS.map(i => Decoration.mark({ class: `lagrange-pen-unwritten lagrange-pen-of-${i}` }));
  const unwrittenLine = SLOTS.map(i => Decoration.line({ class: `lagrange-pen-unwritten-line lagrange-pen-of-${i}` }));
  /* The marks that keep new text unseen until it is written: the text from `lead` on, and every line of the note that
     the text fills entirely (so that the tinted box of a code block, or a rule under a heading, does not show before
     its words). from: where the text was put; whole: whether the text begins and ends at line ends of the note. */
  const unwritten = (slot, from, text, lead, startsLine, endsLine) => {
    const marks = [unwrittenMark[slot].range(from + lead, from + text.length)];
    const lines = text.split('\n');
    let at = from;
    lines.forEach((line, i) => {
      const first = i === 0, last = i === lines.length - 1;
      if ((!first || startsLine) && (!last || endsLine)) marks.push(unwrittenLine[slot].range(at));
      at += line.length + 1;
    });
    return Decoration.set(marks, true);
  };
  const SVGNS = 'http://www.w3.org/2000/svg';
  const views = new Set();
  const layers = new Map();               // EditorView -> its sheet: { sheet, svg, marks, pens: [pen 0, pen 1, …], live, win, … }
  const TRAIL_MS = 520, TRAIL_BANDS = 5;  // how long the ink trail lasts, and how many strokes it is drawn in
  // Pen 0 is the pen as it always was. The others: how far each is turned (degrees), how large and how plain it is
  // drawn (a little smaller and fainter, as if further off), how soon its flights are over (so that no two move in
  // step), and where along a flight its arc is highest.
  const PEN_TILT = [0, 7, -6, 4], PEN_SIZE = [1, 0.9, 0.84, 0.87], PEN_SHADE = [1, 0.92, 0.85, 0.88];
  const PEN_TEMPO = [1, 1.12, 0.92, 1.05], PEN_BOW = [0.5, 0.36, 0.62, 0.44];
  const STOP = { penStop: true };         // what a wait is rejected with when the edit it belongs to is ended early
  const tracked = new Set();              // the edits being written: their places in the note are kept up (see track)
  const taken = new Set();                // the note's own equations that some edit has taken to draw
  let destroyed = false;
  const current = new Set();              // the edits being written: { ctx, view, slot, finish() }

  /* The note may change while a pen writes: by the writer's hand (see runEdits), and by another pen's. Every change
     that is not an edit's own moves the places that edit holds, and a change of the writer's inside words the pen
     is about to strike spoils that edit. */
  const watch = EditorView.updateListener.of(update => {
    if (!update.docChanged || !tracked.size) return;
    for (const tr of update.transactions) {
      if (!tr.docChanged) continue;
      if (tr.annotation(penWrite)) {
        const owner = tr.annotation(penOwner);
        for (const p of tracked) if (p.view === update.view && p !== owner) p.map(tr.changes, true);
        continue;
      }
      if (tr.startState.doc.eq(tr.state.doc)) continue;   // text replaced by itself (Obsidian's resetSyntaxHighlighting): nothing has moved
      for (const p of tracked) if (p.view === update.view) p.map(tr.changes);
    }
  });
  const extension = [goneField, watch];   // the plugin registers it in every editor; else it is added at the first edit
  const install = view => {
    if (view.state.field(goneField, false) === undefined) view.dispatch({ effects: StateEffect.appendConfig.of(extension) });
    views.add(view);
  };
  const track = (view, from, to) => {
    const p = {
      view, from, to, start: null, end: null, dirty: false, committed: false,
      map(changes, pens) {                // pens: the change is another pen's, which never spoils an edit
        if (!p.committed) {
          if (p.to > p.from && !pens) changes.iterChangedRanges((a, b) => { if (a < p.to && b > p.from) p.dirty = true; });
          const insertion = p.from === p.to;
          p.from = changes.mapPos(p.from, 1);
          p.to = insertion ? p.from : Math.max(p.from, changes.mapPos(p.to, -1));
        } else {
          p.from = changes.mapPos(p.from, 1);
          p.to = Math.max(p.from, changes.mapPos(p.to, -1));
          if (p.start !== null) { p.start = changes.mapPos(p.start, 1); p.end = Math.max(p.start, changes.mapPos(p.end, -1)); }
        }
      },
    };
    tracked.add(p);
    return p;
  };
  const mk = (doc, tag, attrs, parent) => {
    const e = doc.createElementNS(SVGNS, tag);
    for (const k in attrs) e.setAttribute(k, String(attrs[k]));
    if (parent) parent.appendChild(e);
    return e;
  };

  /* The pen's sheet: a layer inside the editor's scroller, as tall as the note, on which the pens, their ink and
     their handwriting are placed. It scrolls with the note and is clipped where the note is, so whatever a pen has
     drawn stays on its words when the writer scrolls, resizes the pane or zooms. Everything a pen places is measured
     from the sheet's top left corner (rel, org). One sheet for each editor, shared by its pens (penOn). */
  function layerFor(view) {
    let S = layers.get(view);
    if (S && S.sheet.isConnected) return S;
    const doc = view.dom.ownerDocument;
    const sheet = doc.createElement('div');
    sheet.className = 'lagrange-pen-sheet';
    sheet.setAttribute('aria-hidden', 'true');
    view.scrollDOM.appendChild(sheet);
    const svg = mk(doc, 'svg', { class: 'lagrange-pen-layer', 'aria-hidden': 'true' }, null);
    sheet.appendChild(svg);
    const defs = mk(doc, 'defs', {}, svg);
    const pat = mk(doc, 'pattern', { id: 'lagrange-pen-hatch', width: 3, height: 3, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(80)' }, defs);
    mk(doc, 'rect', { width: 3, height: 3, fill: 'var(--lg-plate)' }, pat);
    mk(doc, 'line', { x1: 0, y1: 0, x2: 0, y2: 3, stroke: 'var(--lg-ink)', 'stroke-width': 0.7, opacity: 0.45 }, pat);
    // from the bottom up: the trails of ink, the strokes that strike words out, the pens and their typewriters
    const trails = mk(doc, 'g', {}, svg), marks = mk(doc, 'g', {}, svg), nibs = mk(doc, 'g', {}, svg);
    const win = doc.defaultView || window;
    S = {
      view, sheet, svg, marks, trails, nibs, win, pens: [], observer: null, height: 0,
      live: new Set(),                    // the edits being written here: each looks once a frame at where its text is (see edit)
      calls: new Map(), call: 0, raf: 0,  // what is to run in the next animation frame (onFrame)
      inFrame: false, o: null,            // during a frame the sheet's place in the window is measured once (org)
    };
    // as tall as the note, and no taller (a taller sheet would let the note scroll past its end)
    S.fit = () => {
      if (!sheet.isConnected) return;
      const h = Math.max(0, view.contentDOM.getBoundingClientRect().bottom - sheet.getBoundingClientRect().top);
      if (Math.abs(h - (S.height || 0)) > 0.5) { S.height = h; sheet.style.height = `${h.toFixed(1)}px`; }
    };
    S.fit();
    try {
      if (typeof win.ResizeObserver === 'function') { S.observer = new win.ResizeObserver(() => S.fit()); S.observer.observe(view.contentDOM); }
    } catch (e) { /* fitted at each edit instead */ }
    layers.set(view, S);
    return S;
  }
  /* One of a sheet's pens (slot 0: the pen that writes alone): its graphic, its typewriter and its trail of ink, where
     it is, and the edit it is writing (ctx). What the functions below call L is a pen; it carries its sheet's parts
     too (sheet, svg, marks, win). */
  function penOn(S, slot) {
    if (S.pens[slot]) return S.pens[slot];
    const doc = S.sheet.ownerDocument;
    const trailG = mk(doc, 'g', { class: 'lagrange-pen-trail' }, S.trails);
    const pen = mk(doc, 'g', { class: 'lagrange-pen' }, S.nibs);
    if (PEN_SHADE[slot] < 1) pen.style.opacity = String(PEN_SHADE[slot]);
    // drawn horizontally with the nib's tip at (0, 0), then turned so the barrel rises to the upper right
    const body = mk(doc, 'g', { transform: `rotate(${-38 + PEN_TILT[slot]})` }, pen);
    const st = { stroke: 'var(--lg-ink)', 'stroke-width': 1.2, 'stroke-linejoin': 'round' };
    mk(doc, 'path', { d: 'M0 0 L16 -5.2 Q22 -6.5 26 -6 L26 6 Q22 6.5 16 5.2 Z', fill: 'var(--lg-plate)', ...st }, body);   // nib
    mk(doc, 'line', { x1: 2, y1: 0, x2: 17, y2: 0, stroke: 'var(--lg-ink)', 'stroke-width': 0.8 }, body);                     // slit
    mk(doc, 'circle', { cx: 18, cy: 0, r: 1.3, fill: 'var(--lg-ink)' }, body);                                                 // breather hole
    mk(doc, 'path', { d: 'M26 -6.5 H48 Q51 -7.5 54 -8 V8 Q51 7.5 48 6.5 H26 Z', fill: 'var(--lg-ink)', opacity: 0.85 }, body);  // section
    mk(doc, 'path', { d: 'M54 -8.5 H150 Q158 -8.5 160 0 Q158 8.5 150 8.5 H54 Z', fill: 'url(#lagrange-pen-hatch)', ...st }, body); // barrel
    mk(doc, 'rect', { x: 92, y: -9, width: 7, height: 18, fill: 'var(--lg-rubric)', opacity: 0.9 }, body);                    // band
    mk(doc, 'path', { d: 'M100 -9 H140 Q144 -9 144 -6', fill: 'none', stroke: 'var(--lg-ink)', 'stroke-width': 1.6 }, body);  // clip
    pen.style.display = 'none';
    // The typewriter that types code, drawn with the point where a letter lands at (0, 0): the platen across the top,
    // the body below it, three rows of keys, and the carriage lever on the left.
    const type = mk(doc, 'g', { class: 'lagrange-typewriter' }, S.nibs);
    mk(doc, 'path', { d: 'M-3.2 -1 L0 2.6 L3.2 -1', fill: 'none', stroke: 'var(--lg-rubric)', 'stroke-width': 1.3, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, type);
    mk(doc, 'rect', { x: -19, y: 3, width: 38, height: 6, rx: 3, fill: 'var(--lg-ink)', opacity: 0.85 }, type);
    mk(doc, 'path', { d: 'M-24 6 H-19 M19 6 H23 M-24 6 V1', fill: 'none', stroke: 'var(--lg-ink)', 'stroke-width': 1.4, 'stroke-linecap': 'round' }, type);
    mk(doc, 'path', { d: 'M-15 9 H15 L21 27 Q22 31 18 31 H-18 Q-22 31 -21 27 Z', fill: 'var(--lg-plate)', ...st }, type);
    mk(doc, 'path', { d: 'M-15 9 H15 L16.5 13.5 H-16.5 Z', fill: 'url(#lagrange-pen-hatch)', stroke: 'var(--lg-ink)', 'stroke-width': 0.8, 'stroke-linejoin': 'round' }, type);
    for (let row = 0; row < 3; row++) {
      for (let i = 0; i < 6 + row; i++) {
        mk(doc, 'circle', { cx: (i - (5 + row) / 2) * 5, cy: 17.5 + row * 4.3, r: 1.35, fill: row === 2 && i === 3 ? 'var(--lg-rubric)' : 'var(--lg-ink)' }, type);
      }
    }
    type.style.display = 'none';
    const L = {
      S, slot, view: S.view, sheet: S.sheet, svg: S.svg, marks: S.marks, win: S.win, pen, type,
      size: PEN_SIZE[slot], tempo: PEN_TEMPO[slot], bow: PEN_BOW[slot],
      pos: null, lift: 0, idle: 0, busy: 0, moving: 0, came: false, ctx: null, trail: { g: trailG, pts: [], paths: [], on: false },
    };
    S.pens[slot] = L;
    return L;
  }
  /* A sheet's animation frame: everything that happens on a sheet in one frame (the waits of every pen's edit, the
     trails) runs from one callback, which first lets every edit being written look at where its text now is (all of
     them reading the page, then all of them writing to it), and during which the sheet's own place in the window is
     measured once. onFrame(S, fn) -> an id for offFrame; fn(now) runs once, in the next frame. */
  const runFrame = (S, now) => {
    S.raf = 0;
    if (destroyed) { S.calls.clear(); return; }
    const calls = Array.from(S.calls.values());
    S.calls.clear();
    S.o = null;
    S.inFrame = true;
    try {
      keepUp(S);
      for (const fn of calls) { try { fn(now); } catch (e) { console.error('Lagrange: the pen', e); } }
    } finally {
      S.inFrame = false;
      S.o = null;
    }
    if (S.live.size && !S.raf) S.raf = S.win.requestAnimationFrame(t => runFrame(S, t));
  };
  const onFrame = (S, fn) => {
    const id = ++S.call;
    S.calls.set(id, fn);
    if (!S.raf) S.raf = S.win.requestAnimationFrame(t => runFrame(S, t));
    return id;
  };
  const offFrame = (S, id) => { S.calls.delete(id); };
  /* Every edit being written on a sheet looks at where its text stands, and then puts what it has drawn there. */
  const keepUp = S => {
    if (!S.live.size || !S.sheet.isConnected) return;
    for (const e of S.live) { try { e.read(); } catch (err) { /* the text is not drawn: as it was */ } }
    for (const e of S.live) { try { e.write(); } catch (err) { /* as it was */ } }
  };
  /* The sheet's top left corner in the window, and a rectangle or a point of the window as the sheet measures it. */
  const org = L => {
    const S = L.S;
    if (S.inFrame && S.o) return S.o;
    const r = S.sheet.getBoundingClientRect(), o = { x: r.left, y: r.top };
    if (S.inFrame) S.o = o;
    return o;
  };
  const rel = (L, r, o) => {
    o = o || org(L);
    return { left: r.left - o.x, top: r.top - o.y, right: r.right - o.x, bottom: r.bottom - o.y, width: r.right - r.left, height: r.bottom - r.top };
  };

  /* One edit's waits (frames, tweens, pauses). When the edit is ended early (the writer clicked or typed, or the pen
     was put away) every wait is rejected with STOP at once, so nothing more of the animation runs. */
  const context = () => {
    const waits = new Set();
    const ctx = {
      stopped: false,
      wait(begin) {
        return new Promise((resolve, reject) => {
          if (ctx.stopped || destroyed) { reject(STOP); return; }
          const entry = { cancel: null, reject };
          entry.cancel = begin(v => { waits.delete(entry); resolve(v); }, e => { waits.delete(entry); reject(e); });
          waits.add(entry);
        });
      },
      stop() {
        ctx.stopped = true;
        for (const w of Array.from(waits)) { try { if (w.cancel) w.cancel(); } catch (e) { /* a timer that is gone */ } w.reject(STOP); }
        waits.clear();
      },
    };
    return ctx;
  };
  const pause = (L, ms) => L.ctx.wait(done => { const id = L.win.setTimeout(done, Math.max(0, ms)); return () => L.win.clearTimeout(id); });
  const frame = L => L.ctx.wait(done => { const id = onFrame(L.S, () => done()); return () => offFrame(L.S, id); });
  // (L.moving: the pen is being moved by a tween, which knows where its text is; a pen at rest is carried along
  // with its text when the note moves it, see nudge)
  const tween = (L, ms, fn) => L.ctx.wait((done, fail) => {
    const S = L.S, ctx = L.ctx, t0 = L.win.performance.now(), dur = Math.max(1, ms);
    let id = 0, on = true;
    const end = () => { if (on) { on = false; L.moving--; } };
    const step = now => {
      if (ctx.stopped || destroyed) { end(); return; }
      const k = Math.min(1, (now - t0) / dur);
      try { fn(k); } catch (e) { end(); fail(e); return; }
      if (k < 1) id = onFrame(S, step); else { end(); done(); }
    };
    L.moving++;
    id = onFrame(S, step);
    return () => { offFrame(S, id); end(); };
  });

  /* The trail: the nib's recent positions, redrawn each frame as a few strokes that thin and fade with age (see
     trailBands). The loop runs only while there is ink left to fade. Each pen has its own. */
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
    if (T.pts.length) onFrame(L.S, () => drawTrail(L)); else T.on = false;
  };
  const inkTrail = (L, x, y) => {
    const T = L.trail, last = T.pts[T.pts.length - 1];
    if (last && Math.hypot(x - last.x, y - last.y) < 1.2) return;
    T.pts.push({ x, y, t: L.win.performance.now() });
    if (T.pts.length > 240) T.pts.shift();
    if (!T.on) { T.on = true; onFrame(L.S, () => drawTrail(L)); }
  };
  const wipeTrail = L => { L.trail.pts.length = 0; for (const p of L.trail.paths) p.setAttribute('d', ''); };

  // (x, y): on the sheet
  const place = (L, x, y) => {
    L.pos = { x, y };
    L.pen.setAttribute('transform', `translate(${x.toFixed(1)} ${(y - L.lift).toFixed(1)}) scale(${(L.size * (1 + L.lift * 0.012)).toFixed(3)})`);
    if (settings && settings.penTrail !== false && L.pen.style.display !== 'none') inkTrail(L, x, y - L.lift);
  };
  /* A pen at rest goes with its text when the note moves it (another pen's edit above it, the writer's typing). */
  const nudge = (L, dx, dy) => { if (L && L.pos && !L.moving) place(L, L.pos.x + dx, L.pos.y + dy); };
  const ease = k => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);
  // (rise: how high the arc is, 1 as a rule; a pen that is one of several comes and goes by a flatter one, see doorIn)
  const arc = (L, a, x, y, rise = 1) => {
    const mx = a.x + (x - a.x) * L.bow, my = Math.min(a.y, y) - Math.min(60, 20 + Math.hypot(x - a.x, y - a.y) * 0.15) * rise;
    return k => { const e = ease(k), u = 1 - e; return { x: u * u * a.x + 2 * u * e * mx + e * e * x, y: u * u * a.y + 2 * u * e * my + e * e * y }; };
  };
  /* The pen flies to where to() says, asked again in every frame: its goal may move while it is on its way. */
  const flyTo = async (L, to, ms, lift = 14, rise = 1) => {
    const a = L.pos ? { ...L.pos } : to();
    await tween(L, ms * L.tempo, k => {
      const t = to(), q = arc(L, a, t.x, t.y, rise)(k);
      L.lift = Math.sin(k * Math.PI) * lift * Math.min(1, rise * 1.5);
      place(L, q.x, q.y);
    });
    L.lift = 0;
    const t = to();
    place(L, t.x, t.y);
  };
  const fly = (L, x, y, ms, lift) => flyTo(L, () => ({ x, y }), ms, lift);
  /* Obsidian's MathJax, loaded on first use and waited for: the first equation of a session has to wait for it (a
     second or two, more on a slow disk), and one drawn before it is there would come out as its source.
     -> {renderer, loaded, error}, for equationPlan. */
  const MATHJAX_WAIT = 9000;
  const mathReady = async L => {
    if (typeof obsidian.renderMath !== 'function') return { renderer: false };
    let error = '';
    try {
      if (typeof obsidian.loadMathJax === 'function') {
        await L.ctx.wait(done => {
          const id = L.win.setTimeout(done, MATHJAX_WAIT);
          Promise.resolve(obsidian.loadMathJax()).then(() => done(), e => { error = String((e && e.message) || e || 'an error'); done(); });
          return () => L.win.clearTimeout(id);
        });
      }
    } catch (e) { if (e === STOP) throw e; error = String((e && e.message) || e || 'an error'); }
    return { renderer: true, loaded: typeof window.MathJax !== 'undefined' && window.MathJax !== null, error };
  };
  /* The symbols of a typeset equation, in the order TeX reads them: MathJax's CHTML output (Obsidian's) has one
     <mjx-c> per character; its SVG output has paths. */
  const mathGlyphs = el => {
    const svg = el.querySelector('svg');
    if (svg) return Array.from(svg.querySelectorAll('use, path, rect')).filter(n => !n.closest('defs'));
    return Array.from(el.querySelectorAll('mjx-c'));
  };
  /* Draws one symbol over ms: an SVG outline is traced by the nib and then filled; a CHTML character is uncovered
     from left to right under it. onX(x) reports how far right (in the window) the ink has reached. */
  const drawGlyph = async (L, g, ms, onX) => {
    const win = L.win, box = g.getBoundingClientRect();
    if (box.width < 0.5 && box.height < 0.5) { g.style.opacity = ''; g.style.clipPath = ''; return; }
    let outline = null, len = 0, ctm = null;
    if (g.ownerSVGElement) {
      try {
        const href = g.tagName.toLowerCase() === 'use' ? (g.getAttribute('href') || g.getAttribute('xlink:href') || '') : '';
        outline = href ? g.ownerDocument.getElementById(href.replace(/^#/, '')) : g;
        len = outline && outline.getTotalLength ? outline.getTotalLength() : 0;
        ctm = len ? g.getScreenCTM() : null;
      } catch (e) { len = 0; }
    }
    const r0 = rel(L, box);
    if (Math.hypot(r0.left - L.pos.x, r0.bottom - L.pos.y) > 6) await fly(L, r0.left, r0.top + r0.height * 0.6, Math.min(110, ms), 3);
    if (len && ctm) {
      g.style.opacity = '';
      g.style.fillOpacity = '0';
      g.style.stroke = 'currentColor';
      g.style.strokeWidth = '34';                     // MathJax draws in thousandths of an em
      g.style.strokeDasharray = String(len);
      await tween(L, ms, t => {
        g.style.strokeDashoffset = (len * (1 - t)).toFixed(1);
        let q = outline.getPointAtLength(len * t);
        q = new win.DOMPoint(q.x, q.y).matrixTransform(g.getScreenCTM() || ctm);
        const o = org(L), now = g.getBoundingClientRect();
        place(L, q.x - o.x, q.y - o.y);
        onX(now.left + now.width * t);
      });
      for (const k of ['fillOpacity', 'stroke', 'strokeWidth', 'strokeDasharray', 'strokeDashoffset']) g.style[k] = '';
    } else {
      g.style.opacity = '';
      await tween(L, ms, t => {
        g.style.clipPath = `inset(-60% ${((1 - t) * 100).toFixed(1)}% -60% -20%)`;
        // down the symbol's left side, then up and across to its right shoulder
        const now = g.getBoundingClientRect(), r = rel(L, now);
        const y = t < 0.45 ? r.top + r.height * (0.25 + t * 1.6) : r.bottom - r.height * (t - 0.45) * 1.3;
        place(L, r.left + r.width * t, y);
        onX(now.left + now.width * t);
      });
      g.style.clipPath = '';
    }
  };

  /* Types one piece of code (see penScript): the typewriter takes the pen's place, sits under the letter it is
     typing and dips at each stroke; a line end is a carriage return. Then the pen comes back, where the typing ended. */
  const typeCode = async (L, piece, k) => {
    const [typed, mark, rest] = piece.el.childNodes;
    const text = piece.text;
    const pauses = typeCadence(text, 5200, text.length * 2654435761);
    const at = () => { const r = rel(L, mark.getBoundingClientRect()); return { x: r.left, y: r.bottom }; };
    const put = (q, dip) => L.type.setAttribute('transform', `translate(${q.x.toFixed(1)} ${(q.y + 2 + (dip ? 1.4 : 0)).toFixed(1)})`);
    L.pen.style.display = 'none';
    L.trail.pts.length = 0;                          // no ink while typing
    L.type.style.display = '';
    put(at());
    let i = 0, n = 0;
    for (const ch of text) {
      const before = at();
      i += ch.length;
      typed.textContent = text.slice(0, i);
      rest.textContent = text.slice(i);
      const ms = pauses[n++] * k;
      if (ch === '\n') {
        const after = at();                          // the carriage runs back to the start of the next line
        await tween(L, ms, t => { const e = ease(t); put({ x: before.x + (after.x - before.x) * e, y: before.y + (after.y - before.y) * e }); });
      } else {
        put(at(), true);
        await pause(L, ms * 0.4);
        put(at(), false);
        await pause(L, ms * 0.6);
      }
    }
    const end = at();
    L.type.style.display = 'none';
    L.pen.style.display = '';
    L.trail.pts.length = 0;
    L.lift = 0;
    place(L, end.x, end.y - 4);
  };

  /* Where the character at pos stands: {x, top, bottom, baseline} on the sheet, or null if it is not drawn (off
     screen). The baseline is found from the font's own ascent and descent, which is what the character's box is. */
  const charBox = (L, view, pos) => {
    let c = view.coordsAtPos(pos, 1) || view.coordsAtPos(pos, -1);
    if (!c) return null;
    let ratio = 0.8;
    try {
      const at = view.domAtPos(pos);
      const el = at.node.nodeType === 1 ? at.node : at.node.parentElement;
      const win = el.ownerDocument.defaultView, cs = win.getComputedStyle(el);
      c = onItsLine(c, pos < view.state.doc.length ? view.coordsAtPos(pos + 1, 1) : null, parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) || 16) * 1.5);
      const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      // (a font is measured once: this is asked for every pen in every frame)
      const known = charBox.fonts || (charBox.fonts = new Map());
      if (known.has(font)) ratio = known.get(font);
      else {
        const ctx = (charBox.canvas || (charBox.canvas = el.ownerDocument.createElement('canvas'))).getContext('2d');
        ctx.font = font;
        const m = ctx.measureText('x');
        if (m.fontBoundingBoxAscent > 0) ratio = m.fontBoundingBoxAscent / (m.fontBoundingBoxAscent + m.fontBoundingBoxDescent);
        if (known.size > 64) known.clear();
        known.set(font, ratio);
      }
    } catch (e) { /* the usual proportion */ }
    const o = org(L);
    return { x: c.left - o.x, top: c.top - o.y, bottom: c.bottom - o.y, baseline: c.top - o.y + (c.bottom - c.top) * ratio };
  };
  /* An initial counts as a letter of the line it opens. Scriptorium sets the first letter of a chapter's opening
     paragraph as a drop cap, in Live Preview too: three lines deep (its box is far taller than a line), or not
     drawn at all where a picture stands for it (its box has no height). The pen writes words on the lines of the
     text, so such a letter is given the height of the letter after it (next), and keeps its own left edge. */
  const onItsLine = (c, next, lineHeight) => {
    const h = c.bottom - c.top;
    if (!next || !(next.bottom > next.top) || (h <= lineHeight * 1.8 && h >= lineHeight * 0.3)) return c;
    return next.bottom - next.top > lineHeight * 1.8 ? c : { left: c.left, right: c.right, top: next.top, bottom: next.bottom };
  };
  /* The initial that the text at pos stands beside, if it does: the lines beside a drop cap (a letter three lines
     deep, or a picture in its place) begin after it, and so must the lines of the handwriting. → {right, bottom,
     own} on the sheet (where those lines begin; where the initial ends; own, whether the text at pos begins with
     the initial itself, and so begins at the margin), or null: there is none, or the text stands below it. first
     is the charBox of pos. */
  const besideInitial = (L, view, pos, first) => {
    try {
      const at = view.domAtPos(pos), el = (at.node.nodeType === 1 ? at.node : at.node.parentElement).closest('.cm-line');
      if (!el || !el.classList.contains('scriptorium-opening')) return null;
      const win = L.win, o = org(L), px = v => parseFloat(v) || 0;
      const picture = win.getComputedStyle(el, '::before'), letter = win.getComputedStyle(el, '::first-letter');
      let right = 0, bottom = 0;
      if (picture.content !== 'none' && picture.content !== 'normal' && picture.float === 'left') {
        const box = el.getBoundingClientRect(), cs = win.getComputedStyle(el);
        right = box.left + px(cs.paddingLeft) + px(picture.marginLeft) + px(picture.width) + px(picture.marginRight);
        bottom = box.top + px(cs.paddingTop) + px(picture.marginTop) + px(picture.height) + px(picture.marginBottom);
      } else if (letter.float === 'left') {
        const line = view.state.doc.lineAt(pos), tall = px(win.getComputedStyle(el).lineHeight) * 1.8;
        let cap = null, capAt = -1;
        for (let p = line.from; p < Math.min(line.to, line.from + 8) && !cap; p++) {
          const c = view.coordsAtPos(p, 1);
          if (c && c.bottom - c.top > tall) { cap = c; capAt = p; }
        }
        if (!cap) return null;
        const end = view.coordsAtPos(capAt + 1, -1);       // (a place has no width: the letter's right edge is the place after it)
        right = Math.max(cap.right, end && end.bottom - end.top > tall ? end.right : cap.right) + px(letter.marginRight);
        bottom = cap.bottom + px(letter.marginBottom);
        if (pos <= capAt) return { right: right - o.x, bottom: bottom - o.y, own: true };
      } else return null;
      right -= o.x; bottom -= o.y;
      return first.top < bottom - 2 && first.x >= right - 2 ? { right, bottom, own: false } : null;
    } catch (e) { return null; }
  };
  /* The text column at pos: the left and right edges (on the sheet) between which the note's line wraps, and the
     height of its lines. */
  const columnAt = (L, view, pos) => {
    const win = L.win;
    let el = null;
    try { const at = view.domAtPos(pos); el = (at.node.nodeType === 1 ? at.node : at.node.parentElement).closest('.cm-line'); } catch (e) { el = null; }
    const box = rel(L, (el || view.contentDOM).getBoundingClientRect()), cs = win.getComputedStyle(el || view.contentDOM);
    const left = box.left + (parseFloat(cs.paddingLeft) || 0), right = box.right - (parseFloat(cs.paddingRight) || 0);
    const fs = parseFloat(cs.fontSize) || 16;
    return { left, right: Math.max(right, left + 40), lineHeight: parseFloat(cs.lineHeight) || fs * 1.5, fontSize: fs, align: el ? alignOf(cs) : '' };
  };
  /* How a line of the note is set: 'center', 'right' or '' (from its left edge, as most text is). */
  const alignOf = cs => (/center/.test(cs.textAlign) ? 'center' : /right|end/.test(cs.textAlign) ? 'right' : '');
  /* The lines of the page that the note sets its text [from, to) in: [{off, text, x, top, width, align}], in order,
     off being where a line's first letter is (counted from `from`), x and top where that letter stands on the
     sheet, width how far the line's words reach. The lines that only mark an alignment (ALIGN_MARK) are left out.
     Where the note centres text or sets it to the right, the handwriting keeps to these lines (see lay). */
  const noteRows = (L, view, from, to, lineHeight) => {
    const doc = view.state.doc, o = org(L), end = Math.min(to, from + 1600), mids = [], at = [];
    for (let p = from; p < end; p++) {
      const c = /\S/.test(doc.sliceString(p, p + 1)) ? view.coordsAtPos(p, 1) : null;
      mids.push(c ? (c.top + c.bottom) / 2 : null);
      at.push(c);
    }
    for (let i = 0; i + 1 < at.length; i++) {
      if (!at[i] || !at[i + 1]) continue;
      const c = onItsLine(at[i], at[i + 1], lineHeight);
      if (c !== at[i]) { at[i] = c; mids[i] = (c.top + c.bottom) / 2; }
    }
    const starts = lineStarts(mids, lineHeight * 0.5), rows = [];
    starts.forEach((s, n) => {
      let a = s, b = (n + 1 < starts.length ? starts[n + 1] : mids.length) - 1;
      while (a <= b && mids[a] == null) a++;
      while (b > a && mids[b] == null) b--;
      if (a > b) return;
      const text = doc.sliceString(from + a, from + b + 1), last = view.coordsAtPos(from + b + 1, -1) || at[b];
      if (ALIGN_MARK.test(text)) return;
      let align = '';
      try {
        const dom = view.domAtPos(from + a), el = (dom.node.nodeType === 1 ? dom.node : dom.node.parentElement).closest('.cm-line');
        if (el) align = alignOf(L.win.getComputedStyle(el));
      } catch (e) { align = ''; }
      rows.push({ off: a, text, x: at[a].left - o.x, top: at[a].top - o.y, width: Math.max(0, last.right - at[a].left), align });
    });
    rows.more = end < to;
    return rows;
  };
  /* Waits until the character at pos stands still on the sheet (the change and a reflow move the text for a few
     frames), bringing it on screen if it is not. -> its charBox, or null if it cannot be measured. */
  const settled = async (L, view, at) => {
    let box = null, prev = null, steady = 0, asked = false;
    for (let i = 0; i < 60 && steady < 3; i++) {
      await frame(L);
      box = charBox(L, view, at());
      if (!box && !asked) { asked = true; view.dispatch({ effects: EditorView.scrollIntoView(at(), { y: 'center' }) }); }
      steady = box && prev && Math.abs(box.top - prev.top) < 0.5 && Math.abs(box.x - prev.x) < 0.5 ? steady + 1 : 0;
      prev = box;
    }
    return box;
  };
  /* The note's own typeset equations that an edit has just put in (Live Preview): those that were not there `before`,
     that stand in the edit's own text (at: its place) and that no other edit has taken, and whose source is one of
     `maths`, in the order they stand. -> [{el, source}] */
  const bare = t => String(t || '').replace(/\s+/g, '');
  const newEquations = (view, before, maths, claimed, at) => {
    const wanted = maths.map(g => bare(g.source)), out = [];
    for (const el of view.contentDOM.querySelectorAll('mjx-container')) {
      if (before.has(el) || claimed.has(el) || taken.has(el)) continue;
      const m = el.querySelector('mjx-math[data-latex]') || el.querySelector('[data-latex]');
      const i = m ? wanted.indexOf(bare(m.getAttribute('data-latex'))) : -1;
      if (i < 0) continue;
      // (another pen may have put the same equation into another paragraph in the meantime)
      try { const p = view.posAtDOM(el); if (at && at.end !== null && (p < at.from - 1 || p > at.end + 1)) continue; } catch (e) { /* taken as this edit's */ }
      wanted[i] = null;
      claimed.add(el);
      taken.add(el);
      el.style.opacity = '0';
      out.push({ el, source: maths[i].source });
    }
    return out;
  };
  /* Draws one of the note's own equations where it stands, as drawGlyph draws each symbol; one too long for that is
     uncovered from left to right under the nib. It is in the pen's ink while it is drawn, then turns to the note's. */
  const drawInPlace = async (L, box, k) => {
    const win = L.win, glyphs = mathGlyphs(box);
    if (!box.isConnected) return;
    let shown = 0;
    const reveal = x => {
      const r = box.getBoundingClientRect();
      shown = Math.max(shown, x - r.left);
      box.style.clipPath = `inset(-0.6em ${Math.max(0, r.width - shown).toFixed(1)}px -0.6em -0.2em)`;
    };
    box.classList.add('lagrange-pen-drawing');
    const start = box.getBoundingClientRect();
    reveal(start.left);
    if (glyphs.length && glyphs.length <= 90) {
      for (const g of glyphs) g.style.opacity = '0';
      box.style.opacity = '';
      const each = Math.min(170, 3600 / glyphs.length) * k;
      for (const g of glyphs) {
        if (!box.isConnected) break;
        await drawGlyph(L, g, each, reveal);
      }
      for (const g of glyphs) { g.style.opacity = ''; g.style.clipPath = ''; }
    } else {
      box.style.opacity = '';
      const s = rel(L, start);
      await fly(L, s.left, s.top + s.height * 0.6, 280 * k, 6);
      await tween(L, Math.min(2400, start.width * 9) * k, t => {
        const now = box.getBoundingClientRect(), r = rel(L, now), x = r.left + r.width * t;
        reveal(now.left + now.width * t);
        place(L, x, r.top + r.height * 0.6 + Math.sin(r.width * t * 0.55) * 3.2 - 2);
      });
    }
    box.style.clipPath = '';
    box.style.transition = 'color 420ms ease';
    box.classList.remove('lagrange-pen-drawing');
    win.setTimeout(() => { box.style.transition = ''; }, 480);
  };

  /* Where a pen comes in from and goes out to, just outside the editor's right-hand edge (vr: the editor in view,
     on the sheet): pen 0 by the top corner, as it always has; the others at the height of their own work (y) and by
     a flat arc (DOOR_RISE), along their own lines, so that no pen's way crosses what another is writing. */
  const DOOR_RISE = 0.35;
  const doorIn = (L, vr, y) => (L.slot ? { x: vr.right + 36 + 10 * L.slot, y: Math.max(vr.top - 40, y - 34 - 5 * L.slot) } : { x: vr.right + 40, y: vr.top - 40 });
  const doorOut = (L, vr) => (L.slot ? { x: vr.right + 40, y: Math.max(vr.top - 60, L.pos.y - 26) } : { x: vr.right + 40, y: vr.top - 60 });
  /* A moment after its last edit a pen flies off (after `wait` ms: sooner, for a pen that was one of several). If
     another edit begins while it is leaving (L.busy counts the edits begun), it stops where it is and is not put
     away: otherwise the next edit would be written by no pen. */
  const park = (L, view, wait) => {
    L.win.clearTimeout(L.idle);
    const busy = L.busy;
    L.idle = L.win.setTimeout(() => {
      if (destroyed || !L.pos || L.busy !== busy || !L.sheet.isConnected) return;
      const out = doorOut(L, rel(L, view.scrollDOM.getBoundingClientRect()));
      const at = arc(L, { ...L.pos }, out.x, out.y, L.slot ? DOOR_RISE : 1);
      const t0 = L.win.performance.now();
      const step = now => {
        if (destroyed || L.busy !== busy) return;
        const k = Math.min(1, (now - t0) / 700);
        L.lift = Math.sin(k * Math.PI) * (L.slot ? 7 : 14);
        const q = at(k);
        place(L, q.x, q.y);
        if (k < 1) { onFrame(L.S, step); return; }
        L.lift = 0;
        L.pen.style.display = 'none';
        L.pos = null;
      };
      onFrame(L.S, step);
    }, wait == null ? 1400 : wait);
  };
  /* Puts the pen out of sight at once (an edit ended early). */
  const putAway = L => {
    L.win.clearTimeout(L.idle);
    L.busy = (L.busy || 0) + 1;
    L.lift = 0;
    L.pen.style.display = 'none';
    L.type.style.display = 'none';
    L.pos = null;
    wipeTrail(L);
  };

  /* Cuts a line of handwriting (a span holding one text node) into one piece per line it takes: each a
     .lagrange-pen-seg of its own, so that each line is uncovered by itself (see the styles: a piece's box reaches
     past its line for the tails and loops of its letters, and nothing of another line shows through it). The white
     space between two pieces stays outside them, where a line may still break. -> the pieces, in order. */
  const cutLines = (doc, el, lineHeight) => {
    const node = el.firstChild;
    if (!node || node.nodeType !== 3 || el.childNodes.length !== 1) return [];
    const text = node.data, range = doc.createRange(), tops = [];
    for (let i = 0; i < text.length; i++) {
      range.setStart(node, i);
      range.setEnd(node, i + 1);
      const rects = range.getClientRects(), r = rects.length ? rects[rects.length - 1] : null;
      tops.push(r && r.width > 0.01 && /\S/.test(text[i]) ? (r.top + r.bottom) / 2 : null);
    }
    const starts = lineStarts(tops, lineHeight * 0.5);
    const segs = [];
    el.textContent = '';
    starts.forEach((s, n) => {
      const chunk = text.slice(s, n + 1 < starts.length ? starts[n + 1] : text.length);
      const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(chunk);
      if (m[1]) el.appendChild(doc.createTextNode(m[1]));
      if (m[2]) {
        const seg = doc.createElement('span');
        seg.className = 'lagrange-pen-seg';
        seg.textContent = m[2];
        el.appendChild(seg);
        segs.push(seg);
      }
      if (m[3]) el.appendChild(doc.createTextNode(m[3]));
    });
    return segs;
  };

  return {
    extension,
    pens: PEN_MAX,
    /* Writes one edit. Resolves to undefined, or to {skipped: why} if the edit was not made: the writer changed the
       words it was to replace while the pen was on its way (the change is then not dispatched at all). */
    async edit(view, from, to, replacement, run, how) {
      if (destroyed) throw new Error('The pen was put away.');
      const doc = view.dom.ownerDocument, win = doc.defaultView || window;
      const still = prefersReducedMotion(win);
      const speed = Number(settings && settings.penSpeed) > 0 ? Number(settings.penSpeed) : 1;
      const k = 1 / speed;
      const text = String(replacement == null ? '' : replacement);
      const h = how || {};
      const tally = h.tally || run;                     // whose time this edit's handwriting counts against (penLines)
      // The pen that writes it: the one asked for or, if that one is at another edit of this note, one that is free.
      const busy = new Set(Array.from(current).filter(c => c.view === view).map(c => c.slot));
      let slot = Number.isInteger(h.slot) && h.slot >= 0 && h.slot < PEN_MAX ? h.slot : 0;
      if (busy.has(slot)) { const free = SLOTS.find(i => !busy.has(i)); if (free !== undefined) slot = free; }
      install(view);
      const at = track(view, from, to);                 // where the edit is, kept up while the note changes elsewhere
      const own = [penWrite.of(true), penOwner.of(at)];
      if (run) own.push(Transaction.addToHistory.of(false));   // a run makes its own undo step
      const ink = [];                                   // the strokes that strike the old words out
      const claimed = new Set();                        // the note's own equations the pen has taken to draw
      const ctx = context();
      let hand = null, cleared = false, S = null, L = null, skipped = null;
      let inkG = null;                                  // the strokes' group, moved with the words they strike
      let keep = null;                                  // how what is drawn stays on its text: {read(), write()}, see keepUp
      const live = { read() { if (keep) keep.read(); }, write() { if (keep) keep.write(); } };
      const marks = deco => setGone.of({ slot, deco });
      const commit = spec => {
        if (at.committed || skipped) return;
        if (at.dirty) { skipped = 'you changed this text while the pen was on its way'; return; }
        at.committed = true;
        at.start = at.from + inkOffset(text);
        at.end = at.from + text.length;
        const tr = Object.assign({ changes: { from: at.from, to: at.to, insert: text }, annotations: own }, spec);
        // The writer's selection stays where it is, unless it is on the words being replaced: then the cursor goes
        // just before the new text (in Live Preview, text the cursor is in shows its Markdown).
        const sel = view.state.selection.main;
        if (!tr.selection && sel.to >= at.from && sel.from <= at.to && (sel.from !== sel.to || at.to > at.from)) tr.selection = { anchor: at.from };
        at.to = at.end;
        view.dispatch(tr);
        // The change has moved what stands below it: what the other pens have drawn there goes with it at once.
        if (S && !ctx.stopped) keepUp(S);
      };
      /* Everything the edit put on the page comes off; at once when the edit is ended early, else with a short fade. */
      const clear = instant => {
        if (cleared) return;
        cleared = true;
        keep = null;
        if (S) S.live.delete(live);
        tracked.delete(at);
        for (const el of claimed) { taken.delete(el); el.style.opacity = ''; el.style.clipPath = ''; el.classList.remove('lagrange-pen-drawing'); for (const g of mathGlyphs(el)) { g.style.opacity = ''; g.style.clipPath = ''; for (const p of ['fillOpacity', 'stroke', 'strokeWidth', 'strokeDasharray', 'strokeDashoffset']) g.style[p] = ''; } }
        const fade = Math.round(300 * k), gone = hand, strokes = ink.splice(0), group = inkG;
        inkG = null;
        if (instant) {
          for (const n of strokes) n.remove();
          if (group) group.remove();
          if (gone) gone.remove();
        } else {
          for (const n of strokes) { n.style.transition = `opacity ${fade}ms ease`; n.style.opacity = '0'; }
          if (gone) { gone.style.transition = `opacity ${fade}ms ease`; gone.style.opacity = '0'; }
          win.setTimeout(() => { for (const n of strokes) n.remove(); if (group) group.remove(); if (gone) gone.remove(); }, fade + 40);
        }
        // The text is in full view by now (or the pen was put away): this pen's marks on it come off.
        try { if (view.state.field(goneField, false) !== undefined) view.dispatch({ effects: marks(null) }); } catch (e) { /* the view is gone */ }
        view.dom.classList.remove(`lagrange-pen-revealing-${slot}`);
        if (!/lagrange-pen-revealing-\d/.test(view.dom.className)) view.dom.style.removeProperty('--lagrange-pen-reveal');
        if (L) {
          L.type.style.display = 'none';
          if (instant) putAway(L); else if (L.pos) { L.pen.style.display = ''; park(L, view, h.leave ? 160 : undefined); }
        }
      };
      const me = { ctx, view, slot, finish() { ctx.stop(); commit({}); clear(true); } };
      current.add(me);
      try {
        // The edit is brought on screen if it is not comfortably there already; a writer who has it in view is not
        // moved. (One of several edits written at once is in view: runEdits has seen to that, see penWave.)
        const near = () => {
          const c = view.coordsAtPos(at.from, 1), s = view.scrollDOM.getBoundingClientRect();
          if (!c || c.top < s.top + s.height * 0.12 || c.bottom > s.top + s.height * 0.72) return false;
          // … and has room under it for what the pen will write there: a code block or a displayed equation put in
          // low on the screen would be typed, or drawn, below its edge (penRoom)
          const box = view.contentDOM.getBoundingClientRect(), size = parseFloat(win.getComputedStyle(view.contentDOM).fontSize) || 16;
          const line = view.defaultLineHeight > 0 ? view.defaultLineHeight : c.bottom - c.top;
          return c.top + penRoom(text, settings && settings.penLines, box.width, size) * line <= s.bottom;
        };
        if (!h.stay && !near()) view.dispatch({ effects: EditorView.scrollIntoView(at.from, { y: 'center' }) });
        S = layerFor(view);
        S.fit();
        L = penOn(S, slot);
        L.ctx = ctx;
        S.live.add(live);
        // One of several pens sets out a little after the one before it, so that they do not move in step.
        if (h.delay > 0 && !still) await pause(L, h.delay * k);
        // Wait for the text to stop moving (Typewriter Mode and smooth scrolling keep it moving for a few frames).
        let rects = [], prev = null, steady = 0;
        for (let i = 0; i < 90 && steady < 4; i++) {
          await frame(L);
          rects = rangeRects(view, at.from, Math.max(at.from, at.to));
          const top = rects.length ? rects[0].top : null;
          steady = prev !== null && top !== null && Math.abs(top - prev) < 0.5 ? steady + 1 : 0;
          prev = top;
        }
        if (still || !rects.length) {
          if (at.to > at.from && !at.dirty) {
            view.dispatch({ effects: marks(Decoration.set([goneMark.range(at.from, at.to)])) });
            await pause(L, 220 * k);
          }
          commit({ effects: marks(null) });
          return skipped ? { skipped } : undefined;
        }
        win.clearTimeout(L.idle);
        L.busy = (L.busy || 0) + 1;
        L.lift = 0;
        {
          const o = org(L);
          rects = rects.map(r => rel(L, r, o));
          const vr = rel(L, view.scrollDOM.getBoundingClientRect(), o);
          if (!L.pos) { const door = doorIn(L, vr, rects[0].top); place(L, door.x, door.y); L.came = true; }
        }
        L.pen.style.display = '';
        const r0 = rects[0];
        const mid = r => r.top + r.height * 0.58;
        // Until the handwriting is laid, what the pen draws is drawn where the old words stood when they were measured
        // (rects) and carried to where they stand now (spot: how far they have moved since): another pen's edit
        // higher up may push them down at any moment.
        const spot = { x: 0, y: 0, base: null, next: null };
        const where = () => {
          const c = view.coordsAtPos(at.from, 1) || view.coordsAtPos(at.from, -1);
          if (!c) return null;
          const o = org(L);
          return { x: c.left - o.x, y: c.top - o.y };
        };
        spot.base = where();
        inkG = mk(doc, 'g', { class: 'lagrange-pen-strike' }, L.marks);
        keep = {
          read() { const p = spot.base ? where() : null; spot.next = p ? { x: p.x - spot.base.x, y: p.y - spot.base.y } : null; },
          write() {
            const n = spot.next;
            if (!n || (Math.abs(n.x - spot.x) < 0.05 && Math.abs(n.y - spot.y) < 0.05)) return;
            const dx = n.x - spot.x, dy = n.y - spot.y;
            spot.x = n.x; spot.y = n.y;
            if (inkG) inkG.setAttribute('transform', `translate(${spot.x.toFixed(2)} ${spot.y.toFixed(2)})`);
            nudge(L, dx, dy);
          },
        };
        const on = (x, y) => () => ({ x: x + spot.x, y: y + spot.y });
        const flyOff = async () => {
          const vr = rel(L, view.scrollDOM.getBoundingClientRect());
          await fly(L, Math.min(vr.right - 12, L.pos.x + 30), L.pos.y - 18, 280 * k, 10);
        };
        {
          const flat = L.came && L.slot > 0;            // one of several, coming in: along its own line
          L.came = false;
          await flyTo(L, on(r0.left - 2, mid(r0)), 650 * k, 14, flat ? DOOR_RISE : 1);
        }
        if (at.to > at.from && !at.dirty) {
          ink.push(mk(doc, 'circle', { cx: r0.left - 2, cy: mid(r0), r: 1.6, fill: 'var(--lg-rubric)', opacity: 0.8 }, inkG));
          view.dispatch({ effects: marks(Decoration.set([goneMark.range(at.from, at.to)])) });
          for (let i = 0; i < rects.length; i++) {
            const r = rects[i], y0 = mid(r), x0 = r.left - 2, x1 = r.right + 2;
            const p = mk(doc, 'path', {
              d: `M${x0} ${y0} C ${x0 + (x1 - x0) * 0.3} ${y0 - 1.6}, ${x0 + (x1 - x0) * 0.7} ${y0 + 1.6}, ${x1} ${y0 - 0.6}`,
              fill: 'none', stroke: 'var(--lg-rubric)', 'stroke-width': 1.7, 'stroke-linecap': 'round',
            }, inkG);
            ink.push(p);
            const len = p.getTotalLength();
            p.style.strokeDasharray = String(len);
            p.style.strokeDashoffset = String(len);
            if (i) await flyTo(L, on(x0, y0), 240 * k, 6);
            await tween(L, Math.min(len * 3.2, 900) * k, t => {
              p.style.strokeDashoffset = (len * (1 - t)).toFixed(1);
              const q = p.getPointAtLength(len * t);
              place(L, q.x + spot.x, q.y + spot.y);
            });
          }
          if (text) await pause(L, 200 * k);            // the struck words are seen struck, before they go
        }
        const lead = inkOffset(text);
        if (lead >= text.length || at.dirty) {
          if (!text && at.to > at.from && !at.dirty) await pause(L, 260 * k);
          commit({ effects: marks(null) });
        } else {
          // The new text goes into the note now, unseen, so that everything after it is where it will stay and the
          // pen can write where the text stands. Its equations: MathJax is loaded first, so Live Preview typesets them
          // at once, and the cursor is kept out of one that opens the text (Live Preview shows the source of an
          // equation the cursor touches).
          const live = Boolean(view.dom.closest('.is-live-preview'));
          const maths = mathSegments(text).filter(g => g.type === 'math');
          const mj = maths.length ? await mathReady(L) : null;
          const before = live && maths.length ? new Set(view.contentDOM.querySelectorAll('mjx-container')) : null;
          if (!at.dirty) {
            const old = view.state.doc;
            const startsLine = at.from === 0 || old.sliceString(at.from - 1, at.from) === '\n';
            const endsLine = at.to === old.length || old.sliceString(at.to, at.to + 1) === '\n';
            const spec = { effects: marks(unwritten(slot, at.from, text, lead, startsLine, endsLine)) };
            const sel = view.state.selection.main;
            if (before && at.from > 0 && /^(?:\$|\\\(|\\\[|\\begin\{)/.test(text) && sel.to >= at.from && sel.from <= at.to) spec.selection = { anchor: at.from - 1 };
            commit(spec);
          } else commit({});
          if (skipped) return { skipped };
          const fadeInk = Math.round(160 * k);
          for (const n of ink) { n.style.transition = `opacity ${fadeInk}ms ease`; n.style.opacity = '0'; }
          { const old = ink.splice(0); win.setTimeout(() => { for (const n of old) n.remove(); }, fadeInk + 40); }
          let targets = before ? newEquations(view, before, maths, claimed, at) : [];
          let first = await settled(L, view, () => at.start);
          if (before) targets = targets.concat(newEquations(view, before, maths, claimed, at));
          const inNote = targets.map(t => bare(t.source));
          if (before && targets.length < maths.length) {
            console.debug(`Lagrange: ${maths.length - targets.length} of ${maths.length} equation(s) in this edit are not typeset in the note here (off screen, the cursor is in one, or Obsidian does not read their delimiters), so the pen draws them in its script.`);
          }
          // The pen's script: the words (and code), and the equations the note does not typeset itself.
          const lines = rangeRects(view, at.start, at.end);
          const col = columnAt(L, view, at.start);
          const mayWrite = penLines(settings && settings.penLines, lines.length, tally && tally.spent, speed);
          // Text the note centres or sets to the right is written line for line as the note sets it (noteRows).
          let rows = first && (col.align || text.split('\n').some(l => ALIGN_MARK.test(l))) ? noteRows(L, view, at.start, at.end, col.lineHeight) : [];
          if (!rows.some(r => r.align)) rows = [];
          const byRow = () => {
            const out = [];
            rows.slice(0, mayWrite).forEach((r, i) => {
              out.push({ type: 'row', row: r, gap: i ? Math.max(1, Math.round((r.top - rows[i - 1].top) / col.lineHeight)) : 0 });
              for (const g of penScript(r.text, 150, live)) out.push(g);
            });
            if (rows.length > mayWrite || rows.more) out.push({ type: 'text', text: ' …' });
            return out;
          };
          const script = (!first ? [] : rows.length ? byRow() : penScript(text, Math.min(520, 150 * mayWrite), live)).filter(g => {
            if (g.type !== 'math') return true;
            const i = inNote.indexOf(bare(g.source));
            if (i < 0) return true;
            inNote[i] = null;
            return false;
          });
          const pieces = [], leads = [];
          if (script.length) {
            hand = doc.createElement('div');
            hand.className = 'lagrange-pen-hand';
            hand.appendChild(doc.createElement('span')).className = 'lagrange-pen-base';   // sits on the first line's baseline
            for (const g of script) {
              if (g.type === 'row') {
                // a new line of the note: after the first, a line break and the room up to where the note starts the line
                for (let n = 0; n < g.gap; n++) hand.appendChild(doc.createElement('br'));
                if (g.gap) {
                  const lead = hand.appendChild(doc.createElement('span'));
                  lead.className = 'lagrange-pen-lead';
                  leads.push({ el: lead, row: g.row });
                }
                continue;
              }
              const span = doc.createElement('span');
              if (rows.length) span.dataset.row = String(leads.length);
              if (g.type === 'code') {
                // typed text, a marker where the next letter lands, and the text still to come (it holds the slip's shape)
                span.className = `lagrange-pen-code${g.block ? ' is-block' : ''}`;
                span.appendChild(doc.createElement('span'));
                span.appendChild(doc.createElement('span')).className = 'lagrange-pen-code-mark';
                span.appendChild(doc.createElement('span')).className = 'lagrange-pen-code-rest';
                span.lastChild.textContent = g.text;
                hand.appendChild(span);
                pieces.push({ el: span, code: true, text: g.text });
                continue;
              }
              if (g.type !== 'math') {
                span.className = 'lagrange-pen-words';
                span.textContent = g.text;
                hand.appendChild(span);
                pieces.push({ el: span, math: false, prose: true });
                continue;
              }
              // An equation: drawn as MathJax typesets it or, failing that, written as its source (equationPlan).
              const m = mj && mj.renderer && mj.loaded && !mj.error ? renderPenMath(g.source, g.display, obsidian.renderMath) : null;
              const plan = equationPlan(Object.assign({}, mj, {
                typeset: Boolean(m), failed: Boolean(m && m.querySelector('mjx-merror, [data-mjx-error]')), symbols: m ? mathGlyphs(m).length : 0,
              }));
              if (plan.how === 'draw') { span.className = 'lagrange-pen-math'; span.appendChild(m); }
              else {
                console.debug(`Lagrange: an equation was written as text, not drawn: ${plan.why}.`, mathSource(g));
                span.className = 'lagrange-pen-words';
                span.textContent = mathSource(g);
              }
              hand.appendChild(span);
              pieces.push({ el: span, math: plan.how === 'draw', prose: plan.how !== 'draw' });
            }
            // Laid over the text column: the first line starts where the text's first letter is, the others at the
            // column's left edge, on the note's lines. Where the note centres the text or sets it to the right, each
            // line of the handwriting is one of the note's lines and starts where the note starts that line.
            let fs = col.fontSize * 1.3;
            const lay = () => {
              hand.style.fontSize = `${fs.toFixed(1)}px`;
              hand.style.lineHeight = `${col.lineHeight.toFixed(2)}px`;
              hand.style.left = `${col.left.toFixed(2)}px`;
              hand.style.width = `${(col.right - col.left).toFixed(2)}px`;
              // Beside a drop cap the lines begin after it: a float of the initial's width and depth holds its place
              // (from the second line on, where the text written is the initial's own paragraph from its first letter:
              // the float's shape leaves the first line free).
              const cap = rows.length ? null : besideInitial(L, view, at.start, first);
              const beside = cap ? Math.max(0, cap.right - col.left) : 0, under = cap && cap.own ? col.lineHeight * 1.4 : 0;   // (well into the second line: the first is a little deeper than a line where a tall letter stands on it)
              hand.classList.toggle('is-beside-initial', beside > 0);
              hand.style.setProperty('--lagrange-pen-beside', `${beside.toFixed(2)}px`);
              hand.style.setProperty('--lagrange-pen-beside-from', `${under.toFixed(2)}px`);
              hand.style.setProperty('--lagrange-pen-beside-deep', '1px');
              hand.style.textIndent = `${Math.max(0, first.x - col.left - (under ? 0 : beside)).toFixed(2)}px`;
              hand.style.whiteSpace = rows.length ? 'nowrap' : '';
              for (const lead of leads) {
                const now = charBox(L, view, at.start + lead.row.off);
                if (now) lead.row.x = now.x;
                lead.el.style.width = `${Math.max(0, lead.row.x - col.left).toFixed(2)}px`;
              }
              hand.style.top = '0px';
              const base = hand.firstChild.getBoundingClientRect().bottom - hand.getBoundingClientRect().top;
              hand.style.top = `${(first.baseline - base).toFixed(2)}px`;
              if (beside) hand.style.setProperty('--lagrange-pen-beside-deep', `${Math.max(1, cap.bottom - (first.baseline - base)).toFixed(2)}px`);
            };
            L.sheet.appendChild(hand);
            lay();
            // The handwriting's font is in the styles but is loaded at its first use: the hand is measured once it is
            // there (measured in a stand-in font, its lines would break elsewhere when the font arrived).
            if (doc.fonts && typeof doc.fonts.load === 'function') {
              const font = `${fs.toFixed(1)}px ${win.getComputedStyle(hand).fontFamily}`;
              let ready = true;
              try { ready = doc.fonts.check(font); } catch (e) { ready = true; }
              if (!ready) {
                await L.ctx.wait(done => {
                  const id = win.setTimeout(done, 1200);
                  doc.fonts.load(font).then(() => done(), () => done());
                  return () => win.clearTimeout(id);
                });
                first = charBox(L, view, at.start) || first;
                lay();
              }
            }
            if (pieces.some(q => q.math)) {
              // MathJax adds the styles for the symbols it used; wait for them, and for the fonts, before measuring.
              try { if (typeof obsidian.finishRenderMath === 'function') await Promise.race([obsidian.finishRenderMath(), sleep(1200)]); } catch (e) { /* drawn as it is */ }
              try { if (doc.fonts && doc.fonts.ready) await Promise.race([doc.fonts.ready, sleep(900)]); } catch (e) { /* drawn as it is */ }
              if (ctx.stopped) throw STOP;
              await frame(L);
              first = charBox(L, view, at.start) || first;
              lay();
            }
            // No more lines than it may write, and on the line where the new text ends no further than the text itself
            // goes when the note's own words follow it there (the hand is larger than the type, and would be written
            // over them): first a smaller hand, then fewer words, ending in an ellipsis. A hand of fewer lines than
            // the text ends on a line that the new text fills, and text that ends its paragraph has the rest of the
            // line to itself.
            const last = lines[lines.length - 1];
            const followed = at.end < view.state.doc.length && view.state.doc.sliceString(at.end, at.end + 1) !== '\n';
            const tall = () => Math.round(hand.getBoundingClientRect().height / col.lineHeight);
            const overruns = () => {
              if (!last) return false;
              if (lines.length !== 1 && (!followed || tall() < lines.length)) return false;
              const tail = pieces.length ? pieces[pieces.length - 1].el.getClientRects() : [];
              const o = org(L);
              return Boolean(tail.length) && tail[tail.length - 1].right - o.x > Math.max(last.right - o.x, lines.length === 1 ? first.x + 24 : 0) + 6;
            };
            const fits = () => tall() <= mayWrite && !overruns();
            // In a narrow column the first word may not fit in what is left of the first line, and would drop to the
            // next: the hand is made smaller (down to about the note's own size) until it starts where the text does.
            const dropped = () => {
              const el = pieces[0] && pieces[0].el, node = el && pieces[0].prose ? el.firstChild : null;
              const top = () => {
                if (node && node.nodeType === 3 && node.length) {
                  const r = doc.createRange(), i = Math.max(0, node.data.search(/\S/));
                  r.setStart(node, i);
                  r.setEnd(node, Math.min(node.length, i + 1));
                  const q = r.getClientRects()[0];
                  if (q) return q.top;
                }
                return el ? el.getBoundingClientRect().top : 0;
              };
              const now = top();
              hand.style.whiteSpace = 'nowrap';              // where it would stand on the first line
              const want = top();
              hand.style.whiteSpace = '';
              return now - want > col.lineHeight * 0.5;
            };
            // The note's own lines: the hand is made smaller until its lines are no wider than the note's (so that a
            // centred line stays centred), though no smaller than the note's type for that; and smaller still, if it
            // must be, to end inside the column (a line set to the right ends at the margin).
            if (rows.length) {
              const mine = new Map();
              for (const q of pieces) for (const r of q.el.getClientRects()) mine.set(q.el.dataset.row, (mine.get(q.el.dataset.row) || 0) + r.width);
              let fit = 0, edge = 0;
              rows.slice(0, mayWrite).forEach((r, i) => {
                const w = mine.get(String(i)) || 0;
                if (r.width > 24) fit = Math.max(fit, w / r.width);
                edge = Math.max(edge, w / Math.max(24, col.right - r.x));
              });
              let size = fit > 1 ? Math.max(fs / fit, Math.min(fs, col.fontSize)) : fs;
              if (edge * size / fs > 1) size = Math.max(col.fontSize * 0.8, fs / edge);
              if (size !== fs) { fs = size; lay(); }
            }
            for (let i = 0; i < 6 && !rows.length && dropped(); i++) { fs *= 0.94; lay(); }
            for (let i = 0; i < 4 && !rows.length && (lines.length === 1 ? !fits() : tall() <= mayWrite && overruns()); i++) { fs *= 0.94; lay(); }
            for (let i = 0; i < 80 && !rows.length && pieces.length && !fits(); i++) {
              const q = pieces[pieces.length - 1];
              if (!q.prose) {
                if (pieces.length === 1 || q.code) break;      // an equation or code alone is never left out
                q.el.remove(); pieces.pop(); continue;
              }
              const words = q.el.textContent.replace(/\s*…\s*$/, '').trimEnd();
              const cut = words.slice(0, Math.max(0, Math.min(words.length - 1, Math.floor(words.length * 0.9)))).replace(/\s*\S*$/, '');
              if (!cut.trim()) {
                if (pieces.length === 1) { q.el.textContent = words.slice(0, Math.max(1, Math.floor(words.length * 0.8))); if (words.length <= 2) break; continue; }
                q.el.remove(); pieces.pop();
                const p = pieces[pieces.length - 1];
                if (p && p.prose && !/…\s*$/.test(p.el.textContent)) p.el.textContent = p.el.textContent.trimEnd() + ' …';
                continue;
              }
              q.el.textContent = cut + ' …';
            }
            // Each line of words becomes a piece of its own, uncovered by itself (cutLines).
            for (const q of pieces) if (q.prose) q.segs = cutLines(doc, q.el, col.lineHeight);
            // While it is written the hand stays on the text, wherever the note reflows to (scrolling moves the sheet,
            // and the hand with it): looked at once a frame, and at once after another pen's change (keepUp).
            const follow = {
              next: null,
              read() {
                follow.next = null;
                if (destroyed || !hand.isConnected) return;
                const now = charBox(L, view, at.start), c = now ? columnAt(L, view, at.start) : null;
                if (now && (Math.abs(now.x - first.x) > 0.4 || Math.abs(now.baseline - first.baseline) > 0.4 || Math.abs(c.left - col.left) > 0.4 || Math.abs(c.right - col.right) > 0.4)) follow.next = { now, c };
              },
              write() {
                const n = follow.next;
                if (!n) return;
                follow.next = null;
                const dx = n.now.x - first.x, dy = n.now.baseline - first.baseline;
                first = n.now; col.left = n.c.left; col.right = n.c.right;
                lay();
                nudge(L, dx, dy);
              },
            };
            keep = follow;
            const widthOf = q => Array.from(q.el.getClientRects()).reduce((a, r) => a + r.width, 0);
            const pace = penPace(pieces.filter(q => q.prose).reduce((a, q) => a + widthOf(q), 0));
            const t0 = win.performance.now();
            for (const piece of pieces) {
              if (piece.code) {
                piece.el.classList.add('is-on');             // the slip is laid down empty; its letters are typed
                await typeCode(L, piece, k);
                continue;
              }
              if (piece.math) {
                const glyphs = mathGlyphs(piece.el);
                if (glyphs.length && glyphs.length <= 90) {
                  for (const g of glyphs) g.style.opacity = '0';
                  piece.el.classList.add('is-on');
                  const each = Math.min(170, 3600 / glyphs.length) * k;
                  for (const g of glyphs) await drawGlyph(L, g, each, () => {});
                } else {
                  const pr = rel(L, piece.el.getBoundingClientRect());
                  piece.el.style.clipPath = 'inset(-0.6em 100% -0.6em -0.2em)';
                  piece.el.classList.add('is-on');
                  await fly(L, pr.left, pr.top + pr.height * 0.7, 280 * k, 6);
                  await tween(L, Math.min(2400, pr.width * 9) * k, t => {
                    const r = rel(L, piece.el.getBoundingClientRect());
                    piece.el.style.clipPath = `inset(-0.6em ${(r.width * (1 - t)).toFixed(1)}px -0.6em -0.2em)`;
                    place(L, r.left + r.width * t, r.top + r.height * 0.7 + Math.sin(r.width * t * 0.55) * 3.2 - 2);
                  });
                  piece.el.style.clipPath = '';
                }
                continue;
              }
              // words: along each line they take, the nib a little above the baseline and never still. The ink shows
              // up to the nib, through a soft edge (the styles: --lagrange-pen-x), and only on the line being written.
              for (const seg of piece.segs || []) {
                const cs = win.getComputedStyle(seg), padX = parseFloat(cs.paddingLeft) || 0, padY = parseFloat(cs.paddingTop) || 0;
                const inner = () => {
                  const r = rel(L, seg.getBoundingClientRect());
                  return { left: r.left + padX, top: r.top + padY, width: Math.max(0, r.width - 2 * padX), height: Math.max(0, r.height - 2 * padY) };
                };
                const a = inner();
                if (a.width < 0.5) { seg.classList.add('is-written'); continue; }
                const y0 = a.top + a.height * 0.72;
                if (Math.hypot(a.left - L.pos.x, y0 - L.pos.y) > 4) await fly(L, a.left, y0, 260 * k, 6);
                seg.style.setProperty('--lagrange-pen-x', '0px');
                seg.classList.add('is-writing');
                await tween(L, Math.max(60, a.width * pace) * k, t => {
                  const r = inner(), x = r.width * t;
                  seg.style.setProperty('--lagrange-pen-x', `${(padX + x + 2).toFixed(1)}px`);
                  place(L, r.left + x, r.top + r.height * 0.72 + Math.sin(x * 0.55) * 3.2 - 2);
                });
                seg.classList.remove('is-writing');
                seg.classList.add('is-written');
                seg.style.removeProperty('--lagrange-pen-x');
              }
            }
            hand.classList.add('is-done');
            if (tally) tally.spent = (tally.spent || 0) + (win.performance.now() - t0);
            await flyOff();
            await pause(L, 380 * k);
          }
          // The handwriting gives way to the text, which is already where it belongs.
          const fade = Math.round(300 * k);
          view.dom.style.setProperty('--lagrange-pen-reveal', `${fade}ms`);
          view.dom.classList.add(`lagrange-pen-revealing-${slot}`);
          if (hand) { hand.style.transition = `opacity ${fade}ms ease`; hand.style.opacity = '0'; }
          if (targets.length) {
            await pause(L, fade * 0.6);
            // Then the equations, each where the note has it.
            for (const t of targets.slice(0, SCRIPT_EQUATIONS)) await drawInPlace(L, t.el, k);
            await flyOff();
            await pause(L, 380 * k);                      // the finished equation is looked at for a moment
          } else if (!hand) {
            await pause(L, 120 * k);
          } else {
            await pause(L, fade);
          }
        }
      } catch (e) {
        if (e !== STOP) throw e;                          // ended early: what is left is done in `finally`
      } finally {
        current.delete(me);
        if (L && L.ctx === ctx) L.ctx = null;
        ctx.stop();
        commit({});
        clear(false);
      }
      return skipped ? { skipped } : undefined;
    },
    /* Ends every edit being written, at once and before it returns: their changes are made in the note if they had
       not been yet, the handwriting, the ink and the pens go, and the marks on the note come off. Returns whether
       there was an edit to end. (The promises edit() gave resolve a moment later.) */
    finish() {
      const all = Array.from(current);
      for (const me of all) { try { me.finish(); } catch (e) { console.error('Lagrange: the pen', e); } }
      // a pen that was hovering between two edits, or leaving, goes at once too
      for (const S of layers.values()) for (const L of S.pens) if (L) putAway(L);
      return all.length > 0;
    },
    destroy() {
      destroyed = true;
      for (const me of Array.from(current)) { try { me.finish(); } catch (e) { /* the view is gone */ } }
      current.clear();
      for (const view of views) {
        try { if (view.state.field(goneField, false) !== undefined) view.dispatch({ effects: setGone.of(null) }); } catch (e) { /* view gone */ }
      }
      views.clear();
      tracked.clear();
      taken.clear();
      for (const S of layers.values()) {
        for (const L of S.pens) { try { if (L) S.win.clearTimeout(L.idle); } catch (e) { /* window closed */ } }
        try { if (S.raf) S.win.cancelAnimationFrame(S.raf); } catch (e) { /* window closed */ }
        try { if (S.observer) S.observer.disconnect(); } catch (e) { /* gone */ }
        S.calls.clear();
        S.live.clear();
        S.sheet.remove();
      }
      layers.clear();
    },
  };
}
// ==== END LAGRANGE PEN ====


/* ---------------------------------------------------------------------------------------------------------------
 * 6. Edit runs
 *
 * A run applies one request's edits to an editor. With the pen, each edit is written in turn, or, where several of
 * them stand well apart on the page, at the same time by a pen each (penWave); Lagrange's changes stay out of the
 * undo history, and at the end they are taken back and made again in one transaction, which becomes a single undo
 * step. The editor is not locked meanwhile: a click or an editing key in the note ends the run at once (every pen
 * stops, and the edits still to come are all made), or, with "Let me edit while the pen writes", the writer's
 * changes go in alongside the pens'. The view the writer watched is the view they are left with. Without the pen,
 * all edits go in one transaction straight away.
 * ------------------------------------------------------------------------------------------------------------- */

const EDIT_RECORDS = 30;   // how many runs of edits Undo and Redo remember

/* The run of edits going on in each editor, and the extension that keeps its account. The editor stays editable
   while the pen writes (a writer who clicks or types ends the run, or, with settings.editWhileWriting, writes
   alongside the pen); the listener notes every change: run.composed is all of them since the run began, and run.undo
   is the change that takes Lagrange's own out of the note as it now is, leaving what the writer has typed meanwhile.
   The plugin registers the extension in every editor once (runExtension); a run never reconfigures the editor, which
   other plugins take as a reason to scroll back to the cursor (Typewriter Mode does). */
const activeRuns = new WeakMap();   // EditorView -> run
const runMarker = StateField.define({ create: () => true, update: v => v });
let runExt = null;
const runExtension = () => runExt || (runExt = [
  runMarker,
  EditorView.updateListener.of(update => {
    const run = activeRuns.get(update.view);
    if (!run || run.closed) return;
    for (const tr of update.transactions) {
      if (!tr.docChanged) continue;
      run.composed = run.composed.compose(tr.changes);
      if (run.tap) run.tap = run.tap.compose(tr.changes);
      if (tr.annotation(penWrite)) run.undo = tr.changes.invert(tr.startState.doc).compose(run.undo);
      else {
        run.undo = run.undo.map(tr.changes);
        // (a change that leaves the text as it was is nobody's typing: Obsidian makes one, replacing the first
        // character by itself, to have a note highlighted afresh when a language or MathJax has loaded)
        if (tr.startState.doc.eq(tr.state.doc)) continue;
        run.touched = true;
        if (run.onUserChange) run.onUserChange();
      }
    }
  }),
]);
function watchRun(view, run) {
  // (an editor the plugin did not set up: the extension is added now, once)
  if (view.state.field(runMarker, false) === undefined) view.dispatch({ effects: StateEffect.appendConfig.of(runExtension()) });
  activeRuns.set(view, run);
}

/* A place in the note and where it stands in the window, so that it can be put back there after the note changes or
   something scrolls it: {pos, top}, or null. The place is `prefer` (a position in the note) if that is on screen,
   else the text at height y of the window (by default, a little above the middle of the editor).
   keepInPlace(view, anchor, pos) scrolls the editor so that the character at pos is where the anchor was. */
function scrollAnchor(view, y, prefer) {
  try {
    const s = view.scrollDOM.getBoundingClientRect(), c = view.contentDOM.getBoundingClientRect();
    // (only a place in a line of text will do: inside a block the editor draws as one piece, a callout or a table,
    // a position has no steady place on the screen)
    const inText = pos => { const at = view.domAtPos(pos), el = at.node.nodeType === 1 ? at.node : at.node.parentElement; return Boolean(el && el.closest('.cm-line')); };
    if (prefer != null && inText(prefer)) {
      const p = view.coordsAtPos(prefer, 1) || view.coordsAtPos(prefer, -1);
      if (p && p.top >= s.top && p.bottom <= s.bottom) return { pos: prefer, top: p.top };
    }
    for (const yy of y == null ? [0.4, 0.3, 0.5, 0.2, 0.6, 0.75, 0.1].map(f => s.top + s.height * f) : [y, y - 24, y + 24]) {
      const pos = view.posAtCoords({ x: c.left + 12, y: yy }, false);
      if (!inText(pos)) continue;
      const at = view.coordsAtPos(pos, 1) || view.coordsAtPos(pos, -1);
      if (at) return { pos, top: at.top };
    }
    return null;
  } catch (e) { return null; }
}
function keepInPlace(view, anchor, pos) {
  if (!anchor) return 0;
  try {
    const p = pos == null ? anchor.pos : pos;
    const at = view.coordsAtPos(p, 1) || view.coordsAtPos(p, -1);
    if (!at) return 0;
    const d = at.top - anchor.top;
    if (Math.abs(d) > 0.5) view.scrollDOM.scrollTop += d;
    return d;
  } catch (e) { return 0; }
}
/* Keeps the editor's view where it is for a few frames after a run ends (other plugins re-centre the cursor's line
   when the note changes: Typewriter Mode does), until the writer scrolls, clicks or presses a key. */
function holdView(view, anchor, frames) {
  if (!anchor) return;
  const win = view.dom.ownerDocument.defaultView || window, doc = view.dom.ownerDocument;
  let left = frames || 24, on = true;
  const off = () => { on = false; for (const t of ['wheel', 'pointerdown', 'mousedown', 'keydown', 'touchstart']) doc.removeEventListener(t, off, true); };
  for (const t of ['wheel', 'pointerdown', 'mousedown', 'keydown', 'touchstart']) doc.addEventListener(t, off, true);
  const step = () => {
    if (!on || !view.dom.isConnected) { off(); return; }
    keepInPlace(view, anchor);
    if (--left > 0) win.requestAnimationFrame(step); else off();
  };
  keepInPlace(view, anchor);
  win.requestAnimationFrame(step);
}

/* Where a run's next edits stand, for penLanes. edits: [{from, to, replace}, or null], as the note now is.
   -> {edits, page}: for each edit what penLanes asks of it, top and bottom in the window, or null for one that is
   not drawn or has no place in a line of text (it is off screen, or in a block the editor draws as one piece, a
   table or a callout); and the page: the part of the editor in view that pens may write in (all of it but a margin
   at the top and at the bottom), the height of a line and the width of the text column.
   With `guess`, nothing is measured on the screen: the edits are placed by the editor's own account of where its
   lines are (which holds, roughly, for text that is not drawn too), from the top of the note, and the page is as
   much of it as would be in view with the first edit near the top. That tells whether scrolling to them is worth it.
   Reads layout only. */
const PEN_LOOK = 12;                  // how many of a run's next edits are considered for one round of pens
const PEN_PAGE = [0.05, 0.9];         // the part of the editor's height that several pens write in
function penTargets(view, edits, guess) {
  const doc = view.state.doc, s = view.scrollDOM.getBoundingClientRect();
  const lineHeight = view.defaultLineHeight > 0 ? view.defaultLineHeight : 24;
  const box = view.contentDOM.getBoundingClientRect(), win = view.dom.ownerDocument.defaultView || window;
  const cs = win.getComputedStyle(view.contentDOM), fontSize = parseFloat(cs.fontSize) || 16;
  const width = Math.max(0, box.width - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0));
  // by how many lines an edit makes its paragraph longer: the new text against the old, both by the same guess
  const more = (e, to, indent, w, size) => Math.max(0, textLines(e.replace, indent, w, size) - textLines(doc.sliceString(e.from, to), indent, w, size));
  const out = (edits || []).map(e => {
    if (!e) return null;
    try {
      const to = Math.max(e.from, e.to), para = doc.lineAt(e.from), paraEnd = doc.lineAt(to).number;
      if (guess) {
        // the paragraph's lines as the editor counts them, and the edit's line among them by where it is in the text
        const block = view.lineBlockAt(e.from), rows = Math.max(1, Math.round(block.height / lineHeight));
        const row = Math.min(rows - 1, Math.floor(rows * (e.from - para.from) / Math.max(1, para.length)));
        const top = block.top + row * lineHeight;
        return { top, bottom: top + textLines(doc.sliceString(e.from, to), 0, width, fontSize) * lineHeight, para: para.number, paraEnd, grow: more(e, to, 0, width, fontSize) * lineHeight };
      }
      const at = view.domAtPos(e.from), el = (at.node.nodeType === 1 ? at.node : at.node.parentElement).closest('.cm-line');
      const rects = el ? rangeRects(view, e.from, to) : [];
      if (!rects.length) return null;
      const ls = win.getComputedStyle(el), lb = el.getBoundingClientRect();
      const left = lb.left + (parseFloat(ls.paddingLeft) || 0), right = lb.right - (parseFloat(ls.paddingRight) || 0);
      const lh = parseFloat(ls.lineHeight) || lineHeight;
      const grow = more(e, to, rects[0].left - left, right - left, parseFloat(ls.fontSize) || fontSize) * lh;
      return { top: rects[0].top, bottom: rects[rects.length - 1].bottom, para: para.number, paraEnd, grow };
    } catch (err) { return null; }
  });
  const span = s.height * (PEN_PAGE[1] - PEN_PAGE[0]);
  const top = guess ? (out[0] ? out[0].top - lineHeight : 0) : s.top + s.height * PEN_PAGE[0];
  return { edits: out, page: { top, bottom: top + span, lineHeight, width } };
}

/* Which of a run's next edits are written at once, each by a pen of its own (penLanes is the rule). next: the edits
   still to be made, in order and as the note now is ([{from, to, replace}, or null for one that is no longer to be
   made]); pens: how many pens may write at once; alive(): whether the run is still going.
   -> the lanes (for each pen, the edits it writes in turn: indices into next), or null when one pen is to write
   the first of them as it always has.
   Edits that are in view are taken as they stand: a writer who has them before them is not moved. If more of them
   would be on one screen together than are in view now, the note is scrolled once so that they are (as the pen
   that writes alone scrolls to each edit when it comes to it), and they are measured again when the text has come
   to rest. */
async function penWave(view, next, pens, alive) {
  if (!(pens > 1) || next.length < 2 || !next[0]) return null;
  let seen = null;
  const plan = guess => { seen = penTargets(view, next, guess); return penLanes(seen.edits, seen.page, { pens }); };
  try {
    const here = plan(false), now = seen;
    let lanes = plan(true);
    // (scrolling brings edits into view; it does not move them apart: where all of them are in view already, what
    // was measured there stands, whatever the guess says)
    const away = now.edits.slice(0, lanes.count).some(e => !e || e.top < now.page.top || e.bottom + e.grow > now.page.bottom);
    if (lanes.count <= here.count || !away) return here.count ? here.lanes : null;
    // They go to the middle of the editor, with the room they will take when they have grown; never above its top.
    const taken = seen.edits.slice(0, lanes.count), height = view.scrollDOM.getBoundingClientRect().height;
    const extent = taken[taken.length - 1].bottom + taken.reduce((a, e) => a + e.grow, 0) - taken[0].top;
    const margin = Math.max(height * PEN_PAGE[0] + seen.page.lineHeight, (height - extent) / 2);
    view.dispatch({ effects: EditorView.scrollIntoView(next[0].from, { y: 'start', yMargin: margin }) });
    // (the text moves for a few frames: smooth scrolling, Typewriter Mode, lines measured as they are first drawn)
    let prev = null, steady = 0;
    for (let i = 0; i < 90 && steady < 4; i++) {
      await nextFrame(view.dom.ownerDocument.defaultView);
      if (!alive()) return null;
      const c = view.coordsAtPos(next[0].from, 1), top = c ? c.top : null;
      steady = prev !== null && top !== null && Math.abs(top - prev) < 0.5 ? steady + 1 : 0;
      prev = top;
    }
    lanes = plan(false);
    return lanes.count ? lanes.lanes : null;
  } catch (e) {
    console.error('Lagrange: several pens could not be set to work', e);
    return null;
  }
}

/* Applies located edits ({from, to, matched, replace}, in document order, offsets in the current document) to view.
   Returns {applied, skipped, changes, docBefore, docAfter, touched, ended}: changes is a ChangeSet from docBefore to
   docAfter, the note as the run left it. With the pen, docBefore is the note without Lagrange's edits but with
   whatever the writer typed during the run (touched says whether they did), so `changes` is Lagrange's alone.

   With the pen, the edits are written one after another, in the order of the note; or, with opts.pens > 1 (the
   settings "Several pens at once" and "Pens at most") and a pen that can (pen.pens), those of them that stand well
   apart on the page are written at the same time, each by a pen of its own, and those too near another wait for the
   pen that is at it (penWave, penLanes). The note is the same in the end, and the run is one undo step either way.
   While the pen writes, or the pens:
   - by default, a click in the note, a key that would change it, a paste, a drop or an input method ends the run at
     once (ended: 'click' | 'key' | 'input' | 'edit'): every pen stops, the edits not yet written are all made, the
     run becomes its one undo step, and only then does the click or the key take effect, on the note as it now is;
   - with opts.concurrent (the setting "Let me edit while the pen writes"), the writer's changes go into the note as
     they are made and the pen goes on: each edit still to come is carried to where its words now are (remapEdit),
     and one whose words the writer has changed is skipped;
   - Escape, or opts.signal, stops the run: the edits not yet written are not made.
   opts.onDone(result), if given, is called as soon as the run's undo step is made (before a key that ended the run
   takes effect), with {changes, docBefore, docAfter}. */
async function runEdits(view, located, opts) {
  const applied = [];
  const skipped = [];
  const docBefore = view.state.doc;
  if (!opts.pen) {
    const ok = located.filter(e => view.state.sliceDoc(e.from, e.to) === e.matched);
    for (const e of located) if (!ok.includes(e)) skipped.push(Object.assign({}, e, { why: 'the text changed' }));
    if (!ok.length) return { applied, skipped, changes: ChangeSet.empty(docBefore.length), docBefore, docAfter: docBefore };
    const changes = ChangeSet.of(ok.map(e => ({ from: e.from, to: e.to, insert: e.replace })), docBefore.length);
    view.dispatch({ changes, userEvent: 'lagrange.edit', scrollIntoView: true });
    return { applied: ok, skipped, changes, docBefore, docAfter: view.state.doc };
  }

  const run = {
    composed: ChangeSet.empty(docBefore.length), undo: ChangeSet.empty(docBefore.length), tap: null,
    closed: false, cancelled: false, touched: false, ended: null, spent: 0, onUserChange: null,   // spent: see createPen
  };
  const doc = view.dom.ownerDocument, win = doc.defaultView || window;
  const outcome = new Array(located.length).fill(null);    // per edit: true (made), or why it was not
  const begun = new Array(located.length).fill(false);     // per edit: whether it has been given to a pen, or passed over
  const several = opts.pens > 1 && opts.pen.pens > 1 && !prefersReducedMotion(win) ? Math.min(opts.pens, opts.pen.pens) : 1;
  const tallies = [run];                                   // each pen's own measure of its time (see createPen: how.tally)
  const own = [penWrite.of(true), Transaction.addToHistory.of(false)];
  const here = e => remapEdit(e, (p, a) => run.composed.mapPos(p, a), (a, b) => view.state.sliceDoc(a, b));
  const changed = () => (run.touched ? 'you changed this text while the pen was writing' : 'the text changed');
  let result = null;

  /* The end of the run: Lagrange's changes are taken out (outside the history) and made again in one transaction,
     which becomes a single undo step; the selection and the scroll position are as they were. */
  const finalize = () => {
    if (run.closed) return;
    run.closed = true;
    for (const [type, fn] of listeners) doc.removeEventListener(type, fn, true);
    const undo = run.undo;
    activeRuns.delete(view);
    if (undo.empty) {
      result = { changes: ChangeSet.empty(view.state.doc.length), docBefore: view.state.doc, docAfter: view.state.doc };
    } else {
      const after = view.state.doc, selection = view.state.selection;
      const redo = undo.invert(after);
      view.dispatch({ changes: undo, annotations: own });
      const without = view.state.doc;
      view.dispatch({ changes: redo, selection, userEvent: 'lagrange.edit' });
      result = { changes: redo, docBefore: without, docAfter: view.state.doc };
    }
    if (opts.onDone) { try { opts.onDone(result); } catch (e) { console.error('Lagrange', e); } }
  };

  /* Ends the run at once, synchronously (it is called from the event that the writer's click or key press is):
     the edit being written is set down, the others are made in one change, and the run is closed. The text under
     the pointer (or, for a key, in the middle of the view) stays where it is on the screen. */
  const finishNow = (why, y) => {
    if (run.closed || run.ended) return;
    run.ended = why;
    const anchor = scrollAnchor(view, y);
    run.tap = ChangeSet.empty(view.state.doc.length);
    try {
      opts.pen.finish();
      if (!run.cancelled) {
        const changes = [];
        for (let i = 0; i < located.length; i++) {
          if (begun[i]) continue;
          const at = here(located[i]);
          if (at.skip) { outcome[i] = changed(); continue; }
          changes.push({ from: at.from, to: at.to, insert: located[i].replace });
          outcome[i] = true;
        }
        if (changes.length) view.dispatch({ changes, annotations: own });
      }
      begun.fill(true);
    } catch (e) {
      console.error('Lagrange: the run could not be finished at once', e);
    }
    const tap = run.tap;
    run.tap = null;
    finalize();
    if (anchor) keepInPlace(view, anchor, tap.mapPos(anchor.pos, 1));
  };

  const inNote = ev => Boolean(ev.target && ev.target.nodeType && view.dom.contains(ev.target));
  const onScrollbar = ev => {
    if (ev.target !== view.scrollDOM || typeof ev.clientX !== 'number') return false;
    const r = view.scrollDOM.getBoundingClientRect();
    return ev.clientX >= r.left + view.scrollDOM.clientWidth || ev.clientY >= r.top + view.scrollDOM.clientHeight;
  };
  const listeners = [
    ['keydown', ev => {
      if (ev.key === 'Escape') { run.cancelled = true; return; }
      if (!opts.concurrent && inNote(ev) && isEditKey(ev)) finishNow('key');
    }],
  ];
  if (!opts.concurrent) {
    const pointer = ev => { if (inNote(ev) && !onScrollbar(ev)) finishNow('click', typeof ev.clientY === 'number' && ev.clientY > 0 ? ev.clientY : null); };
    const input = ev => { if (inNote(ev)) finishNow('input'); };
    listeners.push(['pointerdown', pointer], ['mousedown', pointer], ['touchstart', pointer],
      ['beforeinput', input], ['paste', input], ['cut', input], ['drop', input], ['compositionstart', input]);
    // a change that came by none of those roads (a command, another plugin): the run ends right after it
    run.onUserChange = () => { Promise.resolve().then(() => finishNow('edit')); };
  }
  for (const [type, fn] of listeners) doc.addEventListener(type, fn, true);
  if (opts.signal) opts.signal.addEventListener('abort', () => { run.cancelled = true; }, { once: true });
  watchRun(view, run);
  let failure = null;
  /* One edit, written by a pen (how: see createPen; none for the pen that writes alone). */
  const write = async (i, how) => {
    const e = located[i];
    if (begun[i]) return;
    begun[i] = true;
    if (run.cancelled) { outcome[i] = 'stopped'; return; }
    const at = here(e);
    if (at.skip) { outcome[i] = changed(); return; }
    try {
      const res = await opts.pen.edit(view, at.from, at.to, e.replace, run, how);
      outcome[i] = res && res.skipped ? res.skipped : true;
    } catch (err) {
      if (!failure) failure = err;
      outcome[i] = 'the pen failed';
      try { opts.pen.finish(); } catch (e2) { /* the other pens are ended as they are */ }
    }
  };
  try {
    while (!run.closed && !failure) {
      const i = begun.indexOf(false);
      if (i < 0) break;
      // Several pens for the edits that stand apart on the page, if there are such among the next ones.
      let lanes = null, rest = null;
      if (several > 1 && !run.cancelled) {
        rest = [];
        for (let j = i; j < located.length && rest.length < PEN_LOOK; j++) if (!begun[j]) rest.push(j);
        lanes = await penWave(view, rest.map(j => { const at = here(located[j]); return at.skip ? null : { from: at.from, to: at.to, replace: located[j].replace }; }),
          several, () => !run.closed && !run.cancelled);
        if (run.closed) break;
      }
      if (!lanes) { await write(i); continue; }
      await Promise.all(lanes.map(async (lane, slot) => {
        const tally = tallies[slot] || (tallies[slot] = { spent: 0 });
        for (let n = 0; n < lane.length && !run.closed && !failure; n++) {
          await write(rest[lane[n]], { slot, tally, stay: true, delay: n ? 0 : slot * PEN_STAGGER_MS, leave: n === lane.length - 1 });
        }
      }));
    }
  } finally {
    if (!run.closed) {
      // The view the writer has watched is the view they are left with: the text last written stays where it is.
      let last = null;
      for (let i = located.length - 1; i >= 0 && last === null; i--) if (outcome[i] === true) last = run.composed.mapPos(located[i].from, 1);
      const anchor = scrollAnchor(view, null, last);
      finalize();
      holdView(view, anchor);
    }
  }
  located.forEach((e, i) => {
    if (outcome[i] === true) applied.push(e);
    else skipped.push(Object.assign({}, e, { why: outcome[i] || (failure ? 'not attempted' : 'stopped') }));
  });
  if (failure) console.error('Lagrange: the pen failed', failure);
  return Object.assign({ applied, skipped, failure, touched: run.touched, ended: run.ended }, result);
}


/* ---------------------------------------------------------------------------------------------------------------
 * 7. The page as rendered
 *
 * lookAtPage(app, view, spec, opts) -> Promise<look>
 *   view: the note's Markdown view; spec: what to look at (normalizeLook); opts: {pictures, signal}
 *   look: {spec, label, title, path, page, blocks, pictures: [{mediaType, data, width, height, top, bottom}], more,
 *          remarks, problem, description}
 * The note is set as Reading view sets it, but in a page of its own, far off the screen (renderPage): the view, the
 * editor and the workspace are not touched, and the page is thrown away when the look is over. Its blocks are
 * measured where they lie (measurePage), which is what a model without eyes is told and what one with eyes is told
 * as well. Its pictures are drawn by the browser from the page's own markup and styles (picturePage), so they need
 * nothing of Electron or Node, though they are taken on a computer only. Nothing here sends anything anywhere.
 * ------------------------------------------------------------------------------------------------------------- */

/* The width of the pane a note is shown in, which is the width its page is set to. */
function paneWidth(view) {
  const w = Math.round((view.contentEl && view.contentEl.clientWidth) || (view.containerEl && view.containerEl.clientWidth) || 0);
  return Math.max(320, Math.min(2400, w || 800));
}

/* What the writer has on screen in a note's view: in the editor, {from, to}, lines counted from 1; in Reading view,
   {texts}, the words of each block in sight, in order (Reading view keeps no line numbers a plugin may read); null
   if it cannot be told. */
function visibleLines(view) {
  const tidy = t => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  try {
    if (view.getMode() === 'source') {
      const cm = view.editor && view.editor.cm;
      if (!cm) return null;
      const box = cm.scrollDOM.getBoundingClientRect();
      if (!box.height) return null;
      const a = cm.lineBlockAtHeight(box.top - cm.documentTop), b = cm.lineBlockAtHeight(box.bottom - cm.documentTop);
      return { from: cm.state.doc.lineAt(a.from).number, to: cm.state.doc.lineAt(b.to).number };
    }
    const pane = view.containerEl.querySelector('.markdown-reading-view > .markdown-preview-view');
    const sizer = pane && pane.querySelector(':scope > .markdown-preview-sizer');
    if (!sizer) return null;
    const box = pane.getBoundingClientRect();
    const inSight = Array.from(sizer.children).filter(el => {
      if (!/(?:^|\s)el-/.test(el.className)) return false;
      const r = el.getBoundingClientRect();
      return r.height > 0 && r.bottom > box.top && r.top < box.bottom;
    });
    if (!inSight.length) return null;
    return { texts: inSight.map(el => tidy(el.textContent)) };
  } catch (e) {
    return null;
  }
}

/* The lines (counted from 1) that hold `near`, words from the note: {from, to}, or null if they are not in it. Found
   as an edit's "find" is, exactly or loosely; where they stand more than once, the first place is taken. */
function passageLines(text, near) {
  let hits = findAll(text, String(near || ''));
  if (!hits.length) hits = looseFindAll(text, String(near || ''));
  if (!hits.length) return null;
  const line = offset => text.slice(0, offset).split('\n').length;
  return { from: line(hits[0][0]), to: line(Math.max(hits[0][0], hits[0][1] - 1)) };
}

/* The line (counted from 1) of the heading that reads `heading`, or 0. */
function headingLine(text, heading) {
  const norm = t => String(t || '').replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  const want = norm(String(heading || '').replace(/^#+\s*/, ''));
  if (!want) return 0;
  const lines = String(text || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(lines[i]);
    if (m && norm(m[1]) === want) return i + 1;
  }
  return 0;
}

/* The note's sections, as Obsidian's own parser cuts them, and its front matter: {sections: [{type, from, to}] |
   null, frontmatter}. The parser is asked about the text as it stands in the editor (the saved file's metadata may
   be a moment behind); where this Obsidian has no such call, nothing is said about lines. */
async function noteSections(app, text) {
  try {
    const cache = app.metadataCache;
    if (!cache || typeof cache.computeMetadataAsync !== 'function') return { sections: null, frontmatter: null };
    const meta = await cache.computeMetadataAsync(new TextEncoder().encode(text).buffer);
    return {
      sections: ((meta && meta.sections) || []).map(s => ({ type: s.type, from: s.position.start.line, to: s.position.end.line })),
      frontmatter: (meta && meta.frontmatter) || null,
    };
  } catch (e) {
    return { sections: null, frontmatter: null };
  }
}

/* Sets a note as Reading view does, in a page of its own that is never shown. Obsidian's renderer writes the note's
   blocks (so every plugin's post-processors run, and mathematics, callouts and embeds are made as usual); the page
   around them is built as Reading view builds it, because the vault's theme and snippets look for it: the pane's
   own classes, the title above the text, and each block in a <div> marked el-p, el-h2 and so on (Scriptorium finds
   a chapter's opening paragraph by those marks; see dressLikeReadingView). The page is as wide as the note's pane,
   and as tall as its text. If Scriptorium is on, it then gives the note its own drop cap, and lays the footnotes
   out in the margin as it does in a view (dressLikeScriptorium). Returns {host, pane, sizer, margin, destroy()}. */
async function renderPage(app, view, text, width, frontmatter) {
  const doc = document, file = view.file;
  const host = doc.body.createDiv({ cls: 'lagrange-look-page', attr: { 'aria-hidden': 'true', inert: '' } });
  host.style.cssText = `position:fixed;left:-100000px;top:0;width:${width}px;pointer-events:none;`;
  const component = new Component();
  component.load();
  const page = { host, pane: null, sizer: null, margin: null, destroy() {
    if (page.margin) { try { page.margin.destroy(); } catch (e) { /* Scriptorium's own */ } }
    try { component.unload(); } catch (e) { /* nothing to unload */ }
    host.remove();
  } };
  try {
    const real = view.containerEl.querySelector('.markdown-reading-view > .markdown-preview-view');
    const classes = (real ? Array.from(real.classList) : ['markdown-preview-view', 'markdown-rendered', 'node-insert-event',
      'is-readable-line-width', 'allow-fold-headings', 'allow-fold-lists', 'show-indentation-guide', 'show-properties']
      .concat([].concat((frontmatter && (frontmatter.cssclasses || frontmatter.cssclass)) || []).map(String)))
      .filter(c => c && c !== 'scriptorium-margin');
    const leaf = host.createDiv({ cls: 'workspace-leaf-content', attr: { 'data-type': 'markdown', 'data-mode': 'preview' } });
    const content = leaf.createDiv({ cls: 'view-content' });
    const reading = content.createDiv({ cls: 'markdown-reading-view' });
    reading.style.width = '100%';
    const pane = page.pane = reading.createDiv({ cls: classes.join(' ') });
    const written = pane.createDiv();
    await renderMarkdown(app, text, written, file.path, component);
    page.sizer = dressLikeReadingView(written, file.basename);
    page.properties = dressProperties(view, page.sizer, frontmatter);
    page.sizer.createDiv({ cls: 'mod-footer mod-ui' });
    page.margin = dressLikeScriptorium(app, { file, host, content, text, frontmatter });
    return page;
  } catch (e) {
    page.destroy();
    throw e;
  }
}

/* Which of a block's classes belong on the <div> Reading view puts around it: Scriptorium's marks for a centred or
   right-aligned block and for the block that stands for a chapter's opening (its ALIGN_CLASSES). Pure. */
function frameMarks(classes) {
  return (classes || []).filter(c => /^scriptorium-(?:align(?:-|$)|opens$)/.test(c));
}

/* Gives what Obsidian's renderer has written into `written` the frame Reading view gives a note: the sizer, the
   header above the text (with the title, if there is one), and each block in a <div> of its own marked by its
   element (el-p, el-h2, …). A table's block scrolls sideways, as it does there (which also keeps the table's margins
   inside it), and a list has its bullets as elements, which is what themes style. Returns the sizer, which takes
   the place of `written`. */
function dressLikeReadingView(written, title) {
  const doc = written.ownerDocument;
  const make = (cls, parent) => { const el = doc.createElement('div'); el.className = cls; parent.appendChild(el); return el; };
  const sizer = doc.createElement('div');
  sizer.className = 'markdown-preview-sizer markdown-preview-section';
  make('markdown-preview-pusher', sizer).style.cssText = 'width:1px;height:0.1px;margin-bottom:0px;';
  const header = make('mod-header mod-ui', sizer);
  if (title) make('inline-title', header).textContent = title;
  for (const el of Array.from(written.children)) {
    const block = make(`el-${el.tagName.toLowerCase()}`, sizer);
    if (el.matches('pre.frontmatter')) block.classList.add('mod-frontmatter', 'mod-ui');
    if (el.tagName === 'TABLE') {
      block.style.overflowX = 'auto';
      const dir = (el.querySelector('th, td') || el).getAttribute('dir');
      if (dir === 'ltr' || dir === 'rtl') block.setAttribute('dir', dir);
    }
    // Scriptorium marks a centred or right-aligned block, and the block that stands for a chapter's opening, on the
    // <div> around it in Reading view; written all at once, the marks are on the block itself. They go to the
    // <div>, where the snippet's rules look for them (no drop cap on aligned text; the cap on the prose after it).
    for (const c of frameMarks(Array.from(el.classList))) { block.classList.add(c); el.classList.remove(c); }
    block.appendChild(el);
  }
  for (const list of Array.from(sizer.querySelectorAll('ul:not(.has-list-bullet)'))) {
    if (list.closest('.markdown-embed-content')) continue;     // an embedded note's lists are dressed with it
    list.classList.add('has-list-bullet');
    for (const item of Array.from(list.children)) {
      if (item.tagName === 'LI' && !item.querySelector(':scope > .list-bullet')) item.insertBefore(doc.createElement('span'), item.firstChild).className = 'list-bullet';
    }
  }
  written.replaceWith(sizer);
  return sizer;
}

/* The note's properties, as the view shows them: Obsidian makes that box for a view, not for rendered Markdown, so
   the one the note's own view shows now (in Reading view or in the editor; they look the same) is copied to its place
   under the title, with what is typed in its fields. Where the view shows none (the note has none, or properties are
   set not to show) the page has none either. -> the properties in words ("tags: a, b; date: 2026-01-01"), or ''. */
function dressProperties(view, sizer, frontmatter) {
  try {
    const shown = Array.from(view.containerEl.querySelectorAll('.metadata-container')).find(el => el.offsetHeight > 0 && el.querySelector('.metadata-property'));
    const header = sizer.querySelector('.mod-header');
    if (!shown || !header) return '';
    const copy = shown.cloneNode(true);
    const from = Array.from(shown.querySelectorAll('input, textarea')), to = Array.from(copy.querySelectorAll('input, textarea'));
    from.forEach((el, i) => {
      if (!to[i]) return;
      if (el.type === 'checkbox') { if (el.checked) to[i].setAttribute('checked', ''); else to[i].removeAttribute('checked'); }
      else if (to[i].tagName === 'TEXTAREA') to[i].textContent = el.value;
      else to[i].setAttribute('value', el.value);
    });
    for (const el of Array.from(copy.querySelectorAll('[contenteditable]'))) el.removeAttribute('contenteditable');
    header.appendChild(copy);
    const say = v => (Array.isArray(v) ? v.map(say).join(', ') : v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v));
    return excerpt(Object.keys(frontmatter || {}).filter(k => k !== 'position').map(k => `${k}: ${say(frontmatter[k])}`).join('; '), 300);
  } catch (e) {
    return '';
  }
}

/* A note embedded in the page (![[Another note]]) arrives a moment after the page's own blocks, written the same
   plain way; Reading view frames it as it frames a note. Frames those that have arrived and are not framed yet;
   returns whether there were any. */
function dressEmbeds(page) {
  let any = false;
  for (const inner of Array.from(page.host.querySelectorAll('.markdown-embed-content > .markdown-preview-view'))) {
    if (!inner.firstElementChild || inner.querySelector(':scope > .markdown-preview-sizer')) continue;
    const doc = inner.ownerDocument, written = doc.createElement('div');
    while (inner.firstChild) written.appendChild(inner.firstChild);
    inner.appendChild(written);
    inner.classList.add('node-insert-event', 'allow-fold-headings', 'allow-fold-lists');
    dressLikeReadingView(written, '');
    any = true;
  }
  return any;
}

/* What Scriptorium does to a Reading view beyond its post-processor, done to the page: the note's own drop cap (its
   "dropcap" property), and the footnotes and margin notes in the margin where the pane is wide enough. Scriptorium
   does both for the Markdown views in the workspace, so the page stands in for one: an object that says it is a
   view of this note in Reading mode, handed to Scriptorium's own previewDropcap and to its own marginalia.refresh
   (called with a list of views that holds only the page). If Scriptorium is off, or is a version that does these
   otherwise, the page keeps the vault's drop cap and its footnotes at the foot. Returns the margin's layout (it has
   layout() and destroy()), or null. */
function dressLikeScriptorium(app, at) {
  const sc = app.plugins && app.plugins.plugins && app.plugins.plugins.scriptorium;
  if (!sc) return null;
  let standIn;
  try {
    standIn = Object.create(MarkdownView.prototype, {
      file: { value: at.file }, contentEl: { value: at.content }, containerEl: { value: at.host }, data: { value: at.text },
      getMode: { value: () => 'preview' }, getViewData: { value: () => at.text },
    });
  } catch (e) {
    return null;
  }
  try {
    if (typeof sc.previewDropcap === 'function') {
      const own = sc.constructor && typeof sc.constructor.noteDropcap === 'function' && at.frontmatter ? sc.constructor.noteDropcap(at.frontmatter) : undefined;
      sc.previewDropcap(standIn, own, true);
    }
  } catch (e) { /* the vault's drop cap stays */ }
  try {
    const m = sc.marginalia;
    if (!m || typeof m.refresh !== 'function' || !(sc.settings && sc.settings.marginalia)) return null;
    const workspace = Object.create(app.workspace, { iterateAllLeaves: { value: each => each({ view: standIn }) } });
    const only = Object.create(m, { states: { value: new Map() }, app: { value: Object.create(app, { workspace: { value: workspace } }) } });
    m.refresh.call(only);
    const state = only.states.get(standIn);
    return state && typeof state.destroy === 'function' ? state : null;
  } catch (e) {
    return null;
  }
}

/* Waits until the page has come together: fonts, pictures, mathematics, embedded notes, and what plugins do once
   the blocks are in (Scriptorium measures each opening line, and lays the margin out a moment later). The page is
   ready when nothing in it has changed for a moment; at most a few seconds are waited. Timers are used, not frames:
   a window that is hidden draws no frames. */
async function settlePage(page, signal) {
  const host = page.host, doc = host.ownerDocument, win = doc.defaultView || window;
  const deadline = Date.now() + 5000;
  let changed = Date.now();
  const watch = new win.MutationObserver(() => { changed = Date.now(); });
  watch.observe(host, { subtree: true, childList: true, attributes: true, characterData: true });
  const relay = () => { if (page.margin && typeof page.margin.layout === 'function') { try { page.margin.layout(); } catch (e) { /* Scriptorium's own */ } } };
  try {
    // (only where the page has mathematics, and never for long: in a session that has typeset none yet, Obsidian's
    // promise for a page without any does not settle, and a look would wait on it for ever)
    try {
      if (typeof obsidian.finishRenderMath === 'function' && host.querySelector('.math')) await Promise.race([obsidian.finishRenderMath(), sleep(3000, signal)]);
    } catch (e) { if (isAbort(e)) throw e; /* no mathematics */ }
    for (const img of Array.from(host.querySelectorAll('img'))) if (img.loading === 'lazy') img.loading = 'eager';
    if (doc.fonts && doc.fonts.ready) await Promise.race([doc.fonts.ready, sleep(2000, signal)]);
    for (let laid = false; ;) {
      await sleep(50, signal);
      const waiting = Array.from(host.querySelectorAll('img')).some(img => !img.complete) || host.querySelector('.math:not(.is-loaded)');
      const late = Date.now() > deadline;
      if (!late && (waiting || Date.now() - changed < 160)) continue;
      if (!late && dressEmbeds(page)) continue;     // embedded notes have come in: framed, and waited for in turn
      if (laid || late) break;
      relay();              // the margin once more, now that everything has its size; then one more quiet moment
      laid = true;
    }
    if (doc.fonts && doc.fonts.ready) await Promise.race([doc.fonts.ready, sleep(1500, signal)]);
  } finally {
    watch.disconnect();
  }
}

/* Measures the page: {page, blocks, detail(first, last)}. page: {width, height, column: {left, width}, theme, font,
   size, margin, background}. blocks: one record for each block that takes room on the page, with what it is, its
   words, its place (top, bottom, in CSS pixels from the top of the page) and the source lines it comes from
   (info.sections, by alignSections; info.shift is added to them): enough to tell which blocks a look is of.
   detail(first, last) then measures those blocks in full, as describeLook lists them (alignment, font, lines, drop
   cap, mathematics, pictures, footnotes, overflow); a long note has too many blocks to measure them all so. */
function measurePage(page, info) {
  const { host, pane, sizer } = page;
  const doc = host.ownerDocument, win = doc.defaultView || window;
  const origin = host.getBoundingClientRect(), column = sizer.getBoundingClientRect();
  const style = (el, pseudo) => win.getComputedStyle(el, pseudo || null);
  // the font an element is set in: the first of its families that is there to be used (one that a style sheet
  // declares but the browser has not loaded is passed over, and so is "??", which Obsidian writes where no font has
  // been chosen; one that no sheet declares is taken to be installed)
  const declared = new Map();
  if (doc.fonts) doc.fonts.forEach(f => { const name = String(f.family).replace(/^["']|["']$/g, ''); declared.set(name, Boolean(declared.get(name)) || f.status === 'loaded'); });
  const family = cs => {
    const names = String(cs.fontFamily || '').split(',').map(n => n.trim().replace(/^["']|["']$/g, '')).filter(n => /[\p{L}\p{N}]/u.test(n));
    return names.find(n => !declared.has(n) || declared.get(n)) || names[0] || '';
  };
  const round = v => Math.round(parseFloat(v) * 10) / 10 || 0;
  const tidy = t => String(t || '').replace(/\s+/g, ' ').trim();
  const alignOf = el => {
    const cs = style(el), rtl = cs.direction === 'rtl';
    const a = String(cs.textAlign || '').replace('-webkit-', '');
    if (a === 'center' || a === 'justify' || a === 'left' || a === 'right') return a;
    return (a === 'end') !== rtl ? 'right' : 'left';
  };
  // where a box stands in the column: against its left edge, its right edge, or in the middle
  const placed = box => {
    const l = box.left - column.left, r = column.right - box.right;
    if (Math.abs(l - r) <= 2) return l <= 2 ? 'full' : 'center';
    return l < r ? 'left' : 'right';
  };
  // the lines of text in an element: its boxes of text, counted by where they stand (a floated initial is taller
  // than a line and is not one)
  const linesOf = el => {
    const range = doc.createRange();
    range.selectNodeContents(el);
    const max = 2 * (parseFloat(style(el).fontSize) || 16);
    const boxes = Array.from(range.getClientRects()).filter(r => r.width > 0.5 && r.height > 2 && r.height < max).sort((a, b) => a.top - b.top);
    let n = 0, bottom = -Infinity;
    for (const r of boxes) {
      if ((r.top + r.bottom) / 2 > bottom) { n++; bottom = r.bottom; } else bottom = Math.max(bottom, r.bottom);
    }
    return n;
  };
  // the words of an element that are shown: text that a style keeps off the page is left out (Scriptorium hides
  // the marker lines of a centred or right-aligned block that way). -> the text nodes shown, in order
  const shownNodes = el => {
    const out = [], hidden = new Map();
    const off = n => {
      if (!n || n === el.parentElement || n.nodeType !== 1) return false;
      if (!hidden.has(n)) hidden.set(n, style(n).display === 'none' || off(n.parentElement));
      return hidden.get(n);
    };
    const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) if (!off(node.parentElement)) out.push(node);
    return out;
  };
  const shown = el => (el.firstElementChild ? shownNodes(el).map(n => n.data).join('') : el.textContent || '');
  const dropcapOf = p => {
    const ps = style(p), base = parseFloat(ps.fontSize) || 16, line = parseFloat(ps.lineHeight) || base * 1.5;
    const letter = (/[\p{L}\p{N}]/u.exec(shown(p)) || [''])[0];
    if (!letter) return null;
    // a picture in the letter's place (Scriptorium's sets of drop caps): a floated box before the text
    const before = style(p, '::before');
    if (before.content !== 'none' && before.float !== 'none' && /url\(/.test(`${before.backgroundImage} ${before.maskImage} ${before.webkitMaskImage}`)) {
      const h = parseFloat(before.height) || 0;
      return { letter, image: true, size: round(h), deep: h ? Math.max(1, Math.round(h / line)) : 0 };
    }
    const first = style(p, '::first-letter'), size = parseFloat(first.fontSize) || 0;
    if (first.float === 'none' && size < base * 1.8) return null;
    // how deep it sinks: the letter's own box against the lines
    let deep = 0;
    try {
      for (const node of shownNodes(p)) {
        const i = node.data.indexOf(letter);
        if (i < 0) continue;
        const r = doc.createRange();
        r.setStart(node, i); r.setEnd(node, i + letter.length);
        const box = r.getBoundingClientRect();
        if (box.height) deep = Math.max(1, Math.round(box.height / line));
        break;
      }
    } catch (e) { /* the size says enough */ }
    return { letter, font: family(first), size: round(size), deep };
  };

  const text = sizer.querySelector('.el-p > p');
  const paper = el => {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const c = style(n).backgroundColor;
      if (c && c !== 'transparent' && !/rgba\([^)]*,\s*0\s*\)$/.test(c)) return c;
    }
    return '#ffffff';
  };
  const meta = {
    width: origin.width, height: Math.max(host.offsetHeight, host.scrollHeight),
    column: { left: column.left - origin.left, width: column.width },
    theme: doc.body.classList.contains('theme-dark') ? 'dark' : 'light',
    font: text ? family(style(text)) : family(style(pane)), size: round(style(text || pane).fontSize),
    margin: Boolean(pane.querySelector('.scriptorium-sidenote')),
    background: paper(pane),
  };

  // the formulas, in the order they stand: MathJax keeps each one's source on it; where it does not, the note's
  // own formulas are told off against them, if there are as many
  const formulas = Array.from(sizer.querySelectorAll('.math'));
  let sources = formulas.map(f => { const m = f.querySelector('mjx-math[data-latex]'); return m ? m.getAttribute('data-latex') : null; });
  if (sources.some(v => v === null)) {
    const written = Array.isArray(info.math) ? info.math : [];
    sources = written.length === formulas.length ? written : sources.map(v => v || '');
  }

  const rendered = Array.from(sizer.children).filter(w => /(?:^|\s)el-/.test(w.className) && w.firstElementChild);
  const where = info.sections ? alignSections(info.sections, rendered.map(w => w.firstElementChild.tagName.toLowerCase())) : null;
  const blocks = [], parts = new Map(), done = new Set();
  // every block: what it is, its words, its place, its lines
  const outline = (w, el, lines) => {
    const box = w.getBoundingClientRect();
    const cls = el.classList, tag = el.tagName.toLowerCase();
    const inMargin = cls.contains('callout') && cls.contains('scriptorium-in-margin');
    if (box.height < 0.5 && !inMargin) return;      // the front matter, a comment: nothing on the page
    const b = { kind: tag, text: tidy(shown(el)).slice(0, 200), top: box.top - origin.top, bottom: box.bottom - origin.top };
    b.key = tidy(el.textContent).slice(0, 200);       // (all its words, shown or not, as visibleLines reads them: what is on screen in Reading view is found by them)
    if (lines) { b.from = lines.from + (info.shift || 0); b.to = lines.to + (info.shift || 0); }
    let inner = el;
    if (cls.contains('inline-title')) b.kind = 'title';
    else if (/^h[1-6]$/.test(tag)) { b.kind = 'heading'; b.level = Number(tag[1]); }
    else if (tag === 'p') b.kind = el.querySelector('img') && !b.text ? 'picture' : 'paragraph';
    else if (tag === 'blockquote') { b.kind = 'blockquote'; inner = el.querySelector('p') || el; }
    else if (cls.contains('callout')) {
      b.kind = 'callout';
      b.callout = el.getAttribute('data-callout') || 'note';
      b.inMargin = inMargin;
      inner = el.querySelector('.callout-content p, .callout-content') || el;
    } else if (tag === 'ul' || tag === 'ol') { b.kind = 'list'; b.items = el.querySelectorAll('li').length; inner = el.querySelector('li') || el; }
    else if (tag === 'table') {
      b.kind = 'table';
      b.rows = el.rows.length;
      b.cols = el.rows.length ? el.rows[0].cells.length : 0;
      inner = el.querySelector('td, th') || el;
    } else if (tag === 'pre') {
      b.kind = 'code';
      const lang = /(?:^|\s)language-([\w+#.-]+)/.exec(`${el.className} ${el.firstElementChild ? el.firstElementChild.className : ''}`);
      if (lang) b.language = lang[1];
      inner = el.querySelector('code') || el;
    } else if (cls.contains('math')) { b.kind = 'math'; b.text = ''; }
    else if (tag === 'hr') b.kind = 'rule';
    else if (tag === 'section' && cls.contains('footnotes')) { b.kind = 'footnotes'; b.items = el.querySelectorAll('li').length; inner = el.querySelector('li') || el; }
    parts.set(b, { el, inner, inMargin });
    blocks.push(b);
  };
  // one block in full: how it is set
  const detail = b => {
    const part = parts.get(b);
    if (!part || done.has(b)) return;
    done.add(b);
    const { el, inner, inMargin } = part;
    if (b.kind === 'picture') b.align = placed(el.querySelector('img').getBoundingClientRect());
    else if (b.kind === 'math') b.align = placed((el.querySelector('mjx-math') || el).getBoundingClientRect());
    else if (b.kind !== 'rule') b.align = alignOf(inner);
    if (!['picture', 'math', 'rule'].includes(b.kind)) {
      const cs = style(inner);
      b.font = family(cs);
      b.size = round(cs.fontSize);
      b.italic = /italic|oblique/.test(cs.fontStyle);
      b.smallCaps = /small-caps/.test(`${cs.fontVariantCaps} ${cs.fontVariant}`);
      if (b.kind !== 'table') b.lines = linesOf(el);
    }
    if (b.kind === 'paragraph') {
      b.dropcap = dropcapOf(el);
      b.firstLineCaps = /small-caps/.test(`${style(el, '::first-line').fontVariantCaps}`) && !b.smallCaps;
    }
    b.math = Array.from(el.querySelectorAll('.math')).concat(el.classList.contains('math') ? [el] : []).map(f => sources[formulas.indexOf(f)]).filter(Boolean);
    b.images = Array.from(el.querySelectorAll('img')).slice(0, 8).map(img => {
      const r = img.getBoundingClientRect();
      return { alt: img.alt || '', width: r.width, height: r.height, broken: img.complete && !img.naturalWidth, remote: /^https?:/i.test(img.currentSrc || img.src || '') };
    });
    b.notes = Array.from(el.querySelectorAll('sup.footnote-ref a[data-footref]')).slice(0, 12).map(a => {
      const id = a.getAttribute('data-footref');
      const side = Array.from(pane.querySelectorAll('.scriptorium-sidenote[data-footref]')).some(n => n.getAttribute('data-footref') === id);
      return { label: tidy(a.textContent).replace(/^\[|\]$/g, ''), where: side ? 'margin' : 'foot' };
    });
    // too wide: something in it scrolls sideways, or reaches past the right edge of the column
    b.overflow = 0;
    for (const x of [el].concat(Array.from(el.querySelectorAll('pre, code, table, mjx-container, img')).slice(0, 40))) {
      const scrolled = x.scrollWidth - x.clientWidth;
      if (x.clientWidth && scrolled > 1 && style(x).overflowX !== 'visible') { b.overflow = Math.max(b.overflow, scrolled); b.scrolls = true; }
      const past = x.getBoundingClientRect().right - column.right;
      if (past > 1 && !inMargin) b.overflow = Math.max(b.overflow, past);
    }
  };
  const title = sizer.querySelector(':scope > .mod-header > .inline-title');
  if (title && title.getBoundingClientRect().height >= 0.5) outline(title.parentElement, title, null);
  rendered.forEach((w, i) => outline(w, w.firstElementChild, where ? where[i] : null));
  return { page: meta, blocks, detail: (first, last) => { for (let i = Math.max(0, first); i <= last && i < blocks.length; i++) detail(blocks[i]); } };
}

/* The page's markup and styles, as one XHTML text the browser can draw by itself, with nothing to fetch: the page
   (a copy of it) inside copies of <html> and <body>, which carry the classes the theme's rules look for; every style
   rule of the document; the fonts in use, and the note's pictures, as data. A picture from the web is asked for
   from its own address once more, as Obsidian asks for it to show the note (most often it is answered from the cache),
   and can be used only if its server lets a page read it; one that cannot be read has a box of its size in its
   place that says so, and page.web counts both kinds. */
async function pageMarkup(page, signal) {
  const host = page.host, doc = host.ownerDocument, win = doc.defaultView || window;
  const asData = async url => {
    const res = await win.fetch(url, { signal });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const blob = await res.blob();
    return new Promise((resolve, reject) => {
      const reader = new win.FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error || new Error('unreadable'));
      reader.readAsDataURL(blob);
    });
  };
  // a picture from the web, drawn again so that it can be read: only one whose server allows that comes out
  const fromWeb = (url, w, h) => new Promise((resolve, reject) => {
    const img = new win.Image();
    const timer = win.setTimeout(() => reject(new Error('too slow')), 4000);
    img.crossOrigin = 'anonymous';
    img.onerror = () => { win.clearTimeout(timer); reject(new Error('not readable')); };
    img.onload = () => {
      win.clearTimeout(timer);
      try {
        const k = Math.min(1, 1600 / Math.max(1, img.naturalWidth, img.naturalHeight)), canvas = doc.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.naturalWidth * k));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * k));
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        let data = canvas.toDataURL('image/png');
        if (data.length > 1500000) data = canvas.toDataURL('image/jpeg', 0.85);
        resolve(data);
      } catch (e) { reject(e); }
    };
    img.src = url;
    if (signal) signal.addEventListener('abort', () => { win.clearTimeout(timer); reject(abortError()); }, { once: true });
  });
  page.web = { shown: 0, missing: 0 };
  // a file of the vault or of Obsidian itself (the app's own address), never the network
  const local = url => /^(?:app|capacitor|file|blob):/i.test(url) || (/^https?:/i.test(url) && new URL(url).origin === win.location.origin);
  const inline = async (text, base) => {
    for (const u of cssUrls(text)) {
      try {
        const url = new URL(u.url, base).href;
        if (local(url)) text = text.split(u.whole).join(`url("${await asData(url)}")`);
      } catch (e) { /* left as it is: it will not load, and the rest is drawn */ }
    }
    return text;
  };

  // the fonts in use (the browser has loaded them), and every other rule as it stands
  const inUse = new Set();
  if (doc.fonts) doc.fonts.forEach(f => { if (f.status === 'loaded') inUse.add(String(f.family).replace(/^["']|["']$/g, '')); });
  let fonts = '', rules = '';
  const read = async (sheet, depth) => {
    let list;
    try { list = sheet.cssRules; } catch (e) { return; }   // a sheet from elsewhere, closed to scripts
    const base = sheet.href || doc.baseURI;
    for (const rule of Array.from(list)) {
      if (rule.type === 5) {                                // @font-face
        const name = String(rule.style.getPropertyValue('font-family') || '').replace(/^["']|["']$/g, '');
        if (inUse.has(name)) fonts += `${await inline(rule.cssText, base)}\n`;
      } else if (rule.type === 3) {                         // @import: its rules, in its place
        if (rule.styleSheet && depth < 4) await read(rule.styleSheet, depth + 1);
      } else {
        rules += `${rule.cssText}\n`;
      }
    }
  };
  for (const sheet of Array.from(doc.styleSheets)) await read(sheet, 0);
  if (signal && signal.aborted) throw abortError();

  const html = doc.createElement('html'), body = doc.createElement('body'), sheet = doc.createElement('style');
  for (const [from, to] of [[doc.documentElement, html], [doc.body, body]]) {
    for (const a of Array.from(from.attributes)) if (/^(?:class|style|lang|dir|data-)/.test(a.name)) to.setAttribute(a.name, a.value);
  }
  const width = host.offsetWidth, height = Math.max(host.offsetHeight, host.scrollHeight);
  body.setAttribute('style', `${body.getAttribute('style') || ''};margin:0;padding:0;width:${width}px;height:${height}px;overflow:hidden;`);
  // nothing moves in a picture: an animation would be caught at its first frame
  sheet.textContent = `${fonts}${rules}*, *::before, *::after { animation: none !important; transition: none !important; }\n`;
  html.appendChild(sheet);
  html.appendChild(body);
  const copy = host.cloneNode(true);
  copy.setAttribute('style', `position:static;width:${width}px;`);
  copy.removeAttribute('inert');
  body.appendChild(copy);

  const live = Array.from(host.querySelectorAll('*')), copies = Array.from(copy.querySelectorAll('*'));
  const box = (el, c) => { const r = el.getBoundingClientRect(); c.setAttribute('width', String(Math.round(r.width))); c.setAttribute('height', String(Math.round(r.height))); return r; };
  const blank = (w, h, label) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${Math.max(1, Math.round(w))}" height="${Math.max(1, Math.round(h))}"><rect width="100%" height="100%" fill="#888" fill-opacity="0.25"/>${label ? `<text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" font-family="sans-serif" font-size="${Math.max(9, Math.min(15, Math.round(w / 22)))}" fill="#666">${xmlSafe(label)}</text>` : ''}</svg>`)}`;
  let budget = 12000000;                                    // characters of pictures, as data, in one page
  for (let i = 0; i < live.length && i < copies.length; i++) {
    const el = live[i], c = copies[i], tag = el.tagName.toLowerCase();
    if (tag === 'img') {
      const r = box(el, c), src = el.currentSrc || el.src || '';
      c.removeAttribute('srcset');
      c.removeAttribute('loading');
      if (/^data:/i.test(src)) continue;
      let data = '';
      const web = /^https?:/i.test(src) && !local(src);
      try {
        if (budget > 0 && !(el.complete && !el.naturalWidth)) data = web ? await fromWeb(src, r.width, r.height) : local(src) ? await asData(src) : '';
      } catch (e) { if (isAbort(e)) throw e; /* a box in its place */ }
      budget -= data.length;
      if (web) page.web[data ? 'shown' : 'missing']++;
      c.setAttribute('src', data || (web ? blank(r.width, r.height, 'picture from the web, not shown here') : blank(r.width, r.height)));
    } else if (tag === 'canvas') {
      const img = doc.createElement('img');
      const r = box(el, img);
      try { img.setAttribute('src', el.toDataURL('image/png')); } catch (e) { img.setAttribute('src', blank(r.width, r.height)); }
      c.replaceWith(img);
    } else if (['iframe', 'video', 'audio', 'object', 'embed', 'webview', 'script'].includes(tag)) {
      const stand = doc.createElement('div');
      const r = el.getBoundingClientRect();
      stand.setAttribute('style', `display:inline-block;width:${Math.round(r.width)}px;height:${Math.round(r.height)}px;background:rgba(136,136,136,0.25);`);
      c.replaceWith(stand);
    } else if (tag === 'input') {
      if (el.checked) c.setAttribute('checked', ''); else c.removeAttribute('checked');
      if (el.type !== 'checkbox' && el.type !== 'radio') c.setAttribute('value', el.value);
    }
    // a picture named in an element's own style (Scriptorium's drop caps of a set are)
    const own = c.getAttribute && c.getAttribute('style');
    if (own && /url\(/.test(own)) c.setAttribute('style', await inline(own, doc.baseURI));
  }
  if (signal && signal.aborted) throw abortError();
  return { xhtml: new win.XMLSerializer().serializeToString(html), width, height, rootFontSize: win.getComputedStyle(doc.documentElement).fontSize };
}

/* Takes the pictures of a page: one for each of `pages` ([{top, bottom}], CSS pixels), scaled by `scale`, as
   [{mediaType, data (base64), width, height, top, bottom}]. The browser draws the page's markup as an SVG picture
   (which must hold everything it needs: pageMarkup) and each page is cut from it on a canvas. A PNG, unless that
   is too large (a page of photographs): then a JPEG. */
async function picturePage(page, pages, scale, background, signal) {
  const host = page.host, doc = host.ownerDocument, win = doc.defaultView || window;
  const m = await pageMarkup(page, signal);
  const img = new win.Image();
  await new Promise((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('the page could not be drawn'));
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(pageSvg(m.xhtml, m.width, m.height, m.rootFontSize))}`;
  });
  try { if (img.decode) await img.decode(); } catch (e) { /* drawn as it is */ }
  const out = [];
  for (const p of pages) {
    if (signal && signal.aborted) throw abortError();
    const top = Math.max(0, Math.floor(p.top)), bottom = Math.min(m.height, Math.ceil(p.bottom));
    if (bottom - top < 1) continue;
    const canvas = doc.createElement('canvas');
    canvas.width = Math.max(1, Math.round(m.width * scale));
    canvas.height = Math.max(1, Math.round((bottom - top) * scale));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = background || '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, top, m.width, bottom - top, 0, 0, canvas.width, canvas.height);
    let mediaType = 'image/png', url = canvas.toDataURL('image/png');
    if (url.length > LOOK_PICTURE_CHARS) { mediaType = 'image/jpeg'; url = canvas.toDataURL('image/jpeg', 0.85); }
    out.push({ mediaType, data: url.slice(url.indexOf(',') + 1), width: canvas.width, height: canvas.height, top, bottom });
  }
  if (!out.length) throw new Error('the page is empty');
  return out;
}

/* A look at a note's page (see the head of this section). */
async function lookAtPage(app, view, spec, opts) {
  const o = opts || {}, signal = o.signal;
  const file = view.file, full = view.getViewData();
  let want = spec && spec.target ? spec : { target: 'auto' };
  const seen = visibleLines(view);
  const near = want.target === 'passage' ? passageLines(full, want.near) : null;
  const focus = want.target === 'lines' ? want.from : near ? near.from
    : want.target === 'section' ? headingLine(full, want.heading) : want.target !== 'note' && seen && seen.from ? seen.from : 1;
  const source = lookSource(full, focus || 1, LOOK_SOURCE_CHARS);
  const info = await noteSections(app, source.text);
  if (signal && signal.aborted) throw abortError();
  const width = paneWidth(view);
  const page = await renderPage(app, view, source.text, width, info.frontmatter);
  try {
    await settlePage(page, signal);
    const measured = measurePage(page, { sections: info.sections, shift: source.shift, math: mathSegments(source.text).filter(g => g.type === 'math' && typeof g.open !== 'string').map(g => g.source) });
    measured.page.cut = source.cut;
    const blocks = measured.blocks;
    let range = lookRange(want, blocks, { seen, near });
    if (!range) throw new LagrangeError('there is nothing on the page of this note yet.');
    measured.detail(range.first, Math.min(range.last, range.first + LOOK_BLOCKS - 1));
    const scale = lookScale(width);
    const line = (measured.page.size || 16) * 1.6;
    const plan = r => {
      const top = r.first === 0 ? 0 : Math.max(0, blocks[r.first].top - line / 2);
      const bottom = r.last === blocks.length - 1 ? measured.page.height : Math.min(measured.page.height, blocks[r.last].bottom + line / 2);
      const cuts = blocks.slice(r.first + 1, r.last + 1).map(b => b.top - 2);
      return lookPages(top, Math.max(bottom, top + 1), cuts, LOOK_HEIGHT / scale, LOOK_PAGES, line * 1.5);
    };
    let pages = plan(range);
    if (want.target === 'auto') {
      // the whole note if one look holds it; else what is on screen, if that can be told
      const onScreen = pages.more && seen ? lookRange({ target: 'view' }, blocks, { seen }) : null;
      if (onScreen && !onScreen.remark) { want = { target: 'view' }; range = onScreen; pages = plan(range); } else want = { target: 'note' };
      measured.detail(range.first, Math.min(range.last, range.first + LOOK_BLOCKS - 1));
    }
    const remarks = [];
    if (range.remark) remarks.push(range.remark);
    let pictures = [], problem = '';
    if (o.pictures) {
      try {
        pictures = await picturePage(page, pages.pages, scale, measured.page.background, signal);
      } catch (e) {
        if (isAbort(e) || (signal && signal.aborted)) throw abortError();
        problem = String((e && e.message) || e).slice(0, 160);
      }
      const lost = page.web ? page.web.missing : 0;
      if (lost && pictures.length) remarks.push(`${lost === 1 ? 'One picture' : `${lost} pictures`} from the web could not be read for the picture of the page (${lost === 1 ? 'its server does' : 'their servers do'} not allow it): a grey box that says so stands in ${lost === 1 ? 'its' : 'their'} place; the size and the description below are right.`);
    }
    measured.page.properties = page.properties || '';
    const look = {
      spec: want, label: range.remark ? 'the whole note' : lookLabel(want), title: file.basename, path: file.path, page: measured.page,
      blocks: blocks.slice(range.first, range.last + 1), pictures, more: pictures.length ? pages.more : 0, remarks, problem, description: '',
    };
    look.description = describeLook(look, LOOK_DESCRIPTION_CHARS);
    return look;
  } finally {
    page.destroy();
  }
}


/* ---------------------------------------------------------------------------------------------------------------
 * 8. The chat view, the revise modal, the settings tab and the plugin
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
    this.checkpoints = [];       // one per message sent, for "Rewind to here" (see rewindTo)
    this.shown = null;           // {look, el, hint}: a page the writer has shown Lagrange, to go with the next message
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
    // Undo and Redo for Lagrange's own edits (a run of edits at a time; see the plugin's undoEdit and redoEdit).
    this.undoEl = actions.createEl('button', { cls: 'lagrange-icon clickable-icon', attr: { 'aria-label': 'Undo Lagrange’s last edits' } });
    setIcon(this.undoEl, 'undo-2');
    this.undoEl.addEventListener('click', () => { const r = undoTarget(this.plugin.edits); if (r) this.plugin.undoEdit(r); });
    this.redoEl = actions.createEl('button', { cls: 'lagrange-icon clickable-icon', attr: { 'aria-label': 'Redo Lagrange’s edits' } });
    setIcon(this.redoEl, 'redo-2');
    this.redoEl.addEventListener('click', () => { const r = redoTarget(this.plugin.edits); if (r) this.plugin.redoEdit(r); });
    const clear = actions.createEl('button', { cls: 'lagrange-icon clickable-icon', attr: { 'aria-label': 'Clear the conversation' } });
    setIcon(clear, 'eraser');
    clear.addEventListener('click', () => this.clear());

    this.logEl = root.createDiv({ cls: 'lagrange-log', attr: { 'aria-live': 'polite' } });
    this.logEl.addEventListener('click', ev => this.onLinkClick(ev));
    // The log keeps to its bottom (the newest words, the loader) until the writer scrolls up; see stickAfterScroll.
    this.stick = true;
    this.lastTop = 0;
    this.logEl.addEventListener('scroll', () => {
      const el = this.logEl;
      this.stick = stickAfterScroll(this.stick, this.lastTop, el.scrollTop, el.scrollHeight, el.clientHeight);
      this.lastTop = el.scrollTop;
    });
    this.watchLog();

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
    this.refreshHistory();
    this.showEmpty();
  }

  /* The Undo and Redo buttons are live only when there is a run of Lagrange's edits to take back or to make again. */
  refreshHistory() {
    if (!this.undoEl) return;
    this.undoEl.disabled = !undoTarget(this.plugin.edits);
    this.redoEl.disabled = !redoTarget(this.plugin.edits);
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
    // (a name for assistive technology only: the styles keep Obsidian from showing aria-labels as bubbles, --no-tooltip)
    this.modelEl.setAttribute('aria-label', `Model: ${footLabel(s)}. Change the model or the effort`);
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

  /* To the bottom of the log, if the writer is keeping to it (or force: they have just sent a message, which takes
     hold of the bottom again). */
  scrollDown(force) {
    if (force) this.stick = true;
    if (!this.stick) return;
    const el = this.logEl;
    el.scrollTop = el.scrollHeight;
    this.lastTop = el.scrollTop;
  }

  /* Whatever is added to the log or grows in it (the loader's plate, a caption, a reply as it streams, a picture that
     loads, the panel being resized) keeps the bottom in view while the writer is keeping to it. */
  watchLog() {
    const el = this.logEl, win = el.ownerDocument.defaultView || window;
    const follow = () => this.scrollDown();
    try {
      const grown = new win.ResizeObserver(follow);
      grown.observe(el);
      const watchKids = () => { for (const k of el.children) grown.observe(k); };
      const added = new win.MutationObserver(() => { watchKids(); follow(); });
      added.observe(el, { childList: true, subtree: true, characterData: true });
      watchKids();
      this.register(() => { grown.disconnect(); added.disconnect(); });
    } catch (e) { /* the log is scrolled where its content is added instead */ }
  }

  clear() {
    this.stop();
    this.history = [];
    this.checkpoints = [];
    this.shown = null;
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

  /* The writer's message in the log, with its "Rewind to here" button. */
  addUser(text, checkpoint) {
    this.clearEmpty();
    const el = this.logEl.createDiv({ cls: 'lagrange-turn lagrange-turn--user' });
    el.createDiv({ cls: 'lagrange-turn-text', text });
    if (checkpoint) {
      checkpoint.el = el;
      const b = el.createEl('button', { cls: 'lagrange-rewind clickable-icon' });
      setIcon(b, 'history');
      checkpoint.button = b;
      this.labelRewind(checkpoint);
      b.addEventListener('click', () => { this.rewind(checkpoint); });
    }
    this.scrollDown(true);
    return el;
  }

  labelRewind(cp) {
    if (!cp.button) return;
    const label = cp.expired
      ? 'Rewind the conversation to here and edit this message. The note as it was then is no longer kept (only ' +
        `the last ${CHECKPOINTS_KEPT} points are), so it would be left as it is`
      : 'Rewind to here: the conversation and the note go back to this point, and you can edit this message';
    cp.button.setAttribute('aria-label', label);
    cp.button.toggleClass('is-expired', Boolean(cp.expired));
  }

  /* "Rewind to here": drops this message and everything after it from the conversation (and from what the model is
     sent), puts the note back as it was when the message was sent, and puts the message back in the box to be
     edited. If the note holds changes that are not Lagrange's since then, the writer chooses whether to keep them. */
  async rewind(cp) {
    const k = this.checkpoints.indexOf(cp);
    if (k < 0) return;
    if (this.pending || this.plugin.editing) { new Notice('Lagrange is still at work: stop it, or wait, then rewind.'); return; }
    let restore = false, kept = false;
    if (cp.path && cp.before != null) {
      const current = await this.plugin.noteText(cp.path);
      if (current !== null && current !== cp.before) {
        if (userChangedSince(this.checkpoints, k, current)) {
          const choice = await new RewindModal(this.app).ask();
          if (!choice) return;
          restore = choice === 'restore';
          kept = !restore;
        } else {
          restore = true;
        }
      }
    }
    const back = rewindTo(this.history, this.checkpoints, k);
    this.history = back.history;
    this.checkpoints = back.checkpoints;
    for (let n = cp.el; n;) { const next = n.nextSibling; n.remove(); n = next; }
    if (restore) {
      try {
        await this.plugin.restoreNote(cp.path, cp.before, cp.clock);
      } catch (e) {
        new Notice(`The conversation was rewound, but the note could not be put back: ${e.message}`);
      }
    }
    this.showEmpty();
    this.inputEl.value = cp.text;
    this.fitInput();
    this.inputEl.focus();
    if (cp.expired) new Notice(`Rewound the conversation. The note as it was then is no longer kept (only the last ${CHECKPOINTS_KEPT} points are), so it was left as it is.`, 8000);
    else if (kept) new Notice('Rewound the conversation; the note was left as it is.');
    else if (restore) new Notice('Rewound: the conversation and the note are as they were at that message. Undo in the editor brings the note’s later text back.', 8000);
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
    this.scrollDown();
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

  /* A look in the log: "Lagrange looked at the page", with a small picture of what it was shown; a click opens all
     of it (LookModal). Until the page is set it says that it is looking. by: 'writer' when the writer shows the page
     with the command. done() returns the element its words are in. */
  addLook(by) {
    this.clearEmpty();
    const el = this.logEl.createDiv({ cls: 'lagrange-look is-pending' });
    const line = el.createDiv({ cls: 'lagrange-look-detail', text: by === 'writer' ? 'Setting the page…' : 'Lagrange is looking at the page…' });
    this.scrollDown();
    return {
      el,
      remove: () => el.remove(),
      fail: why => {
        el.removeClass('is-pending');
        el.addClass('is-failed');
        line.setText(`${by === 'writer' ? 'The page could not be shown' : 'Lagrange could not look at the page'}: ${why}`);
        this.scrollDown();
      },
      done: look => {
        el.removeClass('is-pending');
        el.empty();
        const open = () => new LookModal(this.app, look, lookRecipient(this.plugin.settings)).open();
        if (look.pictures.length) {
          // (the label is for assistive technology: nothing in the panel shows a bubble on hover)
          const thumb = el.createEl('button', { cls: 'lagrange-look-thumb', attr: { type: 'button', 'aria-label': 'Open what Lagrange was shown' } });
          thumb.createEl('img', { attr: { src: `data:${look.pictures[0].mediaType};base64,${look.pictures[0].data}`, alt: '' } });
          thumb.addEventListener('click', open);
        }
        const words = el.createDiv({ cls: 'lagrange-look-words' });
        words.createDiv({ cls: 'lagrange-look-title', text: by === 'writer' ? 'You showed Lagrange the page' : 'Lagrange looked at the page' });
        words.createDiv({ cls: 'lagrange-look-detail', text: lookCaption(look) });
        const more = words.createEl('button', { cls: 'lagrange-look-open', text: 'What it was shown', attr: { type: 'button' } });
        more.addEventListener('click', open);
        this.scrollDown();
        return words;
      },
    };
  }

  /* "Show Lagrange the rendered page": the page of a note is set and kept here, in the log, to go with the writer's
     next message (takeShown); nothing is sent until then, and the writer can take it back. */
  async showPage(view) {
    if (this.pending) { new Notice('Lagrange is still at work: stop it, or wait, then show it the page.'); return; }
    this.dropShown();
    this.stick = true;
    const entry = this.addLook('writer');
    try {
      const look = await this.plugin.lookAtPage(view, { target: 'auto' }, {});
      const words = entry.done(look);
      const hint = words.createDiv({ cls: 'lagrange-look-detail' });
      hint.appendText('It goes with your next message. ');
      const back = hint.createEl('button', { cls: 'lagrange-look-open', text: 'Take it back', attr: { type: 'button' } });
      back.addEventListener('click', () => this.dropShown());
      this.shown = { look, el: entry.el, hint };
      this.scrollDown();
    } catch (err) {
      entry.fail(err.message || String(err));
    }
  }

  dropShown() {
    if (this.shown) this.shown.el.remove();
    this.shown = null;
  }

  /* The page the writer has shown, if it is of the note a message is about: it goes with that message. */
  takeShown(note) {
    const s = this.shown;
    this.shown = null;
    if (!s) return null;
    if (!note || s.look.path !== note.path) { s.el.remove(); return null; }
    s.hint.remove();
    return s.look;
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
    let note = this.plugin.noteFrom(target);
    const limit = NOTE_LIMIT[this.plugin.settings.provider] || NOTE_LIMIT.anthropic;
    let clip = note ? clipText(note.text, limit, note.cursor) : null;

    // The checkpoint for "Rewind to here": where the conversation stands, and the note as it is now.
    const checkpoint = {
      text, historyLength: this.history.length, path: note ? note.path : null, before: note ? note.text : null, after: null,
      expired: false, clock: this.plugin.editClock,
    };
    this.checkpoints.push(checkpoint);
    this.addUser(text, checkpoint);
    if (clip && clip.clipped && !this.clipNoted.has(note.path)) {
      this.clipNoted.add(note.path);
      this.addAside(`“${note.title}” is long (${clip.total.toLocaleString()} characters), so Lagrange reads the ` +
        `${(clip.end - clip.start).toLocaleString()} characters around your cursor.`);
    }
    const settings = this.plugin.settings;
    // With "Edit with the pen" on, a reply may end with edits to the note (parseAgentReply): the chat shows only its
    // prose, and the edits go to the pen once the reply is complete.
    const agentic = Boolean(settings.agenticEdits);
    // With "Let Lagrange look at the rendered page" on, a reply may ask to look at the page (parseLookReply): it is
    // then shown the page, and replies again. One message of the writer's is thus a turn of up to LOOKS_PER_MESSAGE
    // + 1 replies. A page the writer has shown with the command goes with the message itself, and is no such look.
    const canLook = Boolean(settings.lookAtPage && note);
    const shown = this.takeShown(note);
    // What this turn adds to the conversation (kept), and the same as the model is sent it now (sent): the pictures
    // of a look are sent once and are not kept. The conversation takes the turn in when it is over.
    // (shown when another model was chosen, perhaps: one that takes no pictures is given the words alone)
    const desktop = !(obsidian.Platform && obsidian.Platform.isDesktopApp === false);
    const first = !shown ? null
      : lookMessage(lookSendsPictures(settings, desktop, this.plugin.session) ? shown : Object.assign({}, shown, { pictures: [], more: 0 }), { by: 'writer', text });
    const kept = [{ role: 'user', content: first ? first.kept : text }];
    const sent = [first ? { role: 'user', content: first.content, alt: first.alt } : kept[0]];
    const controller = new AbortController();
    this.setPending({ controller });
    let reply = null, partial = '', raw = '', streaming = false, failed = false, ran = null, typed = false;
    let looksLeft = canLook ? LOOKS_PER_MESSAGE : 0, lastLook = shown;
    try {
      for (let round = 0; ; round++) {
        const answer = reply = this.addReply(note && note.path);
        if (!round) this.scrollDown(true);       // the loader has just come in under the message: it is in view
        partial = '';
        raw = '';
        const prose = full => {
          const look = canLook ? parseLookReply(full) : { text: full, look: null };
          const part = agentic ? splitAgentReply(look.text) : { text: look.text, blocks: [] };
          if (part.blocks.length) answer.status('Taking up the pen…');
          else if (look.look) answer.status('Turning to the page…');
          return part.text;
        };
        streaming = true;
        const res = await complete(settings, {
          purpose: 'chat',
          system: chatSystemPrompt(note, clip, agentic, canLook),
          messages: this.history.concat(sent),
          cache: true,
          demo: () => (round || lastLook ? demoLookReply(lastLook) : demoChatReply(text, note, agentic, canLook)),
        }, {
          signal: controller.signal,
          onText: (d, full) => { raw = full; partial = prose(full); answer.update(partial); },
          onRetry: (status, ms) => answer.note(`Busy (${status}); trying again in ${Math.round(ms / 1000)} s…`, 'is-quiet'),
        }, this.plugin.session);
        streaming = false;
        const asked = canLook ? parseLookReply(res.text) : { text: res.text, look: null };
        const parsed = agentic ? parseAgentReply(asked.text) : { text: asked.text, ops: [], dropped: 0, error: null, open: false };
        const refused = res.stopReason === 'refusal';
        const editing = parsed.ops.length > 0 && !refused;
        const looking = Boolean(asked.look) && !refused;
        reply.finish(parsed.text, editing || looking || Boolean(parsed.error));
        if (res.text && !refused) {
          const said = { role: 'assistant', content: res.text };
          kept.push(said);
          sent.push(said);
        }
        if (res.picturesRefused) {
          // The provider turned the pictures down and was sent the words: that is what this turn holds from now on.
          sent.forEach((m, i) => { if (Array.isArray(m.content)) { m.content = m.alt; kept[i].content = m.alt; } });
          reply.note('This model would not take pictures of the page, so Lagrange was given the page in words instead.', 'is-quiet');
        }
        if (editing) {
          const run = await this.plugin.applyChatEdits(target, note, parsed, reply, controller.signal);
          if (run) { ran = run; typed = typed || Boolean(run.touched); }
        } else if (parsed.error) {
          reply.note(`Lagrange meant to edit the note, but its edits could not be read. ${parsed.error}` +
            `${res.stopReason === 'max_tokens' ? ' (The reply reached its length limit.)' : ''} Nothing was changed; ask again.`, 'is-warn');
        }
        if (refused) {
          const cat = res.stopDetails && res.stopDetails.category;
          reply.note(`Claude declined to continue${cat ? ` (${cat})` : ''}. Try rephrasing the question.`, 'is-warn');
        } else if (res.stopReason === 'max_tokens') {
          reply.note('The reply reached its length limit.', 'is-quiet');
        }
        if (res.fallbackTo) reply.note(`Answered by ${res.fallbackTo} after a refusal.`, 'is-quiet');
        if (!looking || controller.signal.aborted) break;
        if (looksLeft <= 0) {
          reply.note(`Lagrange asked to look at the page again, but ${LOOKS_PER_MESSAGE} looks for one message is the limit.`, 'is-quiet');
          break;
        }
        // The look: the page is set and shown to the model in a message of its own, and the turn goes on. If it
        // cannot be set, the model is told so, and answers from the source.
        looksLeft--;
        const entry = this.addLook();
        let look = null, problem = '';
        try {
          look = await this.plugin.lookAtPage(target, asked.look, { signal: controller.signal, path: note.path });
          entry.done(look);
          lastLook = look;
        } catch (err) {
          if (isAbort(err)) { entry.remove(); throw err; }
          if (!(err instanceof LagrangeError)) console.error('Lagrange', err);
          problem = err.message || String(err);
          entry.fail(problem);
        }
        const carried = lookMessage(look, { left: looksLeft, failed: problem });
        kept.push({ role: 'user', content: carried.kept });
        sent.push({ role: 'user', content: carried.content, alt: carried.alt });
        // (the pen may have written since the note was read: the next reply is given it as it stands)
        if (editing) {
          note = this.plugin.noteFrom(target) || note;
          clip = clipText(note.text, limit, note.cursor);
        }
      }
    } catch (err) {
      if (isAbort(err)) {
        // Stopped mid-reply: what was said stays; edits that had not finished arriving are not made.
        if (streaming) {
          reply.finish(partial);
          if (partial) kept.push({ role: 'assistant', content: partial });
        }
        reply.note(streaming && raw !== partial && splitAgentReply(raw).blocks.length ? 'Stopped before any edit was made.' : 'Stopped.', 'is-quiet');
      } else {
        failed = true;
        if (streaming) {
          reply.finish(partial);
          if (!partial) reply.el.remove();
        }
        this.addError(err);
        if (!this.inputEl.value) { this.inputEl.value = text; this.fitInput(); }
      }
    } finally {
      this.setPending(null);
      // The conversation takes in the turn up to Lagrange's last words. A turn that failed is left out (the message
      // is back in the box, to be sent again) unless the pen has written; so is one that was cleared away meanwhile.
      if (this.checkpoints.includes(checkpoint) && !(failed && !ran)) {
        while (kept.length && kept[kept.length - 1].role !== 'assistant') kept.pop();
        this.history.push(...kept);
      }
      // What the turn left in the note, so a later rewind can tell Lagrange's changes from the writer's; then the
      // oldest checkpoints give up their copies of the note.
      if (checkpoint.path && this.checkpoints.includes(checkpoint)) {
        try {
          // (what the last run itself left, if there was one: a key that ended the run has changed the note since)
          const now = ran && ran.docAfter ? ran.docAfter.toString() : await this.plugin.noteText(checkpoint.path);
          checkpoint.after = now === null || now === checkpoint.before ? null : now;
          checkpoint.userTyped = typed;
        } catch (e) { /* the note is gone: nothing to remember */ }
      }
      for (const cp of pruneCheckpoints(this.checkpoints, CHECKPOINTS_KEPT, CHECKPOINT_CHARS)) this.labelRewind(cp);
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
      // onUndo is the run's record (see the plugin's recordEdit): the button undoes it, then offers to redo it.
      const record = onUndo;
      const b = el.createEl('button', { cls: 'lagrange-undo' });
      const show = () => {
        b.setText(!record.undone ? 'Undo Lagrange’s edits' : record.redo ? 'Redo Lagrange’s edits' : 'Edits undone');
        b.disabled = Boolean(record.undone && !record.redo);
      };
      record.listeners.push(show);
      show();
      b.addEventListener('click', () => { if (record.undone) this.plugin.redoEdit(record); else this.plugin.undoEdit(record); });
    }
    this.scrollDown();
  }
}

/* Asks, before a rewind, what to do with a note that has changed since: resolves 'restore', 'keep' or null. */
class RewindModal extends Modal {
  ask() {
    return new Promise(resolve => { this.resolve = resolve; this.open(); });
  }

  onOpen() {
    this.modalEl.addClass('lagrange-modal');
    this.titleEl.setText('Rewind to here');
    this.contentEl.createEl('p', {
      text: 'The note has changes that are not Lagrange’s since this message. Put the note back as it was then (your ' +
        'later changes go, though Undo in the editor brings them back), or rewind the conversation only and keep the ' +
        'note as it is?',
    });
    const row = this.contentEl.createDiv({ cls: 'lagrange-modal-buttons' });
    const pick = (text, value, cls) => {
      const b = row.createEl('button', { text, cls: cls || '' });
      b.addEventListener('click', () => { this.choice = value; this.close(); });
      return b;
    };
    pick('Cancel', null);
    pick('Put the note back', 'restore');
    const keep = pick('Keep the note as it is', 'keep', 'mod-cta');
    window.setTimeout(() => keep.focus(), 0);
  }

  onClose() {
    this.contentEl.empty();
    if (this.resolve) { this.resolve(this.choice || null); this.resolve = null; }
  }
}

/* What Lagrange was shown in a look: the pictures as they were sent, and the page in words. */
class LookModal extends Modal {
  constructor(app, look, recipient) {
    super(app);
    this.look = look;
    this.recipient = recipient;
  }

  onOpen() {
    this.modalEl.addClass('lagrange-modal', 'lagrange-look-modal');
    this.titleEl.setText('What Lagrange was shown');
    const { contentEl, look } = this;
    contentEl.createEl('p', {
      cls: 'lagrange-modal-note',
      text: `${lookCaption(look)}: “${look.title}”, as Reading view renders it, without the note’s properties. ${this.recipient}`,
    });
    look.pictures.forEach((p, i) => {
      contentEl.createEl('img', { cls: 'lagrange-look-picture', attr: { src: `data:${p.mediaType};base64,${p.data}`, alt: `The page, picture ${i + 1} of ${look.pictures.length}` } });
    });
    const words = contentEl.createEl('details', { cls: 'lagrange-look-told' });
    if (!look.pictures.length) words.setAttribute('open', '');
    words.createEl('summary', { text: 'The page in words, as Lagrange was told it' });
    words.createEl('pre', { text: look.description });
  }

  onClose() {
    this.contentEl.empty();
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

/* "Lagrange: Draw a drop cap": the letter, what it should look like, and the set it goes into. */
class DropcapDrawModal extends Modal {
  constructor(plugin, view, known) {
    super(plugin.app);
    this.plugin = plugin;
    this.view = view;
    this.known = known;     // {letter, sets: [{name, letters: {T: 'png' | 'svg'}}]}: the writer's sets Lagrange could add to
  }

  onOpen() {
    this.modalEl.addClass('lagrange-modal');
    this.titleEl.setText('Draw a drop cap');
    const { contentEl } = this;
    const s = this.plugin.settings;
    contentEl.createEl('p', { cls: 'lagrange-modal-note', text: dropcapRouteNote(s) });
    const row = contentEl.createDiv({ cls: 'lagrange-dropcap-row' });
    const letter = row.createEl('input', { type: 'text', cls: 'lagrange-dropcap-letter', attr: { maxlength: '1', 'aria-label': 'Letter', placeholder: 'A' } });
    letter.value = this.known.letter || '';
    const set = row.createEl('input', { type: 'text', cls: 'lagrange-dropcap-set', attr: { 'aria-label': 'Set of drop caps', placeholder: 'Set', list: 'lagrange-dropcap-sets' } });
    set.value = (this.known.sets[0] && this.known.sets[0].name) || 'Lagrange';
    const names = contentEl.createEl('datalist', { attr: { id: 'lagrange-dropcap-sets' } });
    for (const k of this.known.sets) names.createEl('option', { attr: { value: k.name } });
    const input = contentEl.createEl('textarea', {
      cls: 'lagrange-modal-input',
      attr: { rows: '2', placeholder: 'What should it look like? For example: a woodcut initial with vine leaves; an Art Nouveau letter with irises', 'aria-label': 'Description' },
    });
    const monoRow = contentEl.createEl('label', { cls: 'lagrange-dropcap-check' });
    const mono = monoRow.createEl('input', { type: 'checkbox' });
    mono.checked = true;
    monoRow.appendText(' One colour: ink only, printed in the page’s accent colour in the light and the dark theme');
    const changeRow = contentEl.createEl('label', { cls: 'lagrange-dropcap-check' });
    const change = changeRow.createEl('input', { type: 'checkbox' });
    changeRow.appendText(' Change the one this set has for this letter (the description says how), rather than draw afresh');
    const present = () => {
      const k = this.known.sets.find(x => x.name.toLowerCase() === set.value.trim().toLowerCase());
      return k ? k.letters[dropcapLetter(letter.value)] : null;
    };
    const refresh = () => { const has = Boolean(present()); changeRow.style.display = has ? '' : 'none'; if (!has) change.checked = false; };
    letter.addEventListener('input', refresh);
    set.addEventListener('input', refresh);
    refresh();
    const said = contentEl.createEl('p', { cls: 'lagrange-modal-problem' });
    const buttons = contentEl.createDiv({ cls: 'lagrange-modal-buttons' });
    const cancel = buttons.createEl('button', { text: 'Cancel' });
    const go = buttons.createEl('button', { cls: 'mod-cta', text: 'Draw' });
    const submit = () => {
      const l = dropcapLetter(letter.value);
      if (!l) { said.setText('Give one letter, A to Z.'); letter.focus(); return; }
      if (!set.value.trim()) { said.setText('Name the set it goes into.'); set.focus(); return; }
      if (change.checked && !input.value.trim()) { said.setText('Say how it should change.'); input.focus(); return; }
      this.close();
      void this.plugin.drawDropcap(this.view, { letter: l, set: set.value.trim(), style: change.checked ? '' : input.value.trim(), mono: mono.checked, change: change.checked ? input.value.trim() : '' });
    };
    input.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); submit(); }
    });
    go.addEventListener('click', submit);
    cancel.addEventListener('click', () => this.close());
    window.setTimeout(() => (letter.value ? input : letter).focus(), 0);
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
      text: 'Lagrange sends the open note and your messages (and, when it looks at the page, pictures of the note as ' +
        'it is rendered) to the provider chosen here, and only when you ask it something or run one of its commands. ' +
        'It makes no other network requests and collects nothing.',
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
      new Setting(containerEl)
        .setName('Image model')
        .setDesc('The model that paints for “Draw a drop cap”, through the Images API (OpenAI charges for each image). Experimental: not yet tried against the live API.')
        .addText(t => t.setPlaceholder(DEFAULT_SETTINGS.openaiImageModel).setValue(s.openaiImageModel)
          .onChange(async v => { s.openaiImageModel = v.trim() || DEFAULT_SETTINGS.openaiImageModel; await save(); }));
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

    new Setting(containerEl).setName('Looking at the page').setHeading();
    new Setting(containerEl)
      .setName('Let Lagrange look at the rendered page')
      .setDesc('Lagrange reads your note’s Markdown, not the page that is set from it. With this on, it can ask to look ' +
        'when a question turns on how the page looks (a drop cap, what is centred, the margin, an equation, a picture), ' +
        'and you can show it the page yourself with the command “Show Lagrange the rendered page”. The plugin then sets ' +
        'the note as Reading view would, out of sight, and sends pictures of the part asked for and nothing else (at ' +
        `most ${LOOK_PAGES} pictures a look and ${LOOKS_PER_MESSAGE} looks a message), with its measurements, to the provider chosen above ` +
        'and to no one else. It does so only while Lagrange is answering a message of yours; the chat shows every ' +
        'look, and you can open what was sent. Off: the page is never rendered or captured.')
      .addToggle(t => t.setValue(s.lookAtPage).onChange(async v => { s.lookAtPage = v; await save(true); }));
    const desktop = !(obsidian.Platform && obsidian.Platform.isDesktopApp === false);
    new Setting(containerEl)
      .setName('Pictures of the page')
      .setDesc((!desktop ? 'On a phone or tablet no picture is taken: Lagrange is told about the page in words.'
        : s.provider === 'demo' ? 'The demo has no model to show a picture to: it reports what was measured on the page.'
          : picturesSupported(s) ? 'The model chosen takes pictures.'
            : 'The model chosen is not known to take pictures, so Lagrange is told about the page in words (each block’s ' +
              'alignment, font, lines, drop cap, footnotes, and what is too wide). If it does take them, choose “Always”.') +
        ' A model that turns pictures down is sent the words instead.')
      .addDropdown(d => d.addOption('auto', 'Where the model takes them').addOption('on', 'Always').addOption('off', 'Never: words only')
        .setValue(s.lookPictures).onChange(async v => { s.lookPictures = v; await save(); }))
      .setDisabled(!s.lookAtPage || !desktop);

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
    // (a slider's value is shown beside it, not in a bubble over it)
    const valued = (setting, value, show) => {
      const el = setting.controlEl.createSpan({ cls: 'lagrange-slider-value', text: show(value) });
      return v => el.setText(show(v));
    };
    const speed = new Setting(containerEl)
      .setName('Pen speed')
      .setDesc('From unhurried (0.5) to brisk (3).');
    const showSpeed = valued(speed, s.penSpeed, v => `${v}×`);
    speed.addSlider(sl => sl.setLimits(0.5, 3, 0.25).setValue(s.penSpeed)
      .onChange(async v => { s.penSpeed = v; showSpeed(v); await save(); }))
      .setDisabled(!s.showPen);
    const lines = new Setting(containerEl)
      .setName('Lines the pen writes')
      .setDesc('A long edit is written out for this many lines of the page, then the rest is set down at once; a shorter ' +
        'edit is written in full. In a run of many edits, later ones get a single line once the writing (each pen’s own) has taken about ten seconds.');
    const showLines = valued(lines, s.penLines, v => String(v));
    lines.addSlider(sl => sl.setLimits(1, 8, 1).setValue(s.penLines)
      .onChange(async v => { s.penLines = v; showLines(v); await save(); }))
      .setDisabled(!s.showPen);
    new Setting(containerEl)
      .setName('Several pens at once')
      .setDesc('Edits that are in view together and stand well apart on the page are written at the same time, each by a ' +
        'pen of its own. Edits in one paragraph, or with fewer than three lines clear between them, are still written one after ' +
        'another, and so is everything in a column narrower than 440 px. Off: one pen writes every edit in turn. The note is the same in the end.')
      .addToggle(t => t.setValue(s.severalPens).onChange(async v => { s.severalPens = v; await save(true); }))
      .setDisabled(!s.showPen);
    const pens = new Setting(containerEl)
      .setName('Pens at most')
      .setDesc('How many pens may write at once. There is never more than one for about every 210 px of the editor’s height: three need a pane some 640 px high, a fourth one of 850.');
    const showPens = valued(pens, s.maxPens, v => String(v));
    pens.addSlider(sl => sl.setLimits(2, PEN_MAX, 1).setValue(s.maxPens)
      .onChange(async v => { s.maxPens = v; showPens(v); await save(); }))
      .setDisabled(!s.showPen || !s.severalPens);
    new Setting(containerEl)
      .setName('Let me edit while the pen writes')
      .setDesc('Off: a click in the note, or a key that would change it, ends the pen’s animation (every pen’s, if several ' +
        'are writing): the rest of its edits are set down at once, and then your click or key takes effect. On: the pen goes on writing while you edit ' +
        'elsewhere in the note; an edit whose words you have changed meanwhile is skipped, and the chat says so. ' +
        'Either way, Esc stops the pen, and scrolling never does.')
      .addToggle(t => t.setValue(s.editWhileWriting).onChange(async v => { s.editWhileWriting = v; await save(); }))
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
    this.session = { noFallback: false, noEffort: {}, noPictures: {} };
    this.editing = false;
    this.edits = [];       // Lagrange's runs of edits, oldest first (see recordEdit); at most EDIT_RECORDS
    this.editClock = 0;    // counts the runs, so a rewind knows which came after a checkpoint
    this.pen = createPen(this.app, this.settings);

    this.registerEditorExtension([
      runExtension(),
      this.pen.extension,
      EditorView.updateListener.of(update => this.trackEdits(update)),
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
    this.addCommand({
      id: 'draw-dropcap',
      name: 'Draw a drop cap (or change one)',
      checkCallback: checking => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view || !view.file) return false;
        if (!checking) void this.askDropcap(view);
        return true;
      },
    });
    this.addCommand({
      id: 'show-page',
      name: 'Show Lagrange the rendered page',
      checkCallback: checking => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view || !view.file) return false;
        if (!checking) void this.showPage(view);
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

  /* Lagrange's runs of edits, for Undo and Redo (the two buttons at the head of the chat, and the button under each
     run in the log). A record holds what is needed to take a run back and to make it again whatever has happened in
     the note since: {view, editor, path, clock, docBefore, docAfter, inverse, since, viaHistory, undone, redo,
     sinceUndo, redoStale, byHistory, undoneAt, listeners}. `since` is everything that has changed in the note after
     the run (kept up by trackEdits), so the run's inverse can be carried through later typing; once undone, `redo`
     is the change that makes the run again and `sinceUndo` what has changed since the undo. */
  recordEdit(cm, editor, path, result) {
    // The note has moved on: runs taken back before this one can no longer be made again.
    for (const r of this.edits) if (r.view === cm && r.undone && r.redo) { r.redo = null; this.announce(r); }
    const record = {
      view: cm, editor, path, clock: ++this.editClock, docBefore: result.docBefore, docAfter: result.docAfter || cm.state.doc,
      inverse: result.changes.invert(result.docBefore), since: ChangeSet.empty(cm.state.doc.length),
      viaHistory: false, undone: false, redo: null, sinceUndo: null, redoStale: false, byHistory: false, undoneAt: 0,
      expecting: null, listeners: [],
    };
    this.edits.push(record);
    while (this.edits.length > EDIT_RECORDS) this.edits.shift();
    this.announce(record);
    return record;
  }

  /* Tells the buttons that a record has changed. */
  announce(record) {
    for (const f of record.listeners) { try { f(); } catch (e) { /* a button that is gone */ } }
    const chat = this.chatView();
    if (chat) chat.refreshHistory();
  }

  /* Watches the editors where Lagrange has made edits. A change this plugin has just asked for (an undo or a redo of
     a run) completes that record; any other change is added to what has happened since. The editor's own undo and
     redo, used by the writer, make "carried through later typing" unreliable, which is remembered. */
  trackEdits(update) {
    if (!update.docChanged || !this.edits.length) return;
    const history = !this.ownHistory && update.transactions.some(tr => tr.docChanged && (tr.isUserEvent('undo') || tr.isUserEvent('redo')));
    let lost = null;
    for (const r of this.edits) {
      if (update.view !== r.view) continue;
      // A record that no longer fits the editor's text (another note was opened in the same tab: Obsidian puts a new
      // text in the editor without a change to follow) can be neither undone nor redone, and is forgotten.
      const kept = r.undone ? r.sinceUndo : r.since;
      if (kept && kept.newLength !== update.startState.doc.length) { (lost || (lost = [])).push(r); continue; }
      if (r.expecting === 'undo') {
        r.expecting = null;
        r.undone = true;
        r.undoneAt = ++this.editClock;
        r.redo = update.changes.invert(update.startState.doc);
        r.sinceUndo = ChangeSet.empty(update.state.doc.length);
        r.redoStale = false;
      } else if (r.expecting === 'redo') {
        r.expecting = null;
        r.undone = false;
        r.redo = null;
        r.docAfter = update.state.doc;
        r.inverse = update.changes.invert(update.startState.doc);
        r.since = ChangeSet.empty(update.state.doc.length);
        r.viaHistory = false;
      } else if (r.undone) {
        if (r.sinceUndo) r.sinceUndo = r.sinceUndo.compose(update.changes);
        if (history) r.redoStale = true;
      } else {
        r.since = r.since.compose(update.changes);
        if (history) r.viaHistory = true;
      }
    }
    if (lost) {
      this.edits = this.edits.filter(r => !lost.includes(r));
      for (const r of lost) { r.expecting = null; this.announce(r); }
    }
  }

  /* Undo one run of Lagrange's edits: the editor's own undo if nothing has happened since (so the editor's history
     stays in step); the inverse of the edits if the text is back as Lagrange left it; the inverse carried through
     later typing otherwise, which keeps what the writer typed and says so. After the writer has used the editor's
     undo or redo that last way isn't reliable, so it says to use Undo in the editor instead. */
  undoEdit(record) {
    const r = record;
    const stale = () => { new Notice('The note has changed since; use Undo in the editor instead.'); return false; };
    if (!r || r.undone || !this.edits.includes(r)) return stale();
    if (!r.view.dom.isConnected) { new Notice('That note is no longer open.'); return false; }
    const doc = r.view.state.doc;
    if (doc.eq(r.docBefore)) {
      new Notice('Those edits are already undone.');
      r.undone = true;
      r.undoneAt = ++this.editClock;
      r.redo = null;
      this.announce(r);
      return true;
    }
    let kept = false;
    r.expecting = 'undo';
    r.byHistory = false;
    this.ownHistory = true;
    try {
      if (r.since.empty && r.editor) { r.byHistory = true; r.editor.undo(); }
      else if (doc.eq(r.docAfter)) r.view.dispatch({ changes: r.inverse, userEvent: 'lagrange.undo' });
      else if (!r.viaHistory) { kept = true; r.view.dispatch({ changes: r.inverse.map(r.since), userEvent: 'lagrange.undo' }); }
    } finally {
      this.ownHistory = false;
    }
    if (r.expecting) { r.expecting = null; return stale(); }   // nothing changed: it could not be undone that way
    if (kept) new Notice('Lagrange’s edits were taken back; what you have typed since was kept.');
    this.announce(r);
    return true;
  }

  /* Redo a run that was undone, by the same three ways. */
  redoEdit(record) {
    const r = record;
    const stale = () => { new Notice('The note has changed since; those edits can’t be made again. Ask Lagrange once more.'); return false; };
    if (!r || !r.undone || !r.redo || !this.edits.includes(r)) return stale();
    if (!r.view.dom.isConnected) { new Notice('That note is no longer open.'); return false; }
    let kept = false;
    r.expecting = 'redo';
    this.ownHistory = true;
    try {
      if (r.sinceUndo.empty && r.byHistory && r.editor) r.editor.redo();
      else if (r.sinceUndo.empty) r.view.dispatch({ changes: r.redo, userEvent: 'lagrange.redo' });
      else if (!r.redoStale) { kept = true; r.view.dispatch({ changes: r.redo.map(r.sinceUndo), userEvent: 'lagrange.redo' }); }
    } finally {
      this.ownHistory = false;
    }
    if (r.expecting) { r.expecting = null; r.redo = null; this.announce(r); return stale(); }
    if (kept) new Notice('Lagrange’s edits were made again; what you have typed since was kept.');
    this.announce(r);
    return true;
  }

  /* The Markdown view showing a note, if one is open. */
  viewOf(path) {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      if (leaf.view instanceof MarkdownView && leaf.view.file && leaf.view.file.path === path) return leaf.view;
    }
    return null;
  }

  /* A note's text now: from its open editor (which may be ahead of the file), else from the file; null if it is gone. */
  async noteText(path) {
    const view = this.viewOf(path);
    if (view) return view.getViewData();
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file || typeof file.extension !== 'string') return null;
    return this.app.vault.cachedRead(file);
  }

  /* Puts a note back to `text` (a rewind): one change in its editor, which the editor's Undo takes back, or the file
     itself if the note isn't open for editing. Runs of edits made after `clock` no longer mean anything and go. */
  async restoreNote(path, text, clock) {
    const view = this.viewOf(path);
    const cm = view && view.getMode() === 'source' && view.editor && view.editor.cm;
    if (cm) {
      const change = spliceChange(cm.state.doc.toString(), text);
      if (change) cm.dispatch({ changes: change, userEvent: 'lagrange.rewind' });
    } else {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!file) throw new Error('the note is no longer in the vault');
      await this.app.vault.modify(file, text);
    }
    const gone = this.edits.filter(r => r.path === path && r.clock > clock);
    this.edits = this.edits.filter(r => !gone.includes(r));
    for (const r of gone) { r.undone = true; r.redo = null; this.announce(r); }
    const chat = this.chatView();
    if (chat) chat.refreshHistory();
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
    let result, record = null;
    if (!cm) {
      // No CodeMirror 6 view (should not happen in current Obsidian): apply everything at once through the Editor API.
      const ed = view.editor;
      ed.transaction({ changes: located.map(e => ({ from: ed.offsetToPos(e.from), to: ed.offsetToPos(e.to), text: e.replace })) });
      result = { applied: located, skipped: [] };
    } else {
      const concurrent = Boolean(this.settings.editWhileWriting);
      const writing = this.settings.showPen
        ? new Notice(concurrent ? 'Lagrange is writing… (Esc to stop)' : 'Lagrange is writing… (Esc to stop; click or type in the note to have it all at once)', 0)
        : null;
      try {
        // The run is recorded for Undo and Redo the moment it closes: a key press that ended it comes after.
        result = await runEdits(cm, located, {
          pen: this.settings.showPen ? this.pen : null, signal, concurrent,
          pens: this.settings.severalPens ? this.settings.maxPens : 1,
          onDone: res => { if (res.changes && !res.changes.empty) record = this.recordEdit(cm, view.editor, view.file ? view.file.path : null, res); },
        });
      } finally {
        if (writing) writing.hide();
      }
      if (result.failure) {
        this.pen.destroy();
        this.pen = createPen(this.app, this.settings);
      }
      if (this.app.workspace.getActiveViewOfType(MarkdownView) === view && !cm.hasFocus) cm.focus();
    }
    const skipped = skippedBefore.concat(result.skipped);
    if (cm && !record && result.applied.length && result.changes && !result.changes.empty) {
      record = this.recordEdit(cm, view.editor, view.file ? view.file.path : null, result);
    }
    const onUndo = record ? () => this.undoEdit(record) : null;
    if (task) task.report({ applied: result.applied, skipped }, record);
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
      return await this.applyEdits(view, located, skipped, task, signal);
    } catch (err) {
      this.reportFailure(err, task);
    } finally {
      this.editing = false;
    }
    return null;
  }

  chatView() {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    return leaf && leaf.view instanceof LagrangeChatView ? leaf.view : null;
  }

  /* Looks at a note's page for the chat (lookAtPage, section 7), with pictures where they can be taken and the
     provider takes them (lookSendsPictures). Nothing is rendered or captured with "Let Lagrange look at the rendered
     page" off. opts: {signal, path: the note the look is meant for, in case another has been opened in its pane}.
     Rejects with a reason, worded to follow "could not look at the page:". */
  async lookAtPage(view, spec, opts) {
    if (!this.settings.lookAtPage) throw new LagrangeError('looking at the page is turned off in Settings → Lagrange.', { kind: 'setup' });
    if (!view || !view.file || !view.containerEl.isConnected) throw new LagrangeError('the note is no longer open.');
    if (opts && opts.path && view.file.path !== opts.path) throw new LagrangeError('the note is no longer open in its pane.');
    if (this.looking) throw new LagrangeError('another look at the page is under way.');
    this.looking = true;
    try {
      const desktop = !(obsidian.Platform && obsidian.Platform.isDesktopApp === false);
      return await lookAtPage(this.app, view, spec, {
        signal: opts && opts.signal,
        pictures: lookSendsPictures(this.settings, desktop, this.session),
      });
    } finally {
      this.looking = false;
    }
  }

  /* "Show Lagrange the rendered page": the open note's page, kept in the chat to go with the next message. */
  async showPage(view) {
    if (!this.settings.lookAtPage) {
      new Notice('Looking at the page is turned off: Settings → Lagrange → “Let Lagrange look at the rendered page”.', 8000);
      return;
    }
    const chat = await this.activateView(false);
    if (!chat) return;
    await chat.showPage(view);
    if (chat.inputEl) chat.inputEl.focus();
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

  /* The Scriptorium plugin, which keeps the sets of drop caps and draws them; null if it is off. */
  scriptorium() {
    const p = this.app.plugins && this.app.plugins.plugins && this.app.plugins.plugins.scriptorium;
    return p && typeof p.addDrawnDropcap === 'function' ? p : null;
  }

  /* "Draw a drop cap": asks what to draw (DropcapDrawModal). */
  async askDropcap(view) {
    const scriptorium = this.scriptorium();
    if (!scriptorium) { new Notice('Drawing a drop cap needs the Scriptorium plugin (Settings → Community plugins), which keeps the drop caps.', 8000); return; }
    const adapter = this.app.vault.adapter, folder = 'Scriptorium/Drop caps';
    const known = { letter: '', sets: [] };
    // the letter the note's first chapter opens with
    const text = view.editor ? view.editor.getValue() : '';
    const body = text.replace(/^---\n[\s\S]*?\n---\n/, '');
    const first = body.split(/\n\s*\n/).map(p => p.trim()).find(p => p && !/^(#|>|!\[|```|\||[-*+] |\d+\. |---)/.test(p));
    known.letter = dropcapLetter(first || '');
    try {
      for (const dir of (await adapter.list(folder)).folders.sort()) {
        const letters = {};
        for (const f of (await adapter.list(dir)).files) {
          const m = f.slice(f.lastIndexOf('/') + 1).match(/^([A-Z])\.(png|svg)$/);
          if (m) letters[m[1]] = m[2];
        }
        known.sets.push({ name: dir.slice(dir.lastIndexOf('/') + 1), letters });
      }
    } catch (e) { /* no sets yet */ }
    known.sets.sort((a, b) => (b.name === 'Lagrange') - (a.name === 'Lagrange'));
    new DropcapDrawModal(this, view, known).open();
  }

  /* Has the provider draw (or change) the drop cap, hands it to Scriptorium, and sets it as the note's drop cap:
     Scriptorium inks it in. want: {letter, set, style, mono, change}. */
  async drawDropcap(view, want) {
    const scriptorium = this.scriptorium();
    if (!scriptorium || !view || !view.file) return;
    if (this.drawing) { new Notice('Lagrange is already drawing.'); return; }
    this.drawing = true;
    const chat = await this.activateView(false);
    const controller = new AbortController();
    const task = chat ? chat.beginTask(want.change ? 'Change a drop cap' : 'Draw a drop cap', `${want.letter}, in “${want.set}”`, controller) : null;
    try {
      const adapter = this.app.vault.adapter;
      let base = null;
      if (want.change) {
        for (const kind of ['png', 'svg']) {
          const path = `Scriptorium/Drop caps/${want.set}/${want.letter}.${kind}`;
          if (await adapter.exists(path)) { base = { bytes: new Uint8Array(await adapter.readBinary(path)), kind }; break; }
        }
        if (!base) throw new LagrangeError(`The set “${want.set}” has no ${want.letter} to change.`, { kind: 'setup' });
      }
      if (task) task.status(dropcapRoute(this.settings) === 'svg' ? 'Drawing…' : 'Painting… (a minute or so)');
      const drawn = await drawDropcap(this.settings, Object.assign({}, want, { base }), { signal: controller.signal }, this.session);
      let saved;
      try { saved = await scriptorium.addDrawnDropcap({ set: want.set, letter: want.letter, bytes: drawn.bytes, kind: drawn.kind, mono: want.mono }); }
      catch (e) { throw new LagrangeError(`The drawing could not be kept: ${e.message}.`, { reply: drawn.kind === 'svg' ? new TextDecoder().decode(drawn.bytes) : undefined }); }
      await scriptorium.setNoteDropcap(view.file, `set:${saved.set}`);
      // show it: where drop caps are drawn (Reading view; Live Preview too, with a Scriptorium that draws them there)
      try {
        const state = view.leaf.getViewState();
        const live = Boolean(scriptorium.dropcapLive) && state.state && state.state.mode === 'source' && !state.state.source;
        if (state.state && state.state.mode !== 'preview' && !live) { state.state.mode = 'preview'; await view.leaf.setViewState(state); }
      } catch (e) { /* stays in the editor */ }
      window.setTimeout(() => { try { scriptorium.previewDropcap(view, `set:${saved.set}`); } catch (e) { /* the view has gone */ } }, 350);
      if (task) task.done(`${want.change ? 'Changed' : 'Drawn'}: ${saved.file}. It is this note’s drop cap now (the “dropcap” property), wherever a chapter opens with ${want.letter}.`);
      else new Notice(`Lagrange drew the drop cap: ${saved.file}`);
    } catch (err) {
      this.reportFailure(err, task);
    } finally {
      this.drawing = false;
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
  rewindTo, userChangedSince, pruneCheckpoints, spliceChange, undoTarget, redoTarget, CHECKPOINTS_KEPT, CHECKPOINT_CHARS,
  splitAgentReply, parseAgentReply, locateOps, demoChatEdits, mathSegments, mathSource, looksLikeMath, hasMath, hasCode, typeCadence, penScript, renderPenMath, trailBands,
  equationPlan, repairJsonLatex, inkOffset, penLines, penPace, PEN_RUN_MS, wordCut, lineStarts, isEditKey, mapOffset, remapEdit, stickAfterScroll,
  penLanes, textLines, penRoom, penTargets, penWave, PEN_MAX, PEN_GAP_LINES, PEN_GAP_PX, PEN_LANE_PX, PEN_MIN_WIDTH, PEN_STAGGER_MS,
  createSSEParser, jsonValuesIn, parseEdits, findAll, looseFindAll, locateEdits, clipText, cleanRevision,
  parseErrorBody, describeError, noteStats, excerpt, demoProofreadEdits, demoRevise, demoChatReply,
  applyAnthropicEvent, applyOpenAIEvent, streamAnthropic, streamOpenAI, streamDemo, complete, fetchWithRetry,
  chatSystemPrompt, proofreadUserMessage, reviseUserMessage, runEdits, LagrangeError,
  transcriptPrompt, applyClaudeCodeLine, applyCodexLine, cliErrorMessage, findCli, runCli, runCliTakesEnv: true, streamClaudeCode, streamCodex, checkCli,
  LOOKS_PER_MESSAGE, LOOK_PAGES, LOOK_WIDTH, LOOK_HEIGHT, LOOK_DESCRIPTION_CHARS, LOOK_SOURCE_CHARS, LOOK_PICTURES, picturesSupported, providerKey, lookSendsPictures,
  splitBlocks, normalizeLook, parseLookReply, lookLabel, alignSections, lookSource, lookRange, lookScale, lookPages, describeLook, lookMessage, lookCaption, lookRecipient,
  messageText, messagePictures, withoutPictures, anthropicMessages, openaiMessages, claudeCodeInput, xmlSafe, pageSvg, cssUrls, demoLookReply, CHAT_LOOK,
  passageLines, headingLine, visibleLines, noteSections, renderPage, settlePage, measurePage, picturePage, lookAtPage,
  dropcapRoute, dropcapRouteNote, dropcapLetter, dropcapImagePrompt, dropcapSvgMessage, DROPCAP_SVG_SYSTEM, extractSvg, demoDropcapSvg,
  bytesFromBase64, base64FromBytes, isPng, drawOpenAIImage, drawCodexImage, drawSvg, drawDropcap,
};
Object.assign(LagrangePlugin.internals, { plainInline, workingText, foldEdit, chainSkipped, ALIGN_STYLE, ALIGN_MARK, PROOFREAD_SYSTEM, REVISE_SYSTEM, frameMarks });

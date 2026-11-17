// Lagrange's voice control, checked in a real Obsidian with a pretend microphone: navigator.mediaDevices.getUserMedia
// is replaced, for the run, by one that plays recorded speech (WAV files) into a MediaStream, phrase by phrase with
// pauses between, as a microphone would deliver it; the transcription service is the mock server
// (plugins-tests/mock-chat-server.mjs: POST /v1/audio/transcriptions, which records the WAV it is sent and answers
// with queued words), and so is the chat. Checked: voice control is off by default and then nothing shows and no
// microphone is opened; once on, the ribbon, the chat and the settings show it; dictation writes each phrase in at
// the cursor, joined to the text (spaces, capitals, never inside a word), one undo step a phrase, with a moment of
// rubric ink; what goes to the service is a 16 kHz mono WAV of the phrase; the commands said aloud (new paragraph,
// scratch that, stop listening, "Lagrange, …") work; speaking to Lagrange sends one message and closes the
// microphone; Esc stops (and drops what was being said when speaking to Lagrange); turning voice off closes the
// microphone; a refused microphone, a missing one, a missing key, a server that fails or cannot be reached are said
// in plain words; the status bar says Listening… and Transcribing… and its meter moves; "Test the microphone" says
// what it heard. With window.voiceOptions.whisper (the address of a real OpenAI-compatible Whisper server), one more
// case transcribes the recorded speech for real.
//
// This cannot run under Node (it needs Obsidian, its editor and Web Audio), so it is not part of `node --test`.
// To run it:
//   1. start the mock server:  node plugins-tests/mock-chat-server.mjs 48914
//   2. make the recordings (any speech will do; their names are used below): river, boats, paragraph, scratch, stop,
//      ask, talk, long (.wav, in one folder);
//   3. open a Scriptorium vault in Obsidian (desktop: the harness reads the recordings with Node's fs), with Lagrange on;
//   4. set window.voiceOptions = {server: 'http://127.0.0.1:48914', audio: '<the folder>', only, whisper}, then
//      evaluate this file with Runtime.evaluate (awaitPromise: true), or paste it into the developer console.
// It answers with a JSON string {ok, failed, cases: [{name, ok, why}], info} and puts the settings, the note and
// getUserMedia back afterwards. Only the mock server (and the Whisper server, if given) is spoken to.
//
// Copyright (C) 2026 William Liaw. GNU General Public License, version 3 or later (see LICENSE).
(async () => {
  const opt = window.voiceOptions || {};
  const server = String(opt.server || 'http://127.0.0.1:48914').replace(/\/+$/, '');
  const AUDIO = String(opt.audio || '');
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const until = async (fn, ms) => { for (const t0 = Date.now(); Date.now() - t0 < ms;) { if (fn()) return true; await sleep(50); } return Boolean(fn()); };
  const plugin = app.plugins.plugins.lagrange;
  const I = plugin.constructor.internals;
  const fs = require('fs');
  const cases = [], info = [];
  const want = name => !opt.only || name.includes(opt.only);
  const check = async (name, fn) => {
    if (!want(name)) return;
    document.querySelectorAll('.notice').forEach(n => n.remove());
    let ok = false, why = '';
    try { const r = await fn(); ok = r === true || (r && r.ok); why = r && r.why ? r.why : ok ? '' : String(r); } catch (e) { why = `threw: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`; }
    try { if (plugin.voice) await plugin.stopVoice(false); } catch (e) { /* the next case starts clean */ }
    cases.push({ name, ok, why });
  };
  const fail = why => ({ ok: false, why });
  const notices = () => Array.from(document.querySelectorAll('.notice')).map(n => n.textContent);

  // ---- the mock server ----
  const post = async (path, body) => { const r = await fetch(`${server}${path}`, { method: 'POST', body: JSON.stringify(body) }); if (!r.ok) throw new Error(`mock ${path}: ${r.status}`); };
  const heard = texts => post('/__audio_queue', texts.map(t => (typeof t === 'string' ? { text: t, delay: 500 } : t)));
  const audioSeen = async () => (await fetch(`${server}/__audio_requests`)).json();
  const replies = texts => post('/__queue', texts.map(t => ({ text: t, chunk: 40, delay: 4, first: 150 })));
  const chatSeen = async () => (await fetch(`${server}/__requests`)).json();

  // ---- the pretend microphone ----
  const realGum = navigator.mediaDevices.getUserMedia;
  const mic = { calls: 0, live: 0, plays: null };
  const fake = new AudioContext();
  const buffers = {};
  const load = async name => {
    if (!buffers[name]) {
      const bytes = fs.readFileSync(`${AUDIO}/${name}.wav`);
      buffers[name] = await fake.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    }
    return buffers[name];
  };
  // a microphone that delivers `seq` ([{wav: name} | {silence: seconds}]) from the moment it is opened, then silence;
  // noise: a faint hiss under it all (rms), as a real room has
  const fakeMic = async (seq, noise) => {
    for (const s of seq) if (s.wav) await load(s.wav);
    if (fake.state === 'suspended') await fake.resume();
    navigator.mediaDevices.getUserMedia = async () => {
      mic.calls++;
      const dest = fake.createMediaStreamDestination();
      let t = fake.currentTime + 0.25;
      const start = t;
      mic.plays = [];
      for (const s of seq) {
        if (s.silence) { t += s.silence; continue; }
        const src = fake.createBufferSource();
        src.buffer = buffers[s.wav];
        src.connect(dest);
        src.start(t);
        mic.plays.push({ wav: s.wav, at: t - start, seconds: src.buffer.duration });
        t += src.buffer.duration;
      }
      if (noise) {
        const n = fake.createBuffer(1, fake.sampleRate, fake.sampleRate), d = n.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * noise * Math.sqrt(3);
        const src = fake.createBufferSource();
        src.buffer = n; src.loop = true; src.connect(dest); src.start();
      }
      mic.endsIn = (t - fake.currentTime) * 1000;
      const stream = dest.stream;
      for (const tr of stream.getTracks()) {
        mic.live++;
        const stop = tr.stop.bind(tr);
        tr.stop = () => { if (tr.readyState !== 'ended') mic.live--; stop(); };
      }
      return stream;
    };
  };
  const refusingMic = name => { navigator.mediaDevices.getUserMedia = async () => { mic.calls++; throw new DOMException('pretend', name); }; };

  // ---- the note ----
  const saved = Object.assign({}, plugin.settings);
  const NOTE = 'Voice harness.md';
  const ORIGINAL = '# Voice\n\nThe day began.\n\nSecond paragraph here.\n';
  let file = app.vault.getAbstractFileByPath(NOTE);
  if (!file) file = await app.vault.create(NOTE, ORIGINAL);
  else await app.vault.modify(file, ORIGINAL);
  const leaf = app.workspace.getLeaf(false);
  await leaf.openFile(file, { state: { mode: 'source', source: false } });
  await sleep(400);
  const view = () => (leaf.view && leaf.view.getViewType() === 'markdown' ? leaf.view : null);
  const cm = () => view().editor.cm;
  const text = () => cm().state.doc.toString();
  const reset = async (content, cursorAfter) => {
    cm().dispatch({ changes: { from: 0, to: cm().state.doc.length, insert: content } });
    // a fresh undo history for each case: replace the editor's text through the view's own data
    view().setViewData(content, true);
    await sleep(150);
    const at = cursorAfter == null ? content.length : content.indexOf(cursorAfter) + cursorAfter.length;
    cm().dispatch({ selection: { anchor: at } });
    app.workspace.setActiveLeaf(leaf, { focus: false });
  };
  const configure = patch => Object.assign(plugin.settings, {
    voice: true, voiceRoute: 'server', voiceServerUrl: `${server}/v1`, voiceServerKey: '', voiceModel: '', voiceLanguage: 'en', voicePause: 0.6,
    provider: 'openai', openaiBaseUrl: `${server}/v1`, openaiModel: 'llava-mock', openaiApiKey: '', agenticEdits: false,
  }, patch || {});
  const bar = () => plugin.voiceBar;
  const watchBar = () => {
    const seen = new Set(), levels = [];
    const t = setInterval(() => {
      if (bar().isShown()) seen.add(bar().textContent);
      levels.push(Number(bar().style.getPropertyValue('--lagrange-level')) || 0);
    }, 40);
    return { seen, levels, stop: () => clearInterval(t) };
  };
  const chat = () => app.workspace.getLeavesOfType('lagrange-chat')[0] && app.workspace.getLeavesOfType('lagrange-chat')[0].view;
  const idle = () => !plugin.voice;

  // ---------- off by default ----------
  await check('off by default: the shipped setting is off, nothing shows, the commands are not offered, no microphone opens', async () => {
    // (that the shipped data.json is the defaults is checked under Node, in lagrange.test.js)
    if (saved.voice !== false) return fail(`the vault's settings had voice=${saved.voice}`);
    if (I.sanitizeSettings({}).voice !== false || I.DEFAULT_SETTINGS.voice !== false) return fail('default is on');
    Object.assign(plugin.settings, saved, { voice: false });
    plugin.refreshVoice();
    await plugin.activateView(false);
    await sleep(200);
    if (plugin.voiceRibbon.isShown()) return fail('the ribbon microphone shows');
    const micBtn = chat().micEl;
    if (micBtn.isShown()) return fail('the chat microphone shows');
    if (bar().isShown()) return fail('the status bar shows');
    const cmds = ['lagrange:voice-dictate', 'lagrange:voice-talk', 'lagrange:voice-stop'].map(id => app.commands.findCommand(id));
    if (cmds.some(c => !c)) return fail('a command is missing');
    if (cmds.some(c => c.checkCallback(true))) return fail('a voice command is offered while voice is off');
    await fakeMic([{ wav: 'river' }]);
    mic.calls = 0;
    await plugin.startVoice('dictate');
    if (mic.calls) return fail('the microphone was opened');
    if (plugin.voice) return fail('listening began');
    return { ok: true, why: notices().join(' | ').slice(0, 120) };
  });

  // ---------- on ----------
  await check('turned on: the ribbon and chat microphones show; the settings show the Voice section and say Claude cannot transcribe', async () => {
    configure();
    await plugin.saveSettings();
    if (!plugin.voiceRibbon.isShown()) return fail('ribbon hidden');
    if (!chat().micEl.isShown()) return fail('chat mic hidden');
    if (!app.commands.findCommand('lagrange:voice-dictate').checkCallback(true)) return fail('dictate command not offered');
    if (app.commands.findCommand('lagrange:voice-stop').checkCallback(true)) return fail('stop is offered while not listening');
    app.setting.open();
    app.setting.openTabById('lagrange');
    await sleep(400);
    const t = app.setting.activeTab.containerEl.textContent;
    app.setting.close();
    for (const w of ['Voice control', 'Transcription', 'Server address', 'Test the microphone', 'the Claude API takes no sound', 'new paragraph']) {
      if (!t.includes(w)) return fail(`settings lack “${w}”`);
    }
    return true;
  });

  // ---------- dictation ----------
  await check('dictation: two phrases go in at the cursor, joined (space, capital), each its own undo step; the service gets 16 kHz mono WAVs', async () => {
    configure();
    await reset(ORIGINAL, 'The day began.');
    await heard(['the river was quiet in the morning.', 'It carried the boats down to the sea.']);
    await fakeMic([{ wav: 'river' }, { silence: 1.3 }, { wav: 'boats' }, { silence: 1.3 }], 0.002);
    const w = watchBar();
    const l = await plugin.startVoice('dictate');
    if (!l) return fail(`did not start: ${notices().join(' | ')}`);
    let inkSeen = false;
    const inkWatch = setInterval(() => { if (cm().contentDOM.querySelector('.lagrange-voice-ink')) inkSeen = true; }, 30);
    const ribbonOn = plugin.voiceRibbon.hasClass('is-listening');
    await until(() => text().includes('down to the sea.'), 20000);
    await sleep(300);
    const listening = Boolean(plugin.voice) && mic.live > 0;
    await plugin.stopVoice(true);
    clearInterval(inkWatch);
    w.stop();
    const want = '# Voice\n\nThe day began. The river was quiet in the morning. It carried the boats down to the sea.\n\nSecond paragraph here.\n';
    if (text() !== want) return fail(`text: ${JSON.stringify(text())}`);
    if (!listening) return fail('it stopped listening between phrases');
    if (mic.live) return fail('the microphone was left open');
    if (!ribbonOn) return fail('the ribbon did not show listening');
    if (plugin.voiceRibbon.hasClass('is-listening') || bar().isShown()) return fail('still shown as listening after stop');
    if (!inkSeen) return fail('no ink on the dictated words');
    const words = Array.from(w.seen);
    if (!words.some(x => /Listening…/.test(x)) || !words.some(x => /Transcribing…/.test(x))) return fail(`status bar said: ${words.join(' / ')}`);
    if (Math.max(...w.levels) < 0.05) return fail(`the meter did not move (${Math.max(...w.levels)})`);
    const got = await audioSeen();
    if (got.length !== 2) return fail(`${got.length} transcription requests`);
    for (const [i, g] of got.entries()) {
      const play = mic.plays[i];
      if (!g.wav || g.wav.rate !== 16000 || g.wav.channels !== 1 || g.wav.bits !== 16) return fail(`request ${i}: ${JSON.stringify(g.wav)}`);
      if (g.file.type !== 'audio/wav' || g.fields.model !== 'whisper-1' || g.fields.language !== 'en' || g.fields.response_format !== 'json') return fail(`request ${i} fields ${JSON.stringify(g.fields)} ${JSON.stringify(g.file)}`);
      if (Math.abs(g.wav.seconds - play.seconds) > 0.75) return fail(`phrase ${i}: ${g.wav.seconds.toFixed(2)} s sent for ${play.seconds.toFixed(2)} s said`);
      if (g.wav.rms < 0.01) return fail(`phrase ${i} is silent (${g.wav.rms})`);
      info.push(`phrase ${i}: said ${play.seconds.toFixed(2)} s, sent ${g.wav.seconds.toFixed(2)} s, rms ${g.wav.rms.toFixed(3)}`);
    }
    view().editor.undo();
    const once = text();
    view().editor.undo();
    const twice = text();
    if (once !== '# Voice\n\nThe day began. The river was quiet in the morning.\n\nSecond paragraph here.\n') return fail(`after one undo: ${JSON.stringify(once)}`);
    if (twice !== ORIGINAL) return fail(`after two undos: ${JSON.stringify(twice)}`);
    return { ok: true, why: `status bar: ${words.join(' / ')}` };
  });

  await check('dictation never goes into the middle of a word: the cursor inside “began” writes after it', async () => {
    configure();
    await reset(ORIGINAL, 'The day beg');
    await heard(['And then it rained.']);
    await fakeMic([{ wav: 'river' }, { silence: 1.2 }]);
    await plugin.startVoice('dictate');
    await until(() => text().includes('rained'), 15000);
    await plugin.stopVoice(true);
    // (after the word, before its full stop: the phrase's own full stop is dropped there)
    return text() === '# Voice\n\nThe day began and then it rained.\n\nSecond paragraph here.\n' || fail(JSON.stringify(text()));
  });

  await check('commands said aloud: new paragraph, scratch that, stop listening (the microphone closes by itself)', async () => {
    configure();
    await reset(ORIGINAL, 'The day began.');
    await heard(['New paragraph.', 'The river was quiet.', 'Scratch that.', 'It carried the boats.', 'Stop listening.']);
    await fakeMic([{ wav: 'paragraph' }, { silence: 1.2 }, { wav: 'river' }, { silence: 1.2 }, { wav: 'scratch' }, { silence: 1.2 }, { wav: 'boats' }, { silence: 1.2 }, { wav: 'stop' }, { silence: 3 }]);
    await plugin.startVoice('dictate');
    const stopped = await until(idle, 30000);
    const want = '# Voice\n\nThe day began.\n\nIt carried the boats.\n\nSecond paragraph here.\n';
    if (!stopped) return fail('“stop listening” did not stop it');
    if (mic.live) return fail('the microphone was left open');
    if (text() !== want) return fail(JSON.stringify(text()));
    const got = await audioSeen();
    return got.length === 5 || fail(`${got.length} phrases sent`);
  });

  await check('“Lagrange, …” while dictating sends the rest to the chat, and dictation goes on', async () => {
    configure();
    await reset(ORIGINAL, 'The day began.');
    await replies(['A livelier opening, then.']);
    await heard(['Lagrange, make the first sentence more vivid.', 'It carried the boats.']);
    await fakeMic([{ wav: 'ask' }, { silence: 1.2 }, { wav: 'boats' }, { silence: 1.2 }]);
    const before = chat().logEl.querySelectorAll('.lagrange-turn--user').length;
    await plugin.startVoice('dictate');
    await until(() => text().includes('It carried the boats.'), 20000);
    await until(() => !chat().pending, 10000);
    await plugin.stopVoice(true);
    const sent = (await chatSeen()).map(r => JSON.stringify(r.messages || ''));
    if (!sent.some(m => m.includes('Make the first sentence more vivid.'))) return fail(`chat got: ${sent.join(' ').slice(0, 300)}`);
    if (chat().logEl.querySelectorAll('.lagrange-turn--user').length !== before + 1) return fail('no message in the chat');
    if (text().includes('Lagrange')) return fail('the command was written into the note');
    return text() === '# Voice\n\nThe day began. It carried the boats.\n\nSecond paragraph here.\n' || fail(JSON.stringify(text()));
  });

  await check('a phrase longer than thirty seconds is sent in two parts, one after the other, with nothing sent twice', async () => {
    configure({ voicePause: 2 });   // (the two recordings played end to end have half a second of quiet between them)
    await reset(ORIGINAL, 'The day began.');
    await heard(['First half', 'and the rest.']);
    await fakeMic([{ wav: 'long' }, { wav: 'long' }, { wav: 'river' }, { silence: 2.6 }]);
    await plugin.startVoice('dictate');
    await until(() => text().includes('the rest.'), 60000);
    await plugin.stopVoice(true);
    const got = await audioSeen();
    if (got.length !== 2) return fail(`${got.length} requests: ${got.map(g => g.wav && g.wav.seconds.toFixed(2)).join(', ')}`);
    const total = mic.plays.reduce((n, p) => n + p.seconds, 0), sent = got[0].wav.seconds + got[1].wav.seconds;
    info.push(`long phrase: said ${total.toFixed(2)} s, sent ${got.map(g => g.wav.seconds.toFixed(2)).join(' + ')} s`);
    if (Math.abs(got[0].wav.seconds - 30) > 0.4) return fail(`first part ${got[0].wav.seconds} s`);
    if (sent > total + 0.6) return fail(`sent ${sent.toFixed(2)} s of ${total.toFixed(2)} s: some sent twice`);
    return text() === '# Voice\n\nThe day began. First half and the rest.\n\nSecond paragraph here.\n' || fail(JSON.stringify(text()));
  });

  // ---------- speaking to Lagrange ----------
  await check('speak to Lagrange (the chat microphone): one phrase becomes a message, sent; the microphone then closes', async () => {
    configure();
    await reset(ORIGINAL);
    await replies(['I have read it.']);
    await heard(['please proofread the second paragraph.']);
    await fakeMic([{ wav: 'talk' }, { silence: 4 }]);
    const btn = chat().micEl;
    btn.click();
    await until(() => btn.hasClass('is-listening'), 3000);
    const lit = btn.hasClass('is-listening');
    const closed = await until(() => mic.live === 0 && idle(), 15000);
    await until(() => !chat().pending, 10000);
    if (!lit) return fail('the button did not show listening');
    if (!closed) return fail('still listening after the phrase');
    if (btn.hasClass('is-listening')) return fail('the button still shows listening');
    const users = Array.from(chat().logEl.querySelectorAll('.lagrange-turn--user')).map(n => n.textContent);
    if (!users.some(t => t.includes('Please proofread the second paragraph.'))) return fail(`chat: ${users.join(' | ').slice(0, 200)}`);
    const sent = (await chatSeen()).map(r => JSON.stringify(r.messages || ''));
    if (!sent.some(m => m.includes('Please proofread the second paragraph.'))) return fail('the server got no such message');
    return text() === ORIGINAL || fail('the note changed');
  });

  // ---------- stopping ----------
  await check('Esc while dictating stops at once, and what was being said is still written in', async () => {
    configure();
    await reset(ORIGINAL, 'The day began.');
    await heard(['The lighthouse keeper climbed the stairs.']);
    await fakeMic([{ wav: 'long' }]);
    await plugin.startVoice('dictate');
    await sleep(2600);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const closed = await until(() => mic.live === 0, 1000);
    await until(idle, 8000);
    const got = await audioSeen();
    if (!closed) return fail('the microphone stayed open after Esc');
    if (got.length !== 1) return fail(`${got.length} requests`);
    if (got[0].wav.seconds > 3.2 || got[0].wav.seconds < 1.2) return fail(`sent ${got[0].wav.seconds} s`);
    return text().includes('The day began. The lighthouse keeper climbed the stairs.') || fail(JSON.stringify(text()));
  });

  await check('Esc while speaking to Lagrange drops what was said: nothing is sent', async () => {
    configure();
    await reset(ORIGINAL);
    await heard(['This should never be sent.']);
    await fakeMic([{ wav: 'long' }]);
    const n = chat().logEl.querySelectorAll('.lagrange-turn--user').length;
    await plugin.startVoice('talk');
    await sleep(1800);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await until(idle, 5000);
    await sleep(800);
    if (mic.live) return fail('the microphone stayed open');
    if ((await audioSeen()).length) return fail('a phrase was sent to be transcribed');
    return chat().logEl.querySelectorAll('.lagrange-turn--user').length === n || fail('a message was sent');
  });

  await check('turning voice control off while listening closes the microphone and hides the controls', async () => {
    configure();
    await reset(ORIGINAL);
    await heard(['']);
    await fakeMic([{ silence: 20 }]);
    await plugin.startVoice('dictate');
    await until(() => mic.live > 0, 3000);
    plugin.settings.voice = false;
    await plugin.stopVoice(false);
    await plugin.saveSettings();
    if (mic.live) return fail('the microphone stayed open');
    return (!plugin.voiceRibbon.isShown() && !chat().micEl.isShown() && !bar().isShown()) || fail('controls still shown');
  });

  // ---------- errors ----------
  await check('a refused microphone is said in plain words (how to allow it), and nothing listens', async () => {
    configure();
    await reset(ORIGINAL);
    refusingMic('NotAllowedError');
    await plugin.startVoice('dictate');
    const n = notices().join(' | ');
    if (plugin.voice) return fail('still listening');
    return /not allowed to use the microphone/.test(n) || fail(n);
  });

  await check('no microphone at all is said in plain words', async () => {
    configure();
    await reset(ORIGINAL);
    refusingMic('NotFoundError');
    await plugin.startVoice('talk');
    const n = notices().join(' | ');
    return (/No microphone was found/.test(n) && !plugin.voice) || fail(n);
  });

  await check('OpenAI without a key: said before the microphone is opened', async () => {
    configure({ voiceRoute: 'openai', openaiPlatformKey: '' });
    await reset(ORIGINAL);
    await fakeMic([{ wav: 'river' }]);
    mic.calls = 0;
    await plugin.startVoice('dictate');
    const n = notices().join(' | ');
    if (mic.calls) return fail('the microphone was opened');
    return /OpenAI API key/.test(n) || fail(n);
  });

  await check('the server fails: the error is said, dictation keeps listening, the next phrase goes in', async () => {
    configure();
    await reset(ORIGINAL, 'The day began.');
    await heard([{ status: 400, error: 'audio too short', delay: 100 }, { text: 'It carried the boats.', delay: 100 }]);
    await fakeMic([{ wav: 'river' }, { silence: 1.2 }, { wav: 'boats' }, { silence: 1.2 }]);
    await plugin.startVoice('dictate');
    await until(() => text().includes('boats'), 20000);
    const n = notices().join(' | ');
    const still = Boolean(plugin.voice);
    await plugin.stopVoice(true);
    if (!/could not accept the request \(400\): audio too short/.test(n)) return fail(n);
    if (!still) return fail('dictation stopped after the error');
    return text() === '# Voice\n\nThe day began. It carried the boats.\n\nSecond paragraph here.\n' || fail(JSON.stringify(text()));
  });

  await check('the server cannot be reached: said in plain words', async () => {
    configure({ voiceServerUrl: 'http://127.0.0.1:9/v1' });
    await reset(ORIGINAL);
    await fakeMic([{ wav: 'river' }, { silence: 1.5 }]);
    await plugin.startVoice('dictate');
    await until(() => notices().some(n => /Could not reach the transcription server/.test(n)), 15000);
    const n = notices().join(' | ');
    await plugin.stopVoice(false);
    return /Could not reach the transcription server at 127\.0\.0\.1:9/.test(n) || fail(n);
  });

  // ---------- test the microphone ----------
  await check('“Test the microphone” says how loud it was and what it heard', async () => {
    configure();
    await heard(['The river was quiet in the morning.']);
    await fakeMic([{ wav: 'river' }, { silence: 1.5 }]);
    let said = '';
    await plugin.testVoice(t => { said = t; });
    if (mic.live) return fail('the microphone stayed open');
    return /The microphone works \(loudest -?\d+ dB\)\. Heard: “The river was quiet in the morning\.”/.test(said) || fail(said);
  });

  await check('“Test the microphone” with a silent microphone says so', async () => {
    configure();
    await heard(['']);
    await fakeMic([{ silence: 10 }]);
    let said = '';
    await plugin.testVoice(t => { said = t; });
    return /only silence/.test(said) || fail(said);
  });

  // ---------- a real Whisper ----------
  if (opt.whisper) {
    await check('end to end with a real Whisper server: the recorded speech is transcribed and dictated, commands included', async () => {
      configure({ voiceServerUrl: String(opt.whisper).replace(/\/+$/, ''), voiceModel: opt.whisperModel || '', voicePause: 0.8 });
      await reset(ORIGINAL, 'The day began.');
      await fakeMic([{ wav: 'river' }, { silence: 1.4 }, { wav: 'paragraph' }, { silence: 1.4 }, { wav: 'boats' }, { silence: 1.4 }, { wav: 'stop' }, { silence: 1.5 }], 0.002);
      const t0 = Date.now();
      await plugin.startVoice('dictate');
      const stopped = await until(idle, 120000);
      const got = text();
      info.push(`whisper: ${JSON.stringify(got)} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      if (!stopped) return fail(`did not stop by voice; text ${JSON.stringify(got)}; ${notices().join(' | ')}`);
      const body = got.slice(got.indexOf('The day began.'));
      const ok = /The day began\. The river was quiet in the morning\.\n\nIt carried the boats down to the sea\.\n\nSecond/i.test(body);
      return ok || fail(JSON.stringify(body));
    });
  }

  // ---- put everything back ----
  navigator.mediaDevices.getUserMedia = realGum;
  try { await fake.close(); } catch (e) { /* closed */ }
  Object.keys(plugin.settings).forEach(k => { if (!(k in saved)) delete plugin.settings[k]; });
  Object.assign(plugin.settings, saved);
  await plugin.saveSettings();
  try { await app.vault.modify(file, ORIGINAL); } catch (e) { /* kept */ }
  const failed = cases.filter(c => !c.ok).length;
  const out = { ok: failed === 0, failed, cases, info };
  console.table(cases);
  return JSON.stringify(out);
})()

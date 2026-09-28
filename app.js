// Human TPS: llama.cpp-style tokens/sec, except the inference engine is a human.
'use strict';

// ---------------------------------------------------------------------------
// Config: edit these links.
// ---------------------------------------------------------------------------
const CONFIG = {
  homoagensUrl: 'https://github.com/homoagens',           // "Powered by homoagens"
  githubUrl: 'https://github.com/homoagens/human-tps',                 // source repo
  supportUrl: '',                                                     // donation link (e.g. Ko-fi); '' = hidden
  siteUrl: 'https://homoagens.github.io/human-tps/', // public URL used in shares ('' = current page)
};

// ---------------------------------------------------------------------------
// Measurement tuning.
//
// Time is measured on an "active clock": the gap between two keystrokes counts
// as at most IDLE_CAP seconds. Short hesitations count normally; a longer
// break "pauses" the test, so walking away doesn't wreck your average.
//
// LIVE TPS is your recent typing speed: tokens gained over the last
// LIVE_WINDOW seconds of typing, measured up to your last keystroke, on a
// "live clock" where a real pause (> IDLE_CAP) takes no time at all, so after
// a break you pick up right where you left off. It only
// counts "committed" text (everything before the word you're still typing),
// because a half-typed word tokenizes differently than the finished one and
// would make the count wobble up and down.
// ---------------------------------------------------------------------------
const LIVE_WINDOW = 4;   // seconds of active time used for LIVE TPS
const IDLE_CAP = 2;      // a pause longer than this pauses the test and counts as only this
const MIN_SPAN = 1;      // denominator floor, so the very first keystroke isn't "90 TPS"
const TICK_MS = 100;     // UI refresh rate
const MAX_HIGHLIGHT = 20000; // chars; above this, skip per-token coloring to stay snappy
const TOKEN_COLORS = 5;  // number of alternating token colors (.t0 ... .t4 in style.css)

// ---------------------------------------------------------------------------
// "How do you compare to a machine?" Ballpark generation speeds, for fun only.
// Real numbers vary a lot with quantization, context length and hardware.
// ---------------------------------------------------------------------------
const MACHINES = [ // slowest first
  { tps: 0.5, name: 'a 7B model on a Raspberry Pi 4' },
  { tps: 1.5, name: 'a 70B model on a laptop CPU' },
  { tps: 3, name: 'a 7B model on a Raspberry Pi 5' },
  { tps: 20, name: 'a 3B model on a phone' },
];
const REFERENCE = { tps: 130, name: 'an 8B model on an RTX 4090' }; // the "real" llama.cpp speed
const COMPARE_AFTER = 3; // active seconds before the comparison appears

// Personal best: the best average TPS per tokenizer, stored only in this browser (localStorage).
const recordKey = () => (tok.name === 'o200k' ? 'human-tps:best' : `human-tps:best:${tok.name}`);
const MODE_KEY = 'human-tps:mode'; // remembers the selected mode

// Two modes. Base: just type, no technical choices (o200k tokenizer).
// llama.cpp ("pro"): a fake llama.cpp terminal where you pick the "model",
// i.e. which open-weight model's tokenizer counts your tokens.
const MODES = {
  base: { tokenizer: 'o200k' },
  llamacpp: { llama: true }, // tokenizer comes from LLAMA_MODELS
};
const DEFAULT_MODE = 'base';

// Models you can "load" in llama.cpp mode (all open-weight, all run on llama.cpp).
const LLAMA_MODELS = {
  qwen3: { name: 'Qwen3', file: 'qwen3', tokenizer: 'qwen3' },
  'gpt-oss': { name: 'gpt-oss', file: 'gpt-oss', tokenizer: 'o200k' }, // gpt-oss uses o200k (o200k_harmony)
  deepseek: { name: 'DeepSeek-R1', file: 'deepseek-r1', tokenizer: 'deepseek' },
  mistral: { name: 'Mistral Nemo', file: 'mistral-nemo', tokenizer: 'mistral' },
};
const DEFAULT_LLAMA_MODEL = 'qwen3';
const LLAMA_MODEL_KEY = 'human-tps:llama-model';
const RECORD_MIN_SECONDS = 10; // a test must be at least this long...
const RECORD_MIN_TOKENS = 20;  // ...and this many tokens to count as a record

const $ = (id) => document.getElementById(id);
const el = {
  tps: $('tps'), status: $('status'), input: $('input'), backdrop: $('backdrop'),
  avg: $('avg'), tokens: $('tokens'), time: $('time'), best: $('best'), compare: $('compare'),
  restart: $('restart'), share: $('share'), toast: $('toast'),
  modeSwitch: document.querySelectorAll('[data-mode]'), console: $('console'), llamaModel: $('llama-model'),
  tokInfo: $('tok-info'),
  dialog: $('share-dialog'), preview: $('share-preview'), copy: $('share-copy'),
};

// ---- State -----------------------------------------------------------------
let tokens = 0;          // exact token count of the whole text
let activeBase = 0;      // active seconds accumulated up to the last keystroke
let lastInputAt = null;  // performance.now() of last keystroke; null = not started
let liveBase = 0;        // live-clock seconds up to the last keystroke (pauses count as 0)
let samples = [];        // [{a: liveSeconds, n: committedTokens, c: committedText}] for the rolling window
let shownTps = 0;        // eased value displayed in the big number
let timer = null;
let tok = null;          // the active tokenizer (see tokenizer.js)
let mode = null;         // the active entry of MODES
let llamaModel = DEFAULT_LLAMA_MODEL; // the active entry of LLAMA_MODELS (llama.cpp mode)
const loadTimes = {};    // tokenizer name -> first load time in ms (shown in llama.cpp mode)
let best = 0;            // personal best average TPS for this tokenizer (0 = none yet)
let newRecord = false;   // did this test beat a previous personal best?
let wasPaused = false;

function reset() {
  tokens = 0; activeBase = 0; lastInputAt = null; liveBase = 0;
  samples = [{ a: 0, n: 0, c: '' }];
  shownTps = 0; newRecord = false;
  clearInterval(timer); timer = null;
  el.input.value = '';
  renderTokens([]);
  render(true);
}

// Committed-token count at active time t: the last sample taken at or before t.
function tokensAt(t) {
  let n = samples[0].n;
  for (const s of samples) { if (s.a <= t) n = s.n; else break; }
  return n;
}

// Text up to the end of the last finished word ("hello wor" -> "hello").
const committedText = (text) => text.slice(0, text.search(/\S*$/)).trimEnd();

// Time is counted up to the last keystroke; a gap only counts once you type
// again, so waiting at the end of a test doesn't drag your average down.
function stats(now = performance.now()) {
  const a = activeBase;
  const gained = samples[samples.length - 1].n - tokensAt(liveBase - LIVE_WINDOW);
  return {
    active: a,
    live: Math.max(0, gained / Math.max(Math.min(LIVE_WINDOW, liveBase), MIN_SPAN)), // no negative TPS from deleting
    avg: tokens / Math.max(a, MIN_SPAN),
    paused: lastInputAt !== null && now - lastInputAt > IDLE_CAP * 1000,
  };
}

function onInput() {
  const now = performance.now();
  const gap = lastInputAt === null ? 0 : (now - lastInputAt) / 1000; // first keystroke: 0
  activeBase += Math.min(gap, IDLE_CAP);
  if (gap <= IDLE_CAP) liveBase += gap;
  lastInputAt = now;
  wasPaused = false;

  const c = committedText(el.input.value);
  samples.push({ a: liveBase, n: tok.count(c), c });
  retokenize();

  // Drop samples we'll never look at again (keep one just before the window).
  const cutoff = liveBase - LIVE_WINDOW;
  while (samples.length > 1 && samples[1].a <= cutoff) samples.shift();

  if (!timer) timer = setInterval(() => render(), TICK_MS);
  render();
}

// Count and color the whole text with the active tokenizer.
function retokenize() {
  const text = el.input.value;
  const pieces = text.length <= MAX_HIGHLIGHT ? tok.pieces(text) : null;
  tokens = pieces ? pieces.length : tok.count(text);
  renderTokens(pieces);
}

// ---- Token highlighting ------------------------------------------------------
// A backdrop behind the (transparent) textarea mirrors the text with each token
// wrapped in a colored span, so you can see how the tokenizer splits your words.
function renderTokens(pieces) {
  const text = el.input.value;
  const frag = document.createDocumentFragment();
  if (pieces && pieces.join('') === text) {
    pieces.forEach((p, i) => {
      const span = document.createElement('span');
      span.className = 't' + (i % TOKEN_COLORS);
      span.textContent = p;
      frag.append(span);
    });
  } else {
    frag.append(text); // too long (or unexpected mismatch): plain text, no colors
  }
  frag.append('\u200b'); // lets a trailing newline take up a line, like in the textarea
  el.backdrop.replaceChildren(frag);
  syncBackdrop();
}

// Keep the backdrop exactly under the textarea's text area (size + scroll).
function syncBackdrop() {
  el.backdrop.style.width = el.input.clientWidth + 'px';   // excludes scrollbar
  el.backdrop.style.height = el.input.clientHeight + 'px';
  el.backdrop.scrollTop = el.input.scrollTop;
}

// ---- Rendering -------------------------------------------------------------
function render(instant = false) {
  const s = stats();
  // Subtle easing so the big number glides instead of jittering.
  shownTps = instant ? s.live : shownTps + (s.live - shownTps) * 0.35;
  if (Math.abs(shownTps - s.live) < 0.005) shownTps = s.live;

  el.tps.textContent = shownTps.toFixed(2);
  el.avg.textContent = s.avg.toFixed(2);
  el.tokens.textContent = tokens;
  el.time.textContent = s.active.toFixed(1);

  const state = lastInputAt === null ? 'ready' : s.paused ? 'paused' : 'live';
  el.status.textContent = isLlama() ? { ready: 'loaded', live: 'eval', paused: 'done' }[state] : state;
  document.body.dataset.state = state;
  el.share.disabled = tokens === 0;
  el.compare.textContent = s.active >= COMPARE_AFTER && tokens > 0 ? comparison(s.avg) : '';
  if (s.paused && !wasPaused) { wasPaused = true; checkRecord(); llamaPerf(); }
  el.best.textContent = best ? best.toFixed(2) : '–';
  el.best.classList.toggle('record', newRecord);

  // Nothing left to animate while paused: stop ticking until the next keystroke.
  if (s.paused && shownTps === s.live) { clearInterval(timer); timer = null; }
}

// "faster than a 70B model on a laptop CPU · 87× slower than an 8B model on an RTX 4090"
function comparison(avg) {
  if (avg >= REFERENCE.tps) return `faster than ${REFERENCE.name}?! Are you a bot?`;
  const beaten = MACHINES.filter((m) => avg > m.tps).pop();
  const first = beaten ? `faster than ${beaten.name}` : `slower than ${MACHINES[0].name}`;
  const ratio = REFERENCE.tps / avg;
  return `${first} · ${ratio < 10 ? ratio.toFixed(1) : Math.round(ratio)}× slower than ${REFERENCE.name}`;
}

// ---- Personal best -----------------------------------------------------------
function loadBest() {
  try { return Number(localStorage.getItem(recordKey())) || 0; } catch { return 0; }
}

// Called when a run ends (pause, restart, share, leaving the page) rather than
// continuously: the running average wobbles, and its peak would inflate records.
function checkRecord() {
  const s = stats();
  if (s.active < RECORD_MIN_SECONDS || tokens < RECORD_MIN_TOKENS || s.avg <= best) return;
  if (best > 0) { newRecord = true; toast('New personal best!'); }
  best = s.avg;
  try { localStorage.setItem(recordKey(), String(best)); } catch { /* storage blocked: keep it in memory */ }
  render();
}

// ---- Sharing ---------------------------------------------------------------
function shareUrl() {
  if (CONFIG.siteUrl) return CONFIG.siteUrl;
  return /^https?:$/.test(location.protocol) ? location.origin + location.pathname : '';
}

// Only the score is shared. Never the typed text.
function shareText(avg) {
  if (isLlama()) return LlamaCpp.shareText({ tokens, ms: stats().active * 1000, model: LLAMA_MODELS[llamaModel] });
  const vs = avg > MACHINES[0].tps ? `\nThat's ${comparison(avg).split(' · ')[0]}.` : '';
  return `I type at ${avg.toFixed(2)} tokens/sec (${tok.short} tokenizer).${vs}\nCan your fingers beat mine?\nHuman TPS`;
}

// Share links for the social buttons (share-x, share-reddit).
function socialLinks(avg, text, url) {
  const q = (o) => new URLSearchParams(o).toString();
  const full = url ? `${text}\n${url}` : text;
  const title = `I type at ${avg.toFixed(2)} tokens/sec (${tok.short} tokenizer). Can your fingers beat mine?`;
  return {
    x: 'https://x.com/intent/post?' + q(url ? { text, url } : { text }),
    reddit: 'https://www.reddit.com/submit?' + q(url ? { title, url } : { title, text: full, selftext: 'true' }),
  };
}

let shareMsg = ''; // the message currently shown in the share sheet

function openShare() {
  checkRecord();
  const avg = stats().avg, url = shareUrl(), text = shareText(avg);
  shareMsg = url ? `${text}\n${url}` : text;
  el.preview.textContent = shareMsg;
  for (const [name, href] of Object.entries(socialLinks(avg, text, url))) $('share-' + name).href = href;
  el.copy.textContent = 'Copy text';
  el.dialog.showModal();
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for non-secure contexts (e.g. file://) and older browsers.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove();
    return ok;
  }
}

async function copyShare() {
  const ok = await copyText(shareMsg);
  el.copy.textContent = ok ? 'Copied!' : 'Copy failed: select the text above';
}

let toastTimer;
function toast(msg, ms = 2500) { // ms = 0: stays until the next toast
  el.toast.textContent = msg;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => (el.toast.textContent = ''), ms);
}

// ---- Tokenizer switching ---------------------------------------------------
// Switching mid-test re-counts the same text with the new tokenizer (including
// the live window's history), so you see instantly how your score changes.
async function useTokenizer(name) {
  if (tok && tok.name === name) return true;
  const def = TOKENIZERS[name];
  if (!def.impl && def.size) toast(`Loading the ${def.short} tokenizer (${def.size})…`, 0);
  try {
    const t0 = performance.now();
    const next = await loadTokenizer(name);
    loadTimes[name] ??= performance.now() - t0;
    if (tok) checkRecord(); // close the current run under the old tokenizer
    tok = next;
    el.tokInfo.textContent = tok.label;
    best = loadBest();
    newRecord = false;
    for (const smp of samples) smp.n = tok.count(smp.c);
    retokenize();
    toast('');
    return true;
  } catch {
    toast(`Could not load the ${def.short} tokenizer.`);
    return false;
  }
}

const modeTokenizer = (name) => (MODES[name].llama ? LLAMA_MODELS[llamaModel].tokenizer : MODES[name].tokenizer);

async function useMode(name) {
  if (mode === name) return true;
  el.modeSwitch.forEach((b) => (b.disabled = true));
  const ok = await useTokenizer(modeTokenizer(name));
  if (ok) {
    const wasLlama = isLlama();
    mode = name;
    try { localStorage.setItem(MODE_KEY, name); } catch { /* not remembered, fine */ }
    document.body.dataset.mode = isLlama() ? 'llama' : '';
    if (isLlama() && !wasLlama) llamaBoot();
    setPlaceholder();
  }
  el.modeSwitch.forEach((b) => {
    b.disabled = false;
    b.setAttribute('aria-pressed', String(mode === b.dataset.mode));
  });
  render(true);
  syncBackdrop(); // the layout may have changed
  return ok;
}

// Pick the model in llama.cpp mode: loads its tokenizer and reboots the terminal.
async function useLlamaModel(key) {
  const prev = llamaModel;
  llamaModel = key;
  el.llamaModel.disabled = true;
  const ok = !isLlama() || (await useTokenizer(LLAMA_MODELS[key].tokenizer));
  if (ok) {
    try { localStorage.setItem(LLAMA_MODEL_KEY, key); } catch { /* not remembered, fine */ }
    if (isLlama()) llamaBoot();
  } else {
    llamaModel = prev;
  }
  el.llamaModel.value = llamaModel;
  el.llamaModel.disabled = false;
  render(true);
}

// ---- llama.cpp mode ----------------------------------------------------------
const isLlama = () => Boolean(MODES[mode]?.llama);
const MAX_CONSOLE_LINES = 80;
let bootRun = 0; // bumps on every boot, so an interrupted boot animation stops

function llamaLog(lines, cls = '') {
  for (const line of lines) {
    const div = document.createElement('div');
    div.textContent = line || '\u00a0'; // keep empty lines visible
    if (cls) div.className = cls;
    el.console.append(div);
  }
  while (el.console.childElementCount > MAX_CONSOLE_LINES) el.console.firstElementChild.remove();
  el.console.scrollTop = el.console.scrollHeight;
}

// Print the boot log line by line, like a model loading (instantly if reduced motion).
async function llamaBoot() {
  const run = ++bootRun;
  el.console.replaceChildren();
  const fast = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const info = { loadMs: loadTimes[tok.name] ?? 0, model: LLAMA_MODELS[llamaModel], vocab: tok.vocabSize };
  for (const line of LlamaCpp.bootLines(info)) {
    if (run !== bootRun) return;
    llamaLog([line], line.startsWith(' -') || line.startsWith('==') ? 'hl' : '');
    if (!fast) await new Promise((r) => setTimeout(r, 45));
  }
}

// The end-of-run stats block, printed when a run pauses or you restart.
function llamaPerf() {
  if (!isLlama() || tokens === 0) return;
  const lines = LlamaCpp.perfLines({ loadMs: loadTimes[tok.name] ?? 0, tokens, ms: stats().active * 1000 });
  llamaLog([''].concat(lines.slice(0, 2)));
  llamaLog([lines[2]], 'hl');
  llamaLog([lines[3]]);
}

function setPlaceholder() {
  el.input.placeholder = isLlama()
    ? '> You are the model now. Start generating.'
    : 'Start typing anything. The clock starts on your first keystroke.';
}

// ---- Init ------------------------------------------------------------------
async function init() {
  $('link-homoagens').href = CONFIG.homoagensUrl;
  $('link-github').href = CONFIG.githubUrl;
  if (CONFIG.supportUrl) $('link-support').href = CONFIG.supportUrl;
  else $('link-support').hidden = true;

  reset();
  let saved = null;
  try {
    saved = localStorage.getItem(MODE_KEY);
    const m = localStorage.getItem(LLAMA_MODEL_KEY);
    if (LLAMA_MODELS[m]) llamaModel = m;
  } catch { /* use the defaults */ }
  for (const [key, m] of Object.entries(LLAMA_MODELS)) el.llamaModel.add(new Option(m.file, key));
  el.llamaModel.value = llamaModel;
  const ok = (await useMode(MODES[saved] ? saved : DEFAULT_MODE)) || (await useMode(DEFAULT_MODE));
  if (!ok) {
    el.input.placeholder = 'Could not load the tokenizer. Try reloading the page.';
    return;
  }
  el.modeSwitch.forEach((b) => b.addEventListener('click', () => useMode(b.dataset.mode)));
  el.llamaModel.addEventListener('change', () => useLlamaModel(el.llamaModel.value));

  // It's a typing benchmark: pasting and drag-and-drop don't count.
  const noCheating = (e) => { e.preventDefault(); toast('Nice try. Humans have to type.'); };
  el.input.addEventListener('paste', noCheating);
  el.input.addEventListener('drop', noCheating);

  el.input.addEventListener('input', onInput);
  el.input.addEventListener('scroll', syncBackdrop);
  new ResizeObserver(syncBackdrop).observe(el.input);
  el.restart.addEventListener('click', () => {
    checkRecord();
    if (!wasPaused) llamaPerf(); // a paused run already printed its stats
    if (isLlama() && tokens > 0) llamaLog(['', 'main: context reset', ''], 'hl');
    reset();
    el.input.focus();
  });
  el.share.addEventListener('click', openShare);
  el.copy.addEventListener('click', copyShare);
  $('share-close').addEventListener('click', () => el.dialog.close());
  // Close on a click outside the sheet (on the backdrop) or after picking a social network.
  el.dialog.addEventListener('click', (e) => {
    if (e.target === el.dialog || e.target.closest('.socials a')) el.dialog.close();
  });
  addEventListener('pagehide', checkRecord);

  el.input.disabled = false;
  setPlaceholder();
  el.input.focus({ preventScroll: true });
}

init();

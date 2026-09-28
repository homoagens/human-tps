// Tokenizers.
//
// The app needs three things from a tokenizer: a label, count(text) -> number
// of tokens, and pieces(text) -> the text split into its tokens
// ('Hello world' -> ['Hello', ' world']), used for the colored highlighting.
//
// Each tokenizer's files are vendored in vendor/ and loaded only when it's
// selected, so the default one stays light. Everything is loaded as scripts
// (never fetch): the page's CSP blocks all network connections.

'use strict';

const TOKENIZERS = {
  // OpenAI's o200k_base (GPT-4o / GPT-4.1 / o-series / GPT-5) via gpt-tokenizer (MIT).
  o200k: {
    name: 'o200k',
    label: 'o200k_base (GPT-4o family)',
    short: 'GPT-4o',
    async load() {
      await loadScript('vendor/gpt-tokenizer/o200k_base.js');
      const lib = window.GPTTokenizer_o200k_base;
      return {
        vocabSize: lib.vocabularySize,
        count: (text) => (text ? lib.countTokens(text) : 0),
        // A multi-byte character split across tokens shows up in its last token.
        pieces: (text) => (text ? lib.encode(text).map((id) => lib.decode([id])) : []),
      };
    },
  },

  // Open-weight models' tokenizers, via Hugging Face tokenizers.js (Apache-2.0).
  qwen3: { name: 'qwen3', label: 'Qwen3 / Qwen2.5', short: 'Qwen3', size: '~2 MB', load: () => loadHf('qwen3') },
  deepseek: { name: 'deepseek', label: 'DeepSeek-R1 / V3', short: 'DeepSeek', size: '~2 MB', load: () => loadHf('deepseek') },
  mistral: { name: 'mistral', label: 'Mistral Tekken', short: 'Mistral', size: '~2.4 MB', load: () => loadHf('mistral') },
};

// Load a vendored Hugging Face tokenizer.json (vendor/<dir>/tokenizer.js).
async function loadHf(dir) {
  const [{ Tokenizer }, { tokenizerJson, tokenizerConfig, vocabSize }] = await Promise.all([
    import('./vendor/hf-tokenizers/tokenizers.min.mjs'),
    import(`./vendor/${dir}/tokenizer.js`),
  ]);
  const tok = new Tokenizer(tokenizerJson, tokenizerConfig);
  const encode = (text) => tok.encode(text, { add_special_tokens: false });
  return {
    vocabSize,
    count: (text) => (text ? encode(text).ids.length : 0),
    pieces: (text) => (text ? byteLevelPieces(encode(text).tokens) : []),
  };
}

const DEFAULT_TOKENIZER = 'o200k';

// Load a tokenizer by name: resolves to {name, label, short, vocabSize, count, pieces}.
async function loadTokenizer(name) {
  const def = TOKENIZERS[name] || TOKENIZERS[DEFAULT_TOKENIZER];
  def.impl ??= def.load().catch((e) => { def.impl = null; throw e; }); // load once, retry after failure
  return { ...def, ...(await def.impl) };
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.append(s);
  });
}

// Byte-level BPE tokens (GPT-2 style, used by Qwen, DeepSeek, Mistral) spell raw bytes with
// printable stand-in characters: ' ' is 'Ġ', 'é' is 'Ã©'. Map them back to
// bytes and decode as a stream, so a character split across tokens appears in
// the token that completes it.
const BYTE_OF_CHAR = (() => {
  const map = new Map();
  let n = 0;
  for (let b = 0; b < 256; b++) {
    const printable = (b >= 33 && b <= 126) || (b >= 161 && b <= 172) || b >= 174;
    map.set(String.fromCodePoint(printable ? b : 256 + n++), b);
  }
  return map;
})();

function byteLevelPieces(tokens) {
  const decoder = new TextDecoder();
  return tokens.map((t) => {
    const bytes = [];
    for (const ch of t) {
      const b = BYTE_OF_CHAR.get(ch);
      if (b === undefined) return t; // special token (e.g. <|im_start|>): already plain text
      bytes.push(b);
    }
    return decoder.decode(new Uint8Array(bytes), { stream: true });
  });
}

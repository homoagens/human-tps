// llama.cpp mode: the text for the fake terminal. Pure string functions; app.js
// prints them. The perf block uses llama.cpp's real llama_perf_context_print
// format, filled with your numbers: you are the model now.

'use strict';

window.LlamaCpp = (() => {
  const f2 = (x, w) => (Number.isFinite(x) ? x.toFixed(2) : 'nan').padStart(w);
  const pad = (x, w) => String(x).padStart(w);
  const P = 'llama_perf_context_print:';

  // "human-brain-qwen3.gguf": your brain, fine-tuned on a real model's vocabulary.
  const ggufName = (model) => `human-brain-${model.file}-Q4_K_M.gguf`;

  // Printed when llama.cpp mode starts. loadMs and vocab come from the real tokenizer.
  function bootLines({ loadMs, model, vocab }) {
    return [
      'build: 4242 (h0m0ag3) with gcc 13.2 for x86_64-carbon-based-lifeform',
      `llama_model_loader: loaded meta data with 42 key-value pairs from ${ggufName(model)} (version GGUF V3 (latest))`,
      'print_info: arch             = homo_sapiens',
      `print_info: general.name     = Human Brain (${model.name} vocab)`,
      'print_info: n_params         = 86.00 B neurons',
      'print_info: vocab type       = BPE',
      `print_info: n_vocab          = ${vocab}`,
      'load_tensors: offloaded 0/0 layers to GPU',
      'load_tensors:   CPU_Mapped model buffer size =  1400.00 MiB (brain)',
      'load_tensors:      FINGERS model buffer size =    10.00 units',
      'llama_context: n_ctx = 8192, n_batch = 1 (one keystroke at a time)',
      'llama_context: flash_attn = 0 (attention span may vary)',
      `main: tokenizer loaded in ${loadMs.toFixed(2)} ms`,
      '',
      '== Running in interactive mode. ==',
      ' - Start typing. You are the model now.',
      ' - Press Restart to reset the context.',
    ];
  }

  // The end-of-generation stats block. Generation = your typing: no prompt eval.
  function perfLines({ loadMs, tokens, ms }) {
    const perToken = tokens ? ms / tokens : NaN;
    const tps = ms ? (tokens / ms) * 1000 : NaN;
    return [
      `${P}        load time = ${f2(loadMs, 10)} ms`,
      `${P} prompt eval time = ${f2(0, 10)} ms / ${pad(0, 5)} tokens (${f2(NaN, 8)} ms per token, ${f2(NaN, 8)} tokens per second)`,
      `${P}        eval time = ${f2(ms, 10)} ms / ${pad(tokens, 5)} runs   (${f2(perToken, 8)} ms per token, ${f2(tps, 8)} tokens per second)`,
      `${P}       total time = ${f2(ms, 10)} ms / ${pad(tokens, 5)} tokens`,
    ];
  }

  function shareText({ tokens, ms, model }) {
    const tps = ms ? (tokens / ms) * 1000 : 0;
    return [
      `$ ./llama-cli -m ${ggufName(model)}`,
      `llama_perf_context_print: eval time = ${ms.toFixed(2)} ms / ${tokens} runs (${(ms / Math.max(tokens, 1)).toFixed(2)} ms per token, ${tps.toFixed(2)} tokens per second)`,
      'Can your fingers beat mine?',
      'Human TPS',
    ].join('\n');
  }

  return { ggufName, bootLines, perfLines, shareText };
})();

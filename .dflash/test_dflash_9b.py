"""Smoke test: use cached Qwen3.5-9B-MLX-4bit as target, download tiny 9B DFlash draft."""
import time
import sys

print("[test] importing dflash.model_mlx...", flush=True)
t0 = time.time()
from dflash.model_mlx import load, load_draft, stream_generate
print(f"[test] import ok ({time.time() - t0:.1f}s)", flush=True)

TARGET = "mlx-community/Qwen3.5-9B-MLX-4bit"
DRAFT = "z-lab/Qwen3.5-9B-DFlash"

print(f"[test] loading target {TARGET} (cached)...", flush=True)
t0 = time.time()
model, tokenizer = load(TARGET)
print(f"[test] target loaded ({time.time() - t0:.1f}s)", flush=True)

print(f"[test] loading draft {DRAFT} (downloads on first run)...", flush=True)
t0 = time.time()
draft = load_draft(DRAFT)
print(f"[test] draft loaded ({time.time() - t0:.1f}s)", flush=True)

messages = [{"role": "user", "content": "Reply in one sentence: what is 12 * 7?"}]
prompt = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
print(f"[test] prompt length: {len(prompt)} chars", flush=True)

print("[test] generating (max 256 tokens)...", flush=True)
t0 = time.time()
out_text = ""
n_tokens = 0
for r in stream_generate(model, draft, tokenizer, prompt, block_size=16, max_tokens=256):
    out_text += r.text
    n_tokens += 1
    sys.stdout.write(r.text)
    sys.stdout.flush()
elapsed = time.time() - t0
print(f"\n[test] done. {n_tokens} chunks in {elapsed:.1f}s", flush=True)
print(f"[test] full output: {out_text[:500]!r}", flush=True)

# Regrader

Personal web app that crawls your Gradescope account, identifies graded
questions where points may have been deducted unfairly, and drafts polite
regrade requests for your review.

100% local — no calls to OpenAI / Anthropic / any cloud service. The LLM runs
on Apple Silicon via [`z-lab/dflash`](https://github.com/z-lab/dflash) wrapped
in a tiny FastAPI server (in `.dflash/server.py`). DFlash uses
[block-diffusion speculative decoding](https://arxiv.org/abs/2602.06036) for
fast inference.

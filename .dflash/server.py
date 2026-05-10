"""OpenAI-compatible HTTP server wrapping z-lab/dflash MLX inference.

Run:
    cd .dflash && source .venv/bin/activate
    pip install fastapi uvicorn
    python server.py --target Qwen/Qwen3.5-4B --draft z-lab/Qwen3.5-4B-DFlash --port 8000

Endpoints:
    POST /v1/chat/completions  (OpenAI-compatible, supports stream=true)
    GET  /v1/models
    GET  /health
"""
import argparse
import json
import time
import uuid
from typing import Any

from fastapi import FastAPI
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel
import uvicorn

from dflash.model_mlx import load, load_draft, stream_generate


class ChatMessage(BaseModel):
    role: str
    content: Any  # str or list of content blocks (we only handle str)


class ChatCompletionRequest(BaseModel):
    model: str | None = None
    messages: list[ChatMessage]
    max_tokens: int = 1024
    temperature: float = 1.0
    stream: bool = False
    response_format: dict | None = None


def make_app(target_id: str, draft_id: str, block_size: int) -> FastAPI:
    print(f"[server] loading target {target_id}...", flush=True)
    t0 = time.time()
    model, tokenizer = load(target_id)
    print(f"[server] target loaded in {time.time() - t0:.1f}s", flush=True)

    print(f"[server] loading draft {draft_id}...", flush=True)
    t0 = time.time()
    draft = load_draft(draft_id)
    print(f"[server] draft loaded in {time.time() - t0:.1f}s", flush=True)

    app = FastAPI()

    def messages_to_text(msgs: list[ChatMessage]) -> list[dict]:
        out = []
        for m in msgs:
            content = m.content if isinstance(m.content, str) else "".join(
                (b.get("text", "") for b in m.content if isinstance(b, dict)),
            )
            out.append({"role": m.role, "content": content})
        return out

    @app.get("/health")
    def health():
        return {"ok": True, "target": target_id, "draft": draft_id}

    @app.get("/v1/models")
    def models():
        return {
            "object": "list",
            "data": [
                {"id": target_id, "object": "model", "owned_by": "local"},
            ],
        }

    @app.post("/v1/chat/completions")
    def chat_completions(req: ChatCompletionRequest):
        msgs = messages_to_text(req.messages)
        prompt = tokenizer.apply_chat_template(
            msgs, tokenize=False, add_generation_prompt=True,
            enable_thinking=False,
        )

        request_id = f"chatcmpl-{uuid.uuid4().hex[:24]}"
        created = int(time.time())
        model_name = req.model or target_id

        if req.stream:
            def event_stream():
                for r in stream_generate(
                    model, draft, tokenizer, prompt,
                    block_size=block_size, max_tokens=req.max_tokens,
                ):
                    chunk = {
                        "id": request_id,
                        "object": "chat.completion.chunk",
                        "created": created,
                        "model": model_name,
                        "choices": [{
                            "index": 0,
                            "delta": {"content": r.text},
                            "finish_reason": None,
                        }],
                    }
                    yield f"data: {json.dumps(chunk)}\n\n"
                done = {
                    "id": request_id,
                    "object": "chat.completion.chunk",
                    "created": created,
                    "model": model_name,
                    "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                }
                yield f"data: {json.dumps(done)}\n\n"
                yield "data: [DONE]\n\n"

            return StreamingResponse(event_stream(), media_type="text/event-stream")

        full = ""
        for r in stream_generate(
            model, draft, tokenizer, prompt,
            block_size=block_size, max_tokens=req.max_tokens,
        ):
            full += r.text

        for stop in ("<|im_end|>", "<|endoftext|>"):
            if full.endswith(stop):
                full = full[: -len(stop)]
        full = full.rstrip()

        return JSONResponse({
            "id": request_id,
            "object": "chat.completion",
            "created": created,
            "model": model_name,
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": full},
                "finish_reason": "stop",
            }],
            "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
        })

    return app


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", required=True, help="HF model id of target")
    parser.add_argument("--draft", required=True, help="HF model id of DFlash draft")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--block-size", type=int, default=16)
    args = parser.parse_args()

    app = make_app(args.target, args.draft, args.block_size)
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()

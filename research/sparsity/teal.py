"""Activation sparsity of a dense model, measured (G26.6, 2026-11-04).

Two questions decide whether RedGiant should teach llama.cpp to skip weights:
  1. TEAL (training-free activation sparsity): if the inputs of every linear layer below a
     per-layer threshold are set to zero, how much worse does the model get? Each zero is a
     column of weights nobody has to read.
  2. Hot neurons (PowerInfer, "LLM in a flash"): in the MLP's down projection, do a few
     neurons carry most of the activations? Then the hot ones can live in the card.

Usage (CPU, a container is enough for models up to ~2B in bf16):
  python teal.py <hf model id> <out.json> [--calib 8192] [--eval 16384]
Image used: python:3.12-slim (pip install torch transformers pyarrow huggingface_hub).
"""

import json
import math
import sys
import time

import pyarrow.parquet as pq
import torch
from huggingface_hub import hf_hub_download
from transformers import AutoModelForCausalLM, AutoTokenizer

LEVELS = [0.0, 0.25, 0.4, 0.5, 0.6]
SEQ = 512
SAMPLE = 65536  # absolute values kept per layer input to find its thresholds


def arg(name, default):
    return int(sys.argv[sys.argv.index(name) + 1]) if name in sys.argv else default


def wikitext(tok, n_tokens, offset):
    path = hf_hub_download(
        "Salesforce/wikitext", "wikitext-2-raw-v1/test-00000-of-00001.parquet", repo_type="dataset"
    )
    text = "\n".join(pq.read_table(path).column("text").to_pylist())
    ids = tok(text, return_tensors="pt").input_ids[0]
    return ids[offset : offset + n_tokens]


def linears(model):
    """Every linear layer inside the decoder blocks, with its name."""
    return [
        (name, mod)
        for name, mod in model.named_modules()
        if isinstance(mod, torch.nn.Linear) and ".layers." in name
    ]


def main():
    model_id, out = sys.argv[1], sys.argv[2]
    n_calib, n_eval = arg("--calib", 8192), arg("--eval", 16384)
    torch.set_num_threads(max(1, torch.get_num_threads()))
    tok = AutoTokenizer.from_pretrained(model_id)
    model = AutoModelForCausalLM.from_pretrained(model_id, torch_dtype=torch.bfloat16)
    model.eval()
    calib = wikitext(tok, n_calib, 0)
    evals = wikitext(tok, n_eval, n_calib)
    layers = linears(model)

    # 1. Calibration: a sample of |x| at the input of every linear layer, and, for the down
    #    projections, how often each neuron is among the active ones.
    samples = {name: [] for name, _ in layers}
    counts = {}
    hooks = []

    def keep(name):
        def hook(_mod, inputs):
            x = inputs[0].detach().float().abs().reshape(-1, inputs[0].shape[-1])
            flat = x.reshape(-1)
            pick = torch.randint(0, flat.numel(), (min(flat.numel(), 8192),))
            samples[name].append(flat[pick])
            if name.endswith("down_proj"):
                # Active = above this token's median magnitude; counted per neuron.
                active = x > x.median(dim=-1, keepdim=True).values
                counts.setdefault(name, torch.zeros(x.shape[-1]))
                counts[name] += active.sum(dim=0).float()
                counts.setdefault(name + "#tokens", torch.zeros(1))
                counts[name + "#tokens"] += x.shape[0]

        return hook

    for name, mod in layers:
        hooks.append(mod.register_forward_pre_hook(keep(name)))
    with torch.no_grad():
        for i in range(0, len(calib) - SEQ + 1, SEQ):
            model(calib[i : i + SEQ].unsqueeze(0))
    for h in hooks:
        h.remove()
    pool = {n: torch.cat(v)[:SAMPLE] for n, v in samples.items()}

    # Hot neurons: the share of neurons that carry 50 % and 80 % of the activity.
    hot = []
    for name, c in counts.items():
        if name.endswith("#tokens"):
            continue
        s = torch.sort(c, descending=True).values
        cum = torch.cumsum(s, 0) / s.sum()
        hot.append(
            {
                "layer": name,
                "share_for_50": float((cum < 0.5).sum() + 1) / len(s),
                "share_for_80": float((cum < 0.8).sum() + 1) / len(s),
            }
        )

    # 2. Perplexity with the inputs below each layer's threshold set to zero.
    results = []
    for level in LEVELS:
        hooks = []
        if level > 0:
            for name, mod in layers:
                t = float(torch.quantile(pool[name], level))

                def zero(_mod, inputs, t=t):
                    x = inputs[0]
                    return (x * (x.abs() >= t),)

                hooks.append(mod.register_forward_pre_hook(zero))
        nll, n = 0.0, 0
        started = time.time()
        with torch.no_grad():
            for i in range(0, len(evals) - SEQ + 1, SEQ):
                ids = evals[i : i + SEQ].unsqueeze(0)
                loss = model(ids, labels=ids).loss
                nll += float(loss) * (SEQ - 1)
                n += SEQ - 1
        for h in hooks:
            h.remove()
        results.append({"sparsity": level, "ppl": math.exp(nll / n), "seconds": time.time() - started})
        print(json.dumps(results[-1]), flush=True)

    base = results[0]["ppl"]
    for r in results:
        r["ppl_increase_pct"] = round((r["ppl"] / base - 1) * 100, 2)
    summary = {
        "model": model_id,
        "calib_tokens": n_calib,
        "eval_tokens": n_eval,
        "perplexity": results,
        "hot_neurons_mean": {
            "share_for_50": sum(h["share_for_50"] for h in hot) / max(len(hot), 1),
            "share_for_80": sum(h["share_for_80"] for h in hot) / max(len(hot), 1),
        },
        "hot_neurons": hot,
    }
    with open(out, "w") as f:
        json.dump(summary, f, indent=2)
    print(json.dumps({k: summary[k] for k in ("model", "perplexity", "hot_neurons_mean")}, indent=2))


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
Retrain the refusal surrogate from local logs and regenerate
packages/core/src/refusal-surrogate-model.ts.

Positives = refused request bodies (~/.prime/agent/refused-bodies/*.json.gz).
Negatives = text from non-refusing session transcripts (~/.prime/agent/sessions/*.jsonl).

Featurizer (MUST stay in sync with refusal-surrogate.ts):
  - tokenize lowercase [a-z0-9_]+, word n-grams 1..2
  - md5(gram) hex -> idx = int(hex[:8],16) % DIM ; sign = +1 if int(hex[8],16)%2==0 else -1
  - L2-normalize per window (WINDOW chars, drop <200-char tails)
  - body score = mean of top-K hottest window probabilities

Run:  python3 scripts/train-refusal-surrogate.py
"""

import gzip
import hashlib
import json
import os
import re
from pathlib import Path
import numpy as np

WINDOW = 4000
DIM = 2048
NGRAM = (1, 2)
TOPK = 3
THRESHOLD = 0.72
PRIME = Path(os.environ.get("REFUSAL_LOG_DIR", os.path.expanduser("~/.prime/agent")))
REFUSED = PRIME / "refused-bodies"
SESSIONS = PRIME / "sessions"
EVENTS = PRIME / "refusal-events.jsonl"
OUT = (
    Path(__file__).resolve().parent.parent
    / "packages/core/src/refusal-surrogate-model.ts"
)

_tok = re.compile(r"[a-z0-9_]+")


def toks_of(t):
    return _tok.findall(t.lower())


def windows(t, w=WINDOW):
    return [
        t[i : i + w] for i in range(0, max(1, len(t)), w) if len(t[i : i + w]) > 200
    ]


def feat(text, dim=DIM):
    v = np.zeros(dim)
    t = toks_of(text)
    for n in range(NGRAM[0], NGRAM[1] + 1):
        for i in range(len(t) - n + 1):
            hx = hashlib.md5(" ".join(t[i : i + n]).encode()).hexdigest()
            v[int(hx[:8], 16) % dim] += 1.0 if int(hx[8], 16) % 2 == 0 else -1.0
    nrm = np.linalg.norm(v)
    return v / nrm if nrm > 0 else v


def refused_text(f):
    o = json.loads(gzip.decompress(f.read_bytes()))
    inner = json.loads(o["body"]) if isinstance(o["body"], str) else o["body"]
    parts = []
    for m in inner.get("messages", []):
        c = m.get("content")
        if isinstance(c, str):
            parts.append(c)
        elif isinstance(c, list):
            for b in c:
                if not isinstance(b, dict):
                    continue
                for k in ("text", "thinking", "content"):
                    if isinstance(b.get(k), str):
                        parts.append(b[k])
                if b.get("type") == "tool_use":
                    parts.append(json.dumps(b.get("input", {})))
    return "\n".join(parts)


def session_text(f, limit=400000):
    parts = []
    for line in f.read_text().strip().split("\n"):
        try:
            r = json.loads(line)
        except Exception:
            continue
        if r.get("type") != "message":
            continue
        c = r.get("message", {}).get("content")
        if isinstance(c, str):
            parts.append(c)
        elif isinstance(c, list):
            for b in c:
                if not isinstance(b, dict):
                    continue
                for k in ("text", "thinking"):
                    if isinstance(b.get(k), str):
                        parts.append(b[k])
                if b.get("type") == "tool_use":
                    parts.append(json.dumps(b.get("input", {})))
                if b.get("type") == "tool_result":
                    tc = b.get("content")
                    if isinstance(tc, str):
                        parts.append(tc)
                    elif isinstance(tc, list):
                        for s in tc:
                            if isinstance(s, dict) and isinstance(s.get("text"), str):
                                parts.append(s["text"])
        if sum(len(p) for p in parts) > limit:
            break
    return "\n".join(parts)


def train(X, y, l2=1.0, lr=0.5, epochs=300):
    n, d = X.shape
    w = np.zeros(d)
    b = 0.0
    pw = (y == 0).sum() / max(1, (y == 1).sum())
    sw = np.where(y == 1, pw, 1.0)
    for _ in range(epochs):
        p = 1 / (1 + np.exp(-(X @ w + b)))
        g = (p - y) * sw
        w -= lr * (X.T @ g / n + l2 * w / n)
        b -= lr * g.mean()
    return w, b


def main():
    refusing = {
        json.loads(line).get("sessionId")
        for line in EVENTS.read_text().strip().split("\n")
        if line.strip()
    }
    pos_raw = [refused_text(f) for f in sorted(REFUSED.glob("*.json.gz"))]
    seen, pos = set(), []
    for t in pos_raw:
        k = hashlib.md5(t[:2000].encode()).hexdigest()
        if k not in seen:
            seen.add(k)
            pos.append(t)
    neg = []
    for f in sorted(
        SESSIONS.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True
    ):
        if f.stem in refusing or f.stat().st_size < 20000:
            continue
        t = session_text(f)
        if len(t) > 8000:
            neg.append(t)
        if len(neg) >= 120:
            break
    Xp = [feat(w) for t in pos for w in windows(t)]
    Xn = [feat(w) for t in neg for w in windows(t)]
    X = np.array(Xp + Xn)
    y = np.array([1] * len(Xp) + [0] * len(Xn))
    w, b = train(X, y)

    def bscore(t):
        ws = windows(t)
        if not ws:
            return 0.0
        ps = 1 / (1 + np.exp(-(np.array([feat(x) for x in ws]) @ w + b)))
        return float(np.sort(ps)[-TOPK:].mean())

    ps = [bscore(t) for t in pos]
    ns = [bscore(t) for t in neg]
    yy = np.array([1] * len(ps) + [0] * len(ns))
    pp = np.array(ps + ns)
    ranks = np.argsort(np.argsort(pp))
    P = int(yy.sum())
    N = len(yy) - P
    auc = (ranks[yy == 1].sum() - P * (P - 1) / 2) / (P * N)
    model = {
        "version": 1,
        "featurizer": {
            "window": WINDOW,
            "dim": DIM,
            "ngram": list(NGRAM),
            "hash": "md5",
            "topK": TOPK,
        },
        "threshold": THRESHOLD,
        "bias": float(b),
        "weights": [round(float(x), 6) for x in w],
        "meta": {
            "bodyAUC": round(float(auc), 4),
            "posSamples": len(pos),
            "negSamples": len(neg),
        },
    }
    OUT.write_text(
        "// AUTO-GENERATED by scripts/train-refusal-surrogate.py -- do not edit by hand.\n"
        "// Surrogate refusal predictor weights (hashed word-n-gram logistic model).\n"
        "import type { SurrogateModel } from './refusal-surrogate-types'\n\n"
        "export const REFUSAL_SURROGATE_MODEL: SurrogateModel = "
        + json.dumps(model, separators=(",", ":"))
        + " as const\n"
    )
    print(
        f"pos={len(pos)} neg={len(neg)} windows={len(Xp)}+{len(Xn)} bodyAUC={auc:.4f} -> {OUT}"
    )


if __name__ == "__main__":
    main()

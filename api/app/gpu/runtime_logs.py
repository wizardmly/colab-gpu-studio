"""Bounded runtime output snapshots for persisted job details."""

import math
import re

from app.job_history import safe_log

MAX_LOG_BYTES = 16 * 1024
_ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
_CONTROLS = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")
_CREDENTIALS = re.compile(r"Bearer\s+\S+|ya29\.[\w.-]+|hf_[A-Za-z0-9]{20,}", re.I)


def runtime_log_text(value: str) -> str:
    if len(value) > MAX_LOG_BYTES:
        value = value[-MAX_LOG_BYTES:].partition("\n")[2]
    text = _ANSI.sub("", value).replace("\r\n", "\n").replace("\r", "\n")
    text = _CREDENTIALS.sub("[REDACTED]", _CONTROLS.sub("", text))
    return "\n".join(safe_log(line, limit=MAX_LOG_BYTES) for line in text.splitlines())[-MAX_LOG_BYTES:]


def public_runtime_logs(value) -> dict:
    if not isinstance(value, dict):
        return {}
    result = {}
    collected_at = value.get("collected_at")
    if type(collected_at) in (int, float) and math.isfinite(collected_at) and collected_at > 0:
        result["collected_at"] = collected_at
    for name in ("worker", "comfyui"):
        if isinstance(value.get(name), str):
            result[name] = runtime_log_text(value[name])
    return result

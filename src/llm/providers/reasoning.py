"""Helpers for reasoning text that self-hosted models leave in message content."""

from __future__ import annotations

THINK_OPEN = "<think>"
THINK_CLOSE = "</think>"


def strip_reasoning(content: str) -> str:
    """Drop a leading reasoning block from model output.

    Hosted APIs return reasoning in a separate field, but self-hosted reasoning
    models (vLLM or llama.cpp without a reasoning parser, Ollama models without
    a thinking template) put it in ``content``. It arrives in two shapes:

    - ``<think>...</think>answer``
    - ``...</think>answer`` when the chat template prefills the opening tag in
      the generation prompt, so the model only ever emits the closing tag.

    A ``<think>`` that does not open the output is treated as a literal and
    left alone, as is unterminated reasoning (for example when ``max_tokens``
    cut the model off before it reached an answer).
    """
    close = content.find(THINK_CLOSE)
    if close == -1:
        return content

    head = content[:close]
    opening = head.find(THINK_OPEN)
    if opening != -1 and head[:opening].strip():
        return content

    return content[close + len(THINK_CLOSE) :].lstrip()

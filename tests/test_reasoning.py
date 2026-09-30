import urllib.request
from io import BytesIO
from types import SimpleNamespace

import pytest

from llm.core.types import LLMInput, Message, Role
from llm.providers.ollama import OllamaProvider
from llm.providers.openai import OpenAIProvider
from llm.providers.reasoning import strip_reasoning


@pytest.mark.parametrize(
    ("content", "expected"),
    [
        ("<think>17 * 3 = 51.</think>51", "51"),
        ("\n<think>\nplan\n</think>\n\nanswer", "answer"),
        ("17 * 3 = 51.</think>51", "51"),
        ("plain answer", "plain answer"),
        ("", ""),
        ("Wrap it in <think> and </think> tags.", "Wrap it in <think> and </think> tags."),
        ("<think>cut off by max_tokens", "<think>cut off by max_tokens"),
    ],
)
def test_strip_reasoning(content, expected):
    assert strip_reasoning(content) == expected


def test_openai_provider_strips_inline_reasoning():
    provider = OpenAIProvider(api_key="test")
    message = SimpleNamespace(content="<think>17 * 3 = 51.</think>51", tool_calls=None)
    response = SimpleNamespace(
        choices=[SimpleNamespace(message=message, finish_reason="stop")],
        model="spark-x2.5",
        usage=None,
    )
    provider.client = SimpleNamespace(
        chat=SimpleNamespace(completions=SimpleNamespace(create=lambda **params: response))
    )

    output = provider.generate(LLMInput(messages=[Message(role=Role.USER, content="17*3?")]))

    assert output.content == "51"


def test_ollama_provider_strips_prefilled_reasoning(monkeypatch):
    def fake_urlopen(request, timeout):
        return BytesIO(b'{"message": {"content": "17 * 3 = 51.</think>51"}, "done_reason": "stop"}')

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)

    output = OllamaProvider().generate(LLMInput(messages=[Message(role=Role.USER, content="17*3?")]))

    assert output.content == "51"

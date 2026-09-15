"""All structured readers expose metadata-only extraction without raw fallbacks."""

import json

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from oh_memos.mem_reader.multi_modal_struct import MultiModalStructMemReader
from oh_memos.mem_reader.simple_struct import PROMPT_DICT, SimpleStructMemReader
from oh_memos.mem_reader.strategy_struct import STRATEGY_PROMPT_DICT, StrategyStructMemReader


RAW_MEMORY = "The original saved memory must remain unchanged."
PARSED_RESPONSE = {
    "memory list": [
        {
            "key": "Parsed title",
            "value": "A shorter model-generated description",
            "tags": ["parsed-tag"],
        }
    ],
    "summary": "Parsed background",
}
READERS = [SimpleStructMemReader, StrategyStructMemReader, MultiModalStructMemReader]


def reader_instance(reader_class, response=None, error=None):
    reader = object.__new__(reader_class)
    reader.config = SimpleNamespace(remove_prompt_example=False)
    reader.llm = MagicMock()
    reader.llm.generate.return_value = response
    reader.llm.generate.side_effect = error
    reader.embedder = MagicMock()
    reader.embedder.embed.side_effect = AssertionError("metadata extraction must not embed")
    return reader


@pytest.mark.parametrize("reader_class", READERS)
def test_extract_metadata_returns_only_metadata_with_the_reader_prompt(reader_class):
    reader = reader_instance(reader_class, json.dumps(PARSED_RESPONSE))

    fields = reader.extract_metadata(RAW_MEMORY, custom_tags=["business-tag"])

    assert fields["key"] == "Parsed title"
    assert fields["tags"] == ["parsed-tag"]
    assert fields["background"] == "Parsed background"
    assert json.loads(fields["enrichment_items"]) == PARSED_RESPONSE["memory list"]
    assert not {"id", "memory", "embedding", "status"}.intersection(fields)
    reader.embedder.embed.assert_not_called()
    prompts = STRATEGY_PROMPT_DICT if reader_class is StrategyStructMemReader else PROMPT_DICT
    expected = prompts["chat"]["en"].replace("${conversation}", RAW_MEMORY)
    custom_prompt = prompts["custom_tags"]["en"].replace("{custom_tags}", "['business-tag']")
    expected = expected.replace("${custom_tags_prompt}", custom_prompt)
    reader.llm.generate.assert_called_once_with([{"role": "user", "content": expected}])


@pytest.mark.parametrize("reader_class", READERS)
@pytest.mark.parametrize("response", ["not JSON", "{}", '{"summary": "no extracted items"}'])
def test_extract_metadata_rejects_invalid_results_instead_of_fabricating_success(reader_class, response):
    reader = reader_instance(reader_class, response)

    with pytest.raises(ValueError):
        reader.extract_metadata(RAW_MEMORY)

    reader.embedder.embed.assert_not_called()


@pytest.mark.parametrize("reader_class", READERS)
def test_extract_metadata_propagates_the_original_llm_failure(reader_class):
    failure = RuntimeError("model request timed out")
    reader = reader_instance(reader_class, error=failure)

    with pytest.raises(RuntimeError) as captured:
        reader.extract_metadata(RAW_MEMORY)

    assert captured.value is failure
    reader.llm.generate.assert_called_once()
    reader.embedder.embed.assert_not_called()


@pytest.mark.parametrize("reader_class", READERS)
def test_legacy_response_calls_still_accept_positional_arguments(reader_class):
    reader = reader_instance(reader_class, json.dumps(PARSED_RESPONSE))

    assert reader._get_llm_response(RAW_MEMORY, None) == PARSED_RESPONSE


@pytest.mark.parametrize("reader_class", READERS)
def test_legacy_response_calls_keep_the_original_text_fallback_on_llm_error(reader_class):
    reader = reader_instance(reader_class, error=RuntimeError("model unavailable"))

    response = reader._get_llm_response(RAW_MEMORY, None)

    assert response["memory list"][0]["value"] == RAW_MEMORY
    assert response["summary"] == RAW_MEMORY
    reader.embedder.embed.assert_not_called()


@pytest.mark.parametrize("strict", [False, True])
def test_multimodal_response_preserves_legacy_sources_and_document_prompt_arguments(strict):
    reader = reader_instance(MultiModalStructMemReader, json.dumps(PARSED_RESPONSE))

    response = reader._get_llm_response(
        RAW_MEMORY, ["business-tag"], [{"lang": "zh"}], "doc", strict=strict
    )

    assert response == PARSED_RESPONSE
    expected = PROMPT_DICT["doc"]["zh"].replace("{chunk_text}", RAW_MEMORY)
    custom_prompt = PROMPT_DICT["custom_tags"]["zh"].replace("{custom_tags}", "['business-tag']")
    expected = expected.replace("{custom_tags_prompt}", custom_prompt)
    reader.llm.generate.assert_called_once_with([{"role": "user", "content": expected}])
    reader.embedder.embed.assert_not_called()

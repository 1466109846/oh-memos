from typing import Any, ClassVar

from oh_memos.configs.env_loader import get_llm_fallback_config
from oh_memos.configs.llm import LLMConfigFactory, LLMFallbackConfig
from oh_memos.llms.base import BaseLLM
from oh_memos.llms.deepseek import DeepSeekLLM
from oh_memos.llms.fallback import FallbackLLM
from oh_memos.llms.hf import HFLLM
from oh_memos.llms.hf_singleton import HFSingletonLLM
from oh_memos.llms.ollama import OllamaLLM
from oh_memos.llms.openai import AzureLLM, OpenAILLM
from oh_memos.llms.openai_new import OpenAIResponsesLLM
from oh_memos.llms.qwen import QwenLLM
from oh_memos.llms.vllm import VLLMLLM
from oh_memos.log import get_logger
from oh_memos.memos_tools.singleton import singleton_factory


logger = get_logger(__name__)

# Backends whose calls are OpenAI-compatible and therefore eligible for degradation
# to the (OpenAI-compatible) fallback LLM. Local backends (huggingface/ollama) are
# excluded so a local model failure does not silently divert to a cloud API.
OPENAI_COMPATIBLE_BACKENDS = frozenset(
    {"openai", "azure", "deepseek", "qwen", "vllm", "openai_new"}
)


class LLMFactory(BaseLLM):
    """Factory class for creating LLM instances."""

    backend_to_class: ClassVar[dict[str, Any]] = {
        "openai": OpenAILLM,
        "azure": AzureLLM,
        "ollama": OllamaLLM,
        "huggingface": HFLLM,
        "huggingface_singleton": HFSingletonLLM,  # Add singleton version
        "vllm": VLLMLLM,
        "qwen": QwenLLM,
        "deepseek": DeepSeekLLM,
        "openai_new": OpenAIResponsesLLM,
    }

    @classmethod
    def _get_fallback_config(cls) -> LLMFallbackConfig | None:
        """Load LLM fallback configuration from environment.

        Returns LLMFallbackConfig if fallback is enabled, None otherwise.
        """
        try:
            cfg_dict = get_llm_fallback_config()
            if cfg_dict.get("enabled", False):
                return LLMFallbackConfig(**cfg_dict)
            return None
        except Exception as e:
            logger.warning(f"Failed to load LLM fallback config: {e}")
            return None

    @classmethod
    def _wrap_with_fallback(cls, primary: BaseLLM, fallback_config: LLMFallbackConfig) -> BaseLLM:
        """Wrap an LLM with fallback support."""
        logger.info(
            f"Wrapping LLM with fallback support: "
            f"backend={fallback_config.fallback_backend}, "
            f"model={fallback_config.fallback_model}"
        )
        return FallbackLLM(primary=primary, fallback_config=fallback_config)

    @classmethod
    @singleton_factory()
    def from_config(cls, config_factory: LLMConfigFactory) -> BaseLLM:
        backend = config_factory.backend
        if backend not in cls.backend_to_class:
            raise ValueError(f"Invalid backend: {backend}")
        llm_class = cls.backend_to_class[backend]
        primary = llm_class(config_factory.config)

        # Wrap with fallback for OpenAI-compatible backends when enabled.
        if backend in OPENAI_COMPATIBLE_BACKENDS:
            fallback_config = cls._get_fallback_config()
            if fallback_config:
                return cls._wrap_with_fallback(primary, fallback_config)

        return primary

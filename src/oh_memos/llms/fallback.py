"""
Fallback LLM with automatic retry and degradation support.

This module provides a wrapper LLM that automatically falls back to a backup LLM
when the primary LLM is unavailable. It mirrors the design of
``oh_memos.embedders.fallback.FallbackEmbedder`` but targets chat/completion LLMs.

Behaviour:
- Intelligent error classification (transient vs permanent).
- Exponential backoff retry (with jitter) for transient errors (e.g. timeout, 5xx,
  connection reset / WinError 10053).
- Immediate fallback for permanent errors (quota exhausted / insufficient balance /
  auth failure), and for transient errors after retries are exhausted.
- Health tracking with recovery logging.

The module is intentionally self-contained (its own error classification / retry
policy) so ``llms`` does not depend on the ``embedders`` package.
"""

import random
import time

from collections.abc import Generator

from oh_memos.configs.llm import LLMFallbackConfig, OpenAILLMConfig
from oh_memos.llms.base import BaseLLM
from oh_memos.log import get_logger
from oh_memos.types import MessageList


logger = get_logger(__name__)


# =============================================================================
# Error Classification
# =============================================================================

# HTTP status codes that indicate transient errors (retry, then fall back).
TRANSIENT_STATUS_CODES = {408, 500, 502, 503, 504}

# HTTP status codes that indicate permanent errors (fall back immediately).
# 429 is treated as permanent here because for this deployment it almost always
# means "quota exhausted / insufficient balance" rather than short-term throttling.
PERMANENT_STATUS_CODES = {401, 402, 403, 404, 429}

# Substrings meaning the primary is unresponsive / unreachable (timeout, connection
# down). Each such attempt is expensive (it waits out the read timeout) and is
# unlikely to recover mid-flight, so we fail over to the backup immediately instead
# of retrying the slow/dead primary.
UNRESPONSIVE_ERROR_KEYWORDS = (
    "timeout",
    "timed out",
    "gateway timeout",
    "connection aborted",
    "connection reset",
    "connection refused",
    "connection error",
    "winerror 10053",
    "winerror 10054",
)

# Substrings meaning a server-side transient (5xx / temporary). These return
# quickly, so a brief backoff retry is cheap and may succeed before falling back.
RETRYABLE_ERROR_KEYWORDS = (
    "temporarily unavailable",
    "server error",
    "bad gateway",
    "service unavailable",
    "bad_response_status_code",
)

# Substrings that indicate permanent errors (quota exhausted / auth).
PERMANENT_ERROR_KEYWORDS = (
    "insufficient balance",
    "insufficient_quota",
    "quota",
    "exceeded",
    "欠费",
    "余额不足",
    "额度",
    "payment required",
    "unauthorized",
    "invalid api key",
    "api key invalid",
    "authentication",
    "forbidden",
    "rate limit",
    "too many requests",
)


def _extract_status_code(error: Exception) -> int | None:
    """Extract an HTTP status code from an exception if available."""
    status = getattr(error, "status_code", None)
    if isinstance(status, int):
        return status

    response = getattr(error, "response", None)
    resp_status = getattr(response, "status_code", None)
    if isinstance(resp_status, int):
        return resp_status

    error_str = str(error)
    for code in TRANSIENT_STATUS_CODES | PERMANENT_STATUS_CODES:
        if str(code) in error_str:
            return code
    return None


def classify_error(error: Exception) -> str:
    """Classify an error as ``"unresponsive"``, ``"transient"`` or ``"permanent"``.

    - ``permanent`` (quota / auth): fail over to the backup immediately.
    - ``unresponsive`` (timeout / connection down): fail over immediately too —
      retrying a slow or dead primary just multiplies the wait.
    - ``transient`` (5xx / unknown): retry with backoff, then fall back.
    """
    error_str = str(error).lower()

    # Permanent (quota exhausted / auth) wins — never retry these.
    for keyword in PERMANENT_ERROR_KEYWORDS:
        if keyword in error_str:
            return "permanent"

    # Unresponsive primary (timeout / connection) — fail over fast, do not retry.
    for keyword in UNRESPONSIVE_ERROR_KEYWORDS:
        if keyword in error_str:
            return "unresponsive"

    status_code = _extract_status_code(error)
    if status_code in PERMANENT_STATUS_CODES:
        return "permanent"
    if status_code in TRANSIENT_STATUS_CODES:
        return "transient"

    for keyword in RETRYABLE_ERROR_KEYWORDS:
        if keyword in error_str:
            return "transient"

    # OpenAI SDK timeout / connection exceptions → unresponsive (fast failover).
    try:
        import openai as _openai

        if isinstance(error, (_openai.APITimeoutError, _openai.APIConnectionError)):
            return "unresponsive"
    except Exception:
        pass

    # Connection / timeout style built-ins → unresponsive.
    if isinstance(error, (TimeoutError, ConnectionError, OSError)):
        return "unresponsive"

    # Default to transient (safer: brief retry, then still fall back).
    return "transient"


# =============================================================================
# Retry Policy
# =============================================================================

class RetryPolicy:
    """Exponential backoff retry policy with optional jitter."""

    def __init__(
        self,
        max_retries: int = 3,
        initial_delay_ms: int = 1000,
        max_delay_ms: int = 30000,
        backoff_multiplier: float = 2.0,
        jitter: bool = True,
    ):
        self.max_retries = max_retries
        self.initial_delay_ms = initial_delay_ms
        self.max_delay_ms = max_delay_ms
        self.backoff_multiplier = backoff_multiplier
        self.jitter = jitter

    def get_delay_ms(self, attempt: int) -> int:
        """Delay for a given retry attempt (1-indexed)."""
        delay = self.initial_delay_ms * (self.backoff_multiplier ** (attempt - 1))
        delay = min(delay, self.max_delay_ms)
        if self.jitter:
            delay = delay * (0.75 + random.random() * 0.5)
        return int(delay)

    def should_retry(self, attempt: int) -> bool:
        return attempt < self.max_retries


# =============================================================================
# Fallback LLM
# =============================================================================

class FallbackLLM(BaseLLM):
    """Wrapper LLM that provides automatic fallback to a backup LLM.

    1. Attempts the primary LLM.
    2. On transient errors, retries with exponential backoff.
    3. On permanent errors or retry exhaustion, degrades to the backup LLM.
    """

    def __init__(self, primary: BaseLLM, fallback_config: LLMFallbackConfig):
        self.primary = primary
        self.fallback_config = fallback_config

        # Expose the primary's config so callers reading `.config` keep working.
        self.config = getattr(primary, "config", None)

        self.retry_policy = RetryPolicy(
            max_retries=fallback_config.max_retries,
            initial_delay_ms=fallback_config.initial_delay_ms,
            max_delay_ms=fallback_config.max_delay_ms,
            backoff_multiplier=fallback_config.backoff_multiplier,
            jitter=fallback_config.jitter,
        )

        self._fallback: BaseLLM | None = None
        self._primary_healthy = True
        self._consecutive_failures = 0
        # Circuit breaker: after the primary fails, skip it (go straight to the
        # backup) for a short cooldown, so multi-call requests (e.g. multi-chunk
        # extraction) don't re-pay the primary timeout on every call while it's down.
        self._open_until = 0.0
        self._circuit_cooldown_s = float(
            getattr(fallback_config, "primary_timeout", 60.0) or 60.0
        )

        logger.info(
            f"FallbackLLM initialized: max_retries={fallback_config.max_retries}, "
            f"fallback_backend={fallback_config.fallback_backend}, "
            f"fallback_model={fallback_config.fallback_model}"
        )

        # Bound a single primary attempt so failover happens within seconds of an
        # outage rather than after the OpenAI SDK's internal retries × read timeout.
        self._fast_fail_primary()

    def _fast_fail_primary(self) -> None:
        """Reconfigure the wrapped primary's OpenAI client to fail fast.

        Without this, a dead/slow primary costs (SDK max_retries) × (read timeout)
        per call — minutes — before this wrapper ever sees the error, blowing past
        upstream (MCP / HTTP) timeouts. We disable the SDK's own retries and cap the
        request timeout, so a primary outage surfaces quickly and we fail over to the
        backup. Only applies to OpenAI-compatible primaries that expose a ``client``.
        """
        timeout_s = float(getattr(self.fallback_config, "primary_timeout", 60.0) or 60.0)
        client = getattr(self.primary, "client", None)
        if client is None or not hasattr(client, "with_options"):
            return
        try:
            self.primary.client = client.with_options(max_retries=0, timeout=timeout_s)
            logger.info(
                f"FallbackLLM: primary bounded to fast-fail "
                f"(sdk max_retries=0, timeout={timeout_s}s)"
            )
        except Exception as e:  # never let hardening break normal operation
            logger.warning(f"FallbackLLM: could not fast-fail-configure primary: {e}")

    # -- fallback construction ------------------------------------------------

    @property
    def fallback(self) -> BaseLLM:
        """Lazy-load the backup LLM."""
        if self._fallback is None:
            self._fallback = self._create_fallback_llm()
        return self._fallback

    def _create_fallback_llm(self) -> BaseLLM:
        """Build the backup LLM directly.

        Built directly (not via ``LLMFactory.from_config``) so the backup is never
        itself wrapped in another ``FallbackLLM``. Mirrors
        ``FallbackEmbedder._create_fallback_embedder``.
        """
        cfg = self.fallback_config
        backend = (cfg.fallback_backend or "openai").lower()

        if backend in ("openai", "azure", "deepseek", "qwen", "vllm", "openai_new"):
            # LongCat and most relays are OpenAI-compatible; use the OpenAI client.
            from oh_memos.llms.openai import OpenAILLM

            fallback_config = OpenAILLMConfig(
                model_name_or_path=cfg.fallback_model,
                api_key=cfg.fallback_api_key,
                api_base=cfg.fallback_api_base,
                temperature=cfg.fallback_temperature,
                max_tokens=cfg.fallback_max_tokens,
                remove_think_prefix=True,
            )
            logger.info(
                f"Creating OpenAI-compatible fallback LLM: "
                f"model={cfg.fallback_model}, api_base={cfg.fallback_api_base}"
            )
            return OpenAILLM(fallback_config)

        raise ValueError(
            f"Unsupported LLM fallback backend: {cfg.fallback_backend}. "
            f"Only OpenAI-compatible backends are supported."
        )

    # -- generation -----------------------------------------------------------

    def _is_circuit_open(self) -> bool:
        """True when the primary recently failed and is still within its cooldown.

        While open we skip the (known-down) primary and use the backup directly.
        """
        return self._consecutive_failures > 0 and time.time() < self._open_until

    def generate(self, messages: MessageList, **kwargs) -> str:
        """Generate with automatic retry and fallback."""
        # Circuit breaker: while the primary is known-down (a recent failure still
        # within cooldown), skip it and use the backup directly — avoids re-paying the
        # primary timeout on every call in a multi-call request (e.g. chunked extraction).
        if self._is_circuit_open():
            try:
                return self.fallback.generate(messages, **kwargs)
            except Exception as fb_err:
                logger.warning(
                    f"Backup failed while primary circuit open ({type(fb_err).__name__}); "
                    f"re-probing primary"
                )
                # fall through to give the primary a half-open probe

        last_error: Exception | None = None

        for attempt in range(1, self.retry_policy.max_retries + 2):  # initial + retries
            try:
                result = self.primary.generate(messages, **kwargs)
                if self._consecutive_failures > 0:
                    logger.info("Primary LLM recovered after fallback")
                self._consecutive_failures = 0
                self._primary_healthy = True
                self._open_until = 0.0
                return result
            except Exception as e:
                last_error = e
                error_type = classify_error(e)
                logger.warning(
                    f"Primary LLM failed (attempt {attempt}): {type(e).__name__}: {e}"
                )

                if error_type in ("permanent", "unresponsive"):
                    reason = (
                        "Permanent error (quota/auth)"
                        if error_type == "permanent"
                        else "Primary unresponsive (timeout/connection)"
                    )
                    logger.warning(
                        f"{reason} ({type(e).__name__}); skipping retries and failing over"
                    )
                    break

                if not self.retry_policy.should_retry(attempt):
                    logger.warning(
                        f"Max retries ({self.retry_policy.max_retries}) exhausted"
                    )
                    break

                delay_ms = self.retry_policy.get_delay_ms(attempt)
                logger.info(f"Waiting {delay_ms}ms before retry {attempt}...")
                time.sleep(delay_ms / 1000.0)

        # Primary failed -> open the circuit and degrade to the fallback LLM.
        self._consecutive_failures += 1
        self._primary_healthy = False
        self._open_until = time.time() + self._circuit_cooldown_s
        logger.warning(
            f"Falling back to {self.fallback_config.fallback_model} "
            f"(consecutive failures: {self._consecutive_failures}; "
            f"pausing primary ~{int(self._circuit_cooldown_s)}s)"
        )

        try:
            return self.fallback.generate(messages, **kwargs)
        except Exception as fallback_error:
            logger.error(
                f"Fallback LLM also failed: {type(fallback_error).__name__}: {fallback_error}"
            )
            if last_error is not None:
                raise last_error
            raise

    def generate_stream(self, messages: MessageList, **kwargs) -> Generator[str, None, None]:
        """Stream from the primary LLM; degrade to the fallback if it fails before
        emitting any token. Once tokens have been yielded a mid-stream error is
        re-raised (we cannot safely restart a partially consumed stream)."""
        yielded = False
        try:
            for chunk in self.primary.generate_stream(messages, **kwargs):
                yielded = True
                yield chunk
            if self._consecutive_failures > 0:
                logger.info("Primary LLM (stream) recovered after fallback")
                self._consecutive_failures = 0
                self._primary_healthy = True
            return
        except Exception as e:
            if yielded:
                logger.error(
                    f"Primary LLM stream failed mid-stream, cannot fall back: "
                    f"{type(e).__name__}: {e}"
                )
                raise
            self._consecutive_failures += 1
            self._primary_healthy = False
            logger.warning(
                f"Primary LLM stream failed ({type(e).__name__}: {e}); "
                f"falling back to {self.fallback_config.fallback_model}"
            )

        yield from self.fallback.generate_stream(messages, **kwargs)

    # -- health ---------------------------------------------------------------

    def is_primary_healthy(self) -> bool:
        return self._primary_healthy

    def get_consecutive_failures(self) -> int:
        return self._consecutive_failures


def wrap_llm_with_fallback(primary: BaseLLM, fallback_config: LLMFallbackConfig) -> BaseLLM:
    """Wrap an LLM with fallback support if enabled, otherwise return it unchanged."""
    if getattr(fallback_config, "enabled", False):
        return FallbackLLM(primary, fallback_config)
    return primary

import asyncio
import json
import logging
import os
import threading
import time
import warnings

from datetime import datetime
from typing import Any, Generic, Literal, TypeVar

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.requests import Request
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel, Field, field_validator

from oh_memos.api.config import APIConfig
from oh_memos.api.handlers.graph_handler import (
    GraphHandler,
    HandlerDependencies,
    neo4j_schema_stats,
)
from oh_memos.api.middleware.request_context import RequestContextMiddleware
from oh_memos.api.product_models import (
    APIAddRelationRequest,
    APIGraphRequest,
    APISchemaRequest,
    APITracePathRequest,
    ComponentHealth,
    GraphData,
    GraphResponse,
    HealthDetailData,
    HealthDetailResponse,
    HealthResponse,
    HealthStatus,
    PathEdge,
    PathNode,
    SchemaData,
    SchemaResponse,
    SimpleResponse,
    TracePath,
    TracePathData,
    TracePathResponse,
)
from oh_memos.configs.mem_os import MOSConfig
from oh_memos.mem_os.main import MOS
from oh_memos.mem_user.user_manager import UserManager, UserRole
from oh_memos.security.redact import redact_obj, redact_text


# Suppress harmless warnings
warnings.filterwarnings("ignore", message=".*PyTorch.*TensorFlow.*Flax.*")
warnings.filterwarnings("ignore", message=".*PydanticSerializationUnexpectedValue.*")

# Configure logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

# Load environment variables
load_dotenv(override=True)

# When the Docker API shares this process's Neo4j/Qdrant, only one instance may
# run archive/reorganization writers. This explicit process-level switch is read
# after dotenv because src/.env intentionally overrides ordinary environment
# values at startup.
if os.environ.get("MEMOS_DISABLE_BACKGROUND_WRITERS", "").lower() == "true":
    os.environ["MEMOS_AUTO_ARCHIVE"] = "false"
    os.environ["MOS_ENABLE_REORGANIZE"] = "false"

T = TypeVar("T")

# Use product default config which includes mem_reader
DEFAULT_CONFIG = APIConfig.get_product_default_config()

# Initialize MOS instance with lazy initialization
MOS_INSTANCE = None
_mos_init_lock = threading.Lock()


def get_mos_instance():
    """Get or create MOS instance with default user creation."""
    global MOS_INSTANCE
    if MOS_INSTANCE is None:
        with _mos_init_lock:
            if MOS_INSTANCE is None:
                # Create a temporary MOS instance to access user manager
                temp_config = MOSConfig(**DEFAULT_CONFIG)
                temp_mos = MOS.__new__(MOS)
                temp_mos.config = temp_config
                temp_mos.user_id = temp_config.user_id
                temp_mos.session_id = temp_config.session_id
                temp_mos.mem_cubes = {}
                temp_mos.chat_llm = None  # Will be initialized later
                temp_mos.user_manager = UserManager()

                # Create default user if it doesn't exist
                if not temp_mos.user_manager.validate_user(temp_config.user_id):
                    temp_mos.user_manager.create_user(
                        user_name=temp_config.user_id, role=UserRole.USER, user_id=temp_config.user_id
                    )
                    logger.info(f"Created default user: {temp_config.user_id}")

                # Now create the actual MOS instance
                MOS_INSTANCE = MOS(config=temp_config)

    return MOS_INSTANCE


# Initialize graph handler
GRAPH_HANDLER = None
_graph_handler_init_lock = threading.Lock()


def get_graph_handler():
    """Lazy initialize GraphHandler with the current MOS instance's graph DB."""
    global GRAPH_HANDLER
    if GRAPH_HANDLER is None:
        with _graph_handler_init_lock:
            if GRAPH_HANDLER is None:
                mos = get_mos_instance()
                # Find a cube that has a graph_store
                graph_db = None
                # Try to get from the default cube if specified
                default_cube_id = os.environ.get("MEMOS_DEFAULT_CUBE", "dev_cube")
                if default_cube_id in mos.mem_cubes:
                    cube = mos.mem_cubes[default_cube_id]
                    if hasattr(cube, "text_mem") and hasattr(cube.text_mem, "graph_store"):
                        graph_db = cube.text_mem.graph_store

                # If not found, take the first available
                if not graph_db:
                    for cube in mos.mem_cubes.values():
                        if hasattr(cube, "text_mem") and hasattr(cube.text_mem, "graph_store"):
                            graph_db = cube.text_mem.graph_store
                            break

                if not graph_db:
                    logger.warning("No graph database found in any memory cube")

                deps = HandlerDependencies(graph_db=graph_db)
                GRAPH_HANDLER = GraphHandler(deps)
    return GRAPH_HANDLER


app = FastAPI(
    title="MemOS REST APIs",
    description="A REST API for managing and searching memories using MemOS.",
    version="1.0.0",
)

app.add_middleware(RequestContextMiddleware)


# Server start time for uptime calculation
_server_start_time = time.time()


# =============================================================================
# Health Check Endpoints
# =============================================================================


@app.get("/health", summary="Health check", response_model=HealthResponse)
async def health_check():
    """
    Simple health check for load balancers and k8s probes.

    Returns overall system status:
    - ok: All components operational
    - degraded: Non-critical components unavailable
    - down: Critical components unavailable
    """
    from datetime import datetime, timezone

    components = await asyncio.to_thread(_check_all_components)
    overall = _compute_overall_status(components)

    return HealthResponse(
        code=200,
        message=overall,
        data=HealthStatus(
            status=overall,
            timestamp=datetime.now(timezone.utc).isoformat(),
        ),
    )


@app.get("/health/detail", summary="Detailed health check", response_model=HealthDetailResponse)
async def health_check_detail():
    """
    Detailed health check showing all component statuses.

    Returns status, latency, and error information for each component:
    - neo4j: Graph database
    - qdrant: Vector database
    """
    from datetime import datetime, timezone

    components = await asyncio.to_thread(_check_all_components)
    overall = _compute_overall_status(components)

    messages = {
        "ok": "All systems operational",
        "degraded": "Some non-critical components unavailable",
        "down": "Critical components unavailable",
    }

    return HealthDetailResponse(
        code=200,
        message=messages.get(overall, "Unknown status"),
        data=HealthDetailData(
            overall_status=overall,
            timestamp=datetime.now(timezone.utc).isoformat(),
            uptime_seconds=round(time.time() - _server_start_time, 2),
            components=components,
        ),
    )


def _check_all_components() -> dict[str, ComponentHealth]:
    """Check health of all components."""
    components = {}
    components["neo4j"] = _check_neo4j()
    components["qdrant"] = _check_qdrant()
    return components


def _compute_overall_status(components: dict[str, ComponentHealth]) -> str:
    """Compute overall system status."""
    critical = {"neo4j", "qdrant"}

    for comp_name in critical:
        comp = components.get(comp_name)
        if comp is None or comp.status != "ok":
            return "down"

    all_ok = all(c.status == "ok" for c in components.values())
    return "ok" if all_ok else "degraded"


def _check_neo4j() -> ComponentHealth:
    """Check Neo4j connection."""
    import time as _time

    try:
        mos = get_mos_instance()
        graph_db = None

        # Find graph_db from any cube
        for cube in mos.mem_cubes.values():
            if hasattr(cube, "text_mem") and hasattr(cube.text_mem, "graph_store"):
                graph_db = cube.text_mem.graph_store
                break

        if graph_db is None:
            return ComponentHealth(status="unavailable", error="No graph database configured")

        driver = getattr(graph_db, "driver", None)
        if driver is None:
            return ComponentHealth(status="unavailable", error="No driver available")

        start = _time.perf_counter()
        with driver.session() as session:
            result = session.run("RETURN 1 AS health_check")
            result.single()
        latency = (_time.perf_counter() - start) * 1000

        return ComponentHealth(status="ok", latency_ms=round(latency, 2))

    except Exception as e:
        logger.warning(f"Neo4j health check failed: {e}")
        return ComponentHealth(status="error", error=str(e)[:200])


def _check_qdrant() -> ComponentHealth:
    """Check Qdrant connection."""
    import time as _time

    try:
        mos = get_mos_instance()
        vector_db = None

        # Find vector_db from any cube
        for cube in mos.mem_cubes.values():
            if hasattr(cube, "text_mem"):
                # Try to find vec_db in graph_store (for Neo4jCommunity)
                graph_store = getattr(cube.text_mem, "graph_store", None)
                if graph_store and hasattr(graph_store, "vec_db"):
                    vector_db = graph_store.vec_db
                    break

        if vector_db is None:
            return ComponentHealth(status="unavailable", error="No vector database configured")

        client = getattr(vector_db, "client", None)
        if client is None:
            return ComponentHealth(status="unavailable", error="No client available")

        start = _time.perf_counter()
        client.get_collections()
        latency = (_time.perf_counter() - start) * 1000

        return ComponentHealth(status="ok", latency_ms=round(latency, 2))

    except Exception as e:
        logger.warning(f"Qdrant health check failed: {e}")
        return ComponentHealth(status="error", error=str(e)[:200])


# =============================================================================
# Auto-Archive Background Task
# =============================================================================

_archive_task = None


def _get_neo4j_driver():
    """Get Neo4j driver from MOS instance for archiver."""
    try:
        mos = get_mos_instance()
        for cube in mos.mem_cubes.values():
            if hasattr(cube, "text_mem"):
                graph_store = getattr(cube.text_mem, "graph_store", None)
                if graph_store and hasattr(graph_store, "driver"):
                    return graph_store.driver
    except Exception as e:
        logger.warning(f"Could not get Neo4j driver for archiver: {e}")
    return None


@app.on_event("startup")
async def startup_archiver():
    """Start background archive task if enabled."""
    global _archive_task

    auto_archive = os.environ.get("MEMOS_AUTO_ARCHIVE", "true").lower() == "true"
    if not auto_archive:
        logger.info("Startup: Auto-archive is disabled")
        return

    try:
        from oh_memos.mem_scheduler.archiver import periodic_archive_task

        _archive_task = asyncio.create_task(
            periodic_archive_task(_get_neo4j_driver)
        )
        logger.info("Startup: Archive background task started")
    except Exception as e:
        logger.warning(f"Startup: Failed to start archive task: {e}")


@app.on_event("shutdown")
async def shutdown_archiver():
    """Cancel archive task on shutdown."""
    global _archive_task
    if _archive_task:
        _archive_task.cancel()
        try:
            await _archive_task
        except asyncio.CancelledError:
            pass
        logger.info("Shutdown: Archive task cancelled")


# =============================================================================
# Archive API Endpoints
# =============================================================================


@app.post("/archive/run", summary="Run archive manually")
async def run_archive():
    """
    Manually trigger the archive process.

    Archives expired memories based on configured TTL and types.

    Refused when this instance has handed archiving to another one (host-db
    mode): disabling only the periodic task would still leave this endpoint able
    to archive the shared graph concurrently with the owner.
    """
    if os.environ.get("MEMOS_DISABLE_BACKGROUND_WRITERS", "").lower() == "true":
        raise HTTPException(
            status_code=409,
            detail=(
                "Archiving is owned by another instance "
                "(MEMOS_DISABLE_BACKGROUND_WRITERS=true). Run it there instead."
            ),
        )

    driver = _get_neo4j_driver()
    if not driver:
        return {"code": 500, "message": "Neo4j driver not available", "data": None}

    try:
        from oh_memos.mem_scheduler.archiver import archive_expired_memories_sync, get_archive_config

        config = get_archive_config()
        archived_count = archive_expired_memories_sync(
            driver,
            ttl_days=config["ttl_days"],
            archive_types=config["archive_types"],
        )

        return {
            "code": 200,
            "message": f"Archive completed: {archived_count} memories archived",
            "data": {
                "archived_count": archived_count,
                "ttl_days": config["ttl_days"],
                "archive_types": config["archive_types"],
            }
        }
    except Exception as e:
        logger.error(f"Manual archive failed: {e}")
        return {"code": 500, "message": str(e), "data": None}


@app.get("/archive/stats", summary="Get archive statistics")
async def get_archive_stats():
    """
    Get statistics about archived vs active memories.
    """
    driver = _get_neo4j_driver()
    if not driver:
        return {"code": 500, "message": "Neo4j driver not available", "data": None}

    try:
        from oh_memos.mem_scheduler.archiver import get_archive_stats_sync, get_archive_config

        stats = get_archive_stats_sync(driver)
        config = get_archive_config()

        return {
            "code": 200,
            "message": "Stats retrieved",
            "data": {
                "status_counts": stats,
                "config": {
                    "enabled": config["enabled"],
                    "ttl_days": config["ttl_days"],
                    "archive_types": config["archive_types"],
                    "interval_seconds": config["interval_seconds"],
                }
            }
        }
    except Exception as e:
        logger.error(f"Failed to get archive stats: {e}")
        return {"code": 500, "message": str(e), "data": None}


@app.post("/archive/restore/{memory_id}", summary="Restore archived memory")
async def restore_archived_memory(memory_id: str):
    """
    Restore an archived memory back to active status.
    """
    driver = _get_neo4j_driver()
    if not driver:
        return {"code": 500, "message": "Neo4j driver not available", "data": None}

    try:
        from oh_memos.mem_scheduler.archiver import restore_archived_memory_sync

        restored = restore_archived_memory_sync(driver, memory_id)

        if restored:
            return {
                "code": 200,
                "message": f"Memory {memory_id} restored",
                "data": {"memory_id": memory_id, "restored": True}
            }
        else:
            return {
                "code": 404,
                "message": f"Memory {memory_id} not found or not archived",
                "data": {"memory_id": memory_id, "restored": False}
            }
    except Exception as e:
        logger.error(f"Failed to restore memory {memory_id}: {e}")
        return {"code": 500, "message": str(e), "data": None}


def _get_cubes_dir() -> str | None:
    """Get the cubes base directory from environment."""
    cubes_dir = os.environ.get(
        "MEMOS_CUBES_DIR",
        os.environ.get("MOS_CUBES_DIR", os.environ.get("MOS_CUBE_PATH", ""))
    )
    if not cubes_dir:
        return None
    if not os.path.isabs(cubes_dir):
        cubes_dir = os.path.abspath(os.path.join(os.getcwd(), "..", cubes_dir))
    return cubes_dir


def _ensure_cube_directory(cubes_dir: str, cube_id: str) -> str | None:
    """Create cube directory with config cloned from default cube.

    Returns cube_path on success, None on failure.
    """
    cube_path = os.path.join(cubes_dir, cube_id)
    config_path = os.path.join(cube_path, "config.json")

    if os.path.isdir(cube_path) and os.path.isfile(config_path):
        return cube_path

    # Find default cube config as template
    default_cube_id = os.environ.get("MEMOS_DEFAULT_CUBE", "dev_cube")
    template_config_path = os.path.join(cubes_dir, default_cube_id, "config.json")

    if not os.path.isfile(template_config_path):
        logger.warning(f"No template config at {template_config_path}, cannot auto-create cube")
        return None

    try:
        with open(template_config_path, encoding="utf-8") as f:
            config = json.load(f)

        # Deep clone and update for new cube_id
        config = json.loads(json.dumps(config))
        config["cube_id"] = cube_id

        text_mem = config.get("text_mem", {})
        text_cfg = text_mem.get("config", {}) if isinstance(text_mem, dict) else {}
        if isinstance(text_cfg, dict):
            if "cube_id" in text_cfg:
                text_cfg["cube_id"] = cube_id

            graph_db = text_cfg.get("graph_db", {})
            graph_cfg = graph_db.get("config", {}) if isinstance(graph_db, dict) else {}
            if isinstance(graph_cfg, dict):
                if graph_cfg.get("use_multi_db") is False or "user_name" in graph_cfg:
                    graph_cfg["user_name"] = cube_id
                vec_cfg = graph_cfg.get("vec_config", {}).get("config")
                if isinstance(vec_cfg, dict) and "collection_name" in vec_cfg:
                    vec_cfg["collection_name"] = f"{cube_id}_graph"

            vector_db = text_cfg.get("vector_db", {})
            vector_cfg = vector_db.get("config") if isinstance(vector_db, dict) else {}
            if isinstance(vector_cfg, dict) and "collection_name" in vector_cfg:
                vector_cfg["collection_name"] = f"{cube_id}_collection"

        os.makedirs(cube_path, exist_ok=True)
        with open(config_path, "w", encoding="utf-8") as f:
            json.dump(config, f, ensure_ascii=False, indent=2)

        logger.info(f"Auto-created cube directory: {cube_path}")
        return cube_path
    except Exception as e:
        logger.warning(f"Failed to auto-create cube directory {cube_id}: {e}")
        return None


def _redact_text_or_log(text: str, *, where: str) -> str:
    """Redact credentials from text, recording which kinds were found.

    The log line names the credential *kind* only — never the value — so that
    the warning itself doesn't become the leak it is trying to prevent.
    """
    cleaned, labels = redact_text(text)
    if labels:
        logger.warning(f"[{where}] redacted credentials before storing: {', '.join(labels)}")
    return cleaned


def _try_auto_register_cube(mos_instance, mem_cube_id: str, user_id: str) -> bool:
    """Try to auto-register a cube on-demand. Returns True on success."""
    # Check if already loaded
    _, existing = mos_instance._find_mem_cube(mem_cube_id)
    if existing is not None:
        return True

    cubes_dir = _get_cubes_dir()
    if not cubes_dir:
        return False

    cube_path = os.path.join(cubes_dir, mem_cube_id)

    # Auto-create directory if missing
    if not os.path.exists(cube_path):
        cube_path = _ensure_cube_directory(cubes_dir, mem_cube_id)
        if cube_path is None:
            return False

    try:
        mos_instance.register_mem_cube(cube_path, mem_cube_id=mem_cube_id, user_id=user_id)
        logger.info(f"Auto-registered cube on-demand: {mem_cube_id}")
        return True
    except Exception as e:
        logger.warning(f"Failed to auto-register cube {mem_cube_id}: {e}")
        return False


# Auto-register default cube on startup
@app.on_event("startup")
async def startup_auto_register():
    """Auto-register the default memory cube on API startup.

    Only registers the default cube (and any listed in MEMOS_STARTUP_CUBES)
    to keep startup fast. Other cubes are registered on-demand via the
    /mem_cubes API when the MCP server needs them.
    """
    default_cube_id = os.environ.get("MEMOS_DEFAULT_CUBE", "dev_cube")
    cubes_dir = os.environ.get(
        "MEMOS_CUBES_DIR",
        os.environ.get("MOS_CUBES_DIR", os.environ.get("MOS_CUBE_PATH", ""))
    )

    if not cubes_dir:
        logger.info("Startup: No cubes directory set, skipping auto-registration")
        return

    # Convert relative path to absolute if needed
    if not os.path.isabs(cubes_dir):
        cubes_dir = os.path.abspath(os.path.join(os.getcwd(), "..", cubes_dir))
        logger.info(f"Startup: Converted relative cubes_dir to absolute: {cubes_dir}")

    if not os.path.isdir(cubes_dir):
        logger.warning(f"Startup: Cubes directory not found at {cubes_dir}")
        return

    # Determine which cubes to register at startup
    # Default: only the default cube. Set MEMOS_STARTUP_CUBES=all to register all,
    # or MEMOS_STARTUP_CUBES=cube1,cube2 for specific cubes.
    startup_cubes_env = os.environ.get("MEMOS_STARTUP_CUBES", "").strip()
    if startup_cubes_env.lower() == "all":
        # Legacy behavior: register everything
        startup_cube_ids = [
            item for item in os.listdir(cubes_dir)
            if os.path.isdir(os.path.join(cubes_dir, item))
            and os.path.isfile(os.path.join(cubes_dir, item, "config.json"))
        ]
        logger.info(f"Startup: MEMOS_STARTUP_CUBES=all, will register {len(startup_cube_ids)} cubes")
    elif startup_cubes_env:
        startup_cube_ids = [c.strip() for c in startup_cubes_env.split(",") if c.strip()]
    else:
        startup_cube_ids = [default_cube_id]

    # Count available cubes for info log
    all_cubes = [
        item for item in os.listdir(cubes_dir)
        if os.path.isdir(os.path.join(cubes_dir, item))
        and os.path.isfile(os.path.join(cubes_dir, item, "config.json"))
    ]
    logger.info(
        f"Startup: {len(all_cubes)} cubes available, "
        f"registering {len(startup_cube_ids)} at startup: {startup_cube_ids}"
    )

    # Wait for Qdrant to be ready
    qdrant_host = os.environ.get("QDRANT_HOST", "localhost")
    qdrant_port = os.environ.get("QDRANT_PORT", "16333")
    qdrant_health_url = f"http://{qdrant_host}:{qdrant_port}/"
    qdrant_ready = False
    import httpx as _httpx
    for attempt in range(20):  # up to 20s
        try:
            async with _httpx.AsyncClient(timeout=2.0) as hc:
                resp = await hc.get(qdrant_health_url)
                if resp.status_code == 200:
                    qdrant_ready = True
                    logger.info(f"Startup: Qdrant ready after {attempt + 1}s")
                    break
        except _httpx.ConnectError:
            logger.warning(
                f"Startup: Qdrant not running at {qdrant_host}:{qdrant_port}. "
                "Start Qdrant first for cube auto-registration."
            )
            break
        except Exception:
            pass
        await asyncio.sleep(1)

    if not qdrant_ready:
        logger.warning("Startup: Qdrant not ready, skipping cube auto-registration")
        return

    # Check Neo4j readiness if tree_text mode is enabled
    neo4j_ready = False
    mem_type = os.environ.get("MOS_TEXT_MEM_TYPE", "general_text")
    if mem_type == "tree_text":
        neo4j_uri = os.environ.get("NEO4J_URI", "bolt://localhost:7687")
        import re as _re
        _m = _re.search(r"://([^/]+)", neo4j_uri)
        neo4j_addr = _m.group(1) if _m else "localhost:7687"
        neo4j_host, _, neo4j_port = neo4j_addr.partition(":")
        neo4j_port = neo4j_port or "7687"

        import socket as _socket
        for attempt in range(15):
            try:
                with _socket.create_connection((neo4j_host, int(neo4j_port)), timeout=2):
                    neo4j_ready = True
                    logger.info(f"Startup: Neo4j ready at {neo4j_addr} after {attempt + 1}s")
                    break
            except OSError:
                if attempt == 0:
                    logger.info(f"Startup: Waiting for Neo4j at {neo4j_addr}...")
                await asyncio.sleep(1)

        if not neo4j_ready:
            logger.warning(
                f"Startup: Neo4j not available at {neo4j_addr}. "
                "Cubes will be registered without graph indexes."
            )
    else:
        neo4j_ready = True

    mos_instance = get_mos_instance()
    default_user = mos_instance.user_id

    # Register only the selected startup cubes
    registered_count = 0
    for cube_id in startup_cube_ids:
        cube_path = os.path.join(cubes_dir, cube_id)
        config_path = os.path.join(cube_path, "config.json")
        if not os.path.isdir(cube_path) or not os.path.isfile(config_path):
            logger.warning(f"Startup: Cube '{cube_id}' not found at {cube_path}, skipping")
            continue

        t0 = time.time()
        for retry in range(3):
            try:
                mos_instance.register_mem_cube(
                    mem_cube_name_or_path=cube_path,
                    mem_cube_id=cube_id,
                    user_id=default_user,
                )
                elapsed = time.time() - t0
                logger.info(f"Startup: Registered cube '{cube_id}' in {elapsed:.1f}s")
                registered_count += 1
                break
            except Exception as e:
                err_str = str(e)
                if "502" in err_str and retry < 2:
                    logger.debug(f"Startup: Cube '{cube_id}' retry {retry + 1}/3: {e}")
                    await asyncio.sleep(3)
                else:
                    logger.warning(f"Startup: Failed to register cube '{cube_id}': {e}")
                    break

    logger.info(f"Startup: {registered_count}/{len(startup_cube_ids)} cubes registered")



class BaseRequest(BaseModel):
    """Base model for all requests."""

    user_id: str | None = Field(
        None, description="User ID for the request", json_schema_extra={"example": "user123"}
    )


class BaseResponse(BaseModel, Generic[T]):
    """Base model for all responses."""

    code: int = Field(200, description="Response status code", json_schema_extra={"example": 200})
    message: str = Field(
        ..., description="Response message", json_schema_extra={"example": "Operation successful"}
    )
    data: T | None = Field(None, description="Response data")


class Message(BaseModel):
    role: str = Field(
        ...,
        description="Role of the message (user or assistant).",
        json_schema_extra={"example": "user"},
    )
    content: str = Field(
        ...,
        description="Message content.",
        json_schema_extra={"example": "Hello, how can I help you?"},
    )
    chat_time: str | None = Field(
        None,
        description="Message timestamp in ISO 8601 format (e.g., '2024-01-15T10:30:00Z'). Used by evaluation harnesses to preserve temporal order.",
        json_schema_extra={"example": "2024-01-15T10:30:00Z"},
    )


class MemoryCreate(BaseRequest):
    messages: list[Message] | None = Field(
        None,
        description="List of messages to store.",
        json_schema_extra={"example": [{"role": "user", "content": "Hello"}]},
    )
    mem_cube_id: str | None = Field(
        None, description="ID of the memory cube", json_schema_extra={"example": "cube123"}
    )
    memory_content: str | None = Field(
        None,
        description="Content to store as memory",
        json_schema_extra={"example": "This is a memory content"},
    )
    doc_path: str | None = Field(
        None,
        description="Path to document to store",
        json_schema_extra={"example": "/path/to/document.txt"},
    )
    memory_type: str | None = Field(None, description="MCP business type, e.g. BUGFIX or DECISION")
    tags: list[str] | None = Field(None, description="User-defined memory tags")
    confidence: float | None = Field(None, ge=0.0, le=1.0, description="Confidence from 0 to 1")
    status: Literal["activated", "archived", "deleted"] | None = Field(None, description="Memory lifecycle status")
    created_at: str | None = Field(None, description="Original creation timestamp in ISO 8601 format")
    updated_at: str | None = Field(None, description="Last update timestamp in ISO 8601 format")
    source: Literal["conversation", "retrieved", "web", "file", "system"] | None = Field(None, description="Memory source")
    session_id: str | None = Field(None, description="Source session identifier")
    source_ref: str | None = Field(None, description="Source file, URL, or import reference")
    dialogue_id: str | None = Field(None, description="Dialogue identifier for evaluation tracking (e.g., LOCOMO dia_id)")
    turn_index: int | None = Field(None, ge=0, description="Turn index within a dialogue for evaluation tracking")

    @field_validator("created_at", "updated_at")
    @classmethod
    def validate_timestamp(cls, value: str | None) -> str | None:
        if value is not None:
            try:
                datetime.fromisoformat(value.replace("Z", "+00:00"))
            except ValueError as exc:
                raise ValueError("must be an ISO 8601 timestamp") from exc
        return value

    @field_validator("tags")
    @classmethod
    def validate_tags(cls, value: list[str] | None) -> list[str] | None:
        if value is not None and any(not tag.strip() for tag in value):
            raise ValueError("tags must contain non-empty strings")
        return value


class SearchRequest(BaseRequest):
    query: str = Field(
        ...,
        description="Search query.",
        json_schema_extra={"example": "How to implement a feature?"},
    )
    install_cube_ids: list[str] | None = Field(
        None,
        description="List of cube IDs to search in",
        json_schema_extra={"example": ["cube123", "cube456"]},
    )
    top_k: int | None = Field(
        None,
        description="Maximum number of results to return. Falls back to the server default when omitted.",
        json_schema_extra={"example": 10},
    )


class MemCubeRegister(BaseRequest):
    mem_cube_name_or_path: str = Field(
        ...,
        description="Name or path of the MemCube to register.",
        json_schema_extra={"example": "/path/to/cube"},
    )
    mem_cube_id: str | None = Field(
        None, description="ID for the MemCube", json_schema_extra={"example": "cube123"}
    )


class ChatRequest(BaseRequest):
    query: str = Field(
        ...,
        description="Chat query message.",
        json_schema_extra={"example": "What is the latest update?"},
    )


class UserCreate(BaseRequest):
    user_name: str | None = Field(
        None, description="Name of the user", json_schema_extra={"example": "john_doe"}
    )
    role: str = Field("user", description="Role of the user", json_schema_extra={"example": "user"})
    user_id: str = Field(..., description="User ID", json_schema_extra={"example": "user123"})


class CubeShare(BaseRequest):
    target_user_id: str = Field(
        ..., description="Target user ID to share with", json_schema_extra={"example": "user456"}
    )


class SimpleResponse(BaseResponse[None]):
    """Simple response model for operations without data return."""


class ConfigResponse(BaseResponse[None]):
    """Response model for configuration endpoint."""


class MemoryResponse(BaseResponse[dict]):
    """Response model for memory operations."""


class MemoryWriteResponse(BaseResponse[dict]):
    """Response model for memory writes, including created IDs."""


class SearchResponse(BaseResponse[dict]):
    """Response model for search operations."""


class ChatResponse(BaseResponse[str]):
    """Response model for chat operations."""


class UserResponse(BaseResponse[dict]):
    """Response model for user operations."""


class UserListResponse(BaseResponse[list]):
    """Response model for user list operations."""


@app.post("/configure", summary="Configure MemOS", response_model=ConfigResponse)
async def set_config(config: MOSConfig):
    """Set MemOS configuration."""
    global MOS_INSTANCE

    # Create a temporary user manager to check/create default user
    temp_user_manager = UserManager()

    # Create default user if it doesn't exist
    if not temp_user_manager.validate_user(config.user_id):
        temp_user_manager.create_user(
            user_name=config.user_id, role=UserRole.USER, user_id=config.user_id
        )
        logger.info(f"Created default user: {config.user_id}")

    # Now create the MOS instance
    MOS_INSTANCE = MOS(config=config)
    return ConfigResponse(message="Configuration set successfully")


@app.post("/users", summary="Create a new user", response_model=UserResponse)
async def create_user(user_create: UserCreate):
    """Create a new user."""
    mos_instance = get_mos_instance()
    role = UserRole(user_create.role)
    user_id = mos_instance.create_user(
        user_id=user_create.user_id, role=role, user_name=user_create.user_name
    )
    return UserResponse(message="User created successfully", data={"user_id": user_id})


@app.get("/users", summary="List all users", response_model=UserListResponse)
async def list_users():
    """List all active users."""
    mos_instance = get_mos_instance()
    users = mos_instance.list_users()
    return UserListResponse(message="Users retrieved successfully", data=users)


@app.get("/users/me", summary="Get current user info", response_model=UserResponse)
async def get_user_info():
    """Get current user information including accessible cubes."""
    mos_instance = get_mos_instance()
    user_info = mos_instance.get_user_info()
    return UserResponse(message="User info retrieved successfully", data=user_info)


@app.post("/mem_cubes", summary="Register a MemCube", response_model=SimpleResponse)
async def register_mem_cube(mem_cube: MemCubeRegister):
    """Register a new MemCube."""
    mos_instance = get_mos_instance()
    mos_instance.register_mem_cube(
        mem_cube_name_or_path=mem_cube.mem_cube_name_or_path,
        mem_cube_id=mem_cube.mem_cube_id,
        user_id=mem_cube.user_id,
    )
    return SimpleResponse(message="MemCube registered successfully")


@app.delete(
    "/mem_cubes/{mem_cube_id}", summary="Unregister a MemCube", response_model=SimpleResponse
)
async def unregister_mem_cube(mem_cube_id: str, user_id: str | None = None):
    """Unregister a MemCube."""
    mos_instance = get_mos_instance()
    mos_instance.unregister_mem_cube(mem_cube_id=mem_cube_id, user_id=user_id)
    return SimpleResponse(message="MemCube unregistered successfully")


@app.post(
    "/mem_cubes/{cube_id}/share",
    summary="Share a cube with another user",
    response_model=SimpleResponse,
)
async def share_cube(cube_id: str, share_request: CubeShare):
    """Share a cube with another user."""
    mos_instance = get_mos_instance()
    success = mos_instance.share_cube_with_user(cube_id, share_request.target_user_id)
    if success:
        return SimpleResponse(message="Cube shared successfully")
    else:
        raise ValueError("Failed to share cube")


# Graph endpoints
@app.post(
    "/product/graph/data", summary="Get graph data for visualization", response_model=GraphResponse
)
async def get_graph_data(graph_req: APIGraphRequest):
    """Fetch graph nodes and edges for visualization."""
    handler = get_graph_handler()
    return handler.handle_get_graph_data(graph_req)


@app.post(
    "/product/graph/trace_path", summary="Trace path between nodes", response_model=TracePathResponse
)
async def trace_path(req: APITracePathRequest):
    """Trace paths between two memory nodes."""
    handler = get_graph_handler()
    return handler.handle_trace_path(req)


@app.post(
    "/product/graph/schema", summary="Get graph schema", response_model=SchemaResponse
)
async def get_graph_schema(req: APISchemaRequest):
    """Get graph schema and statistics."""
    handler = get_graph_handler()
    # 方法名此前写作 handle_get_graph_schema，GraphHandler 上并不存在该属性，
    # 这个端点因此恒返回 500（实测：'GraphHandler' object has no attribute
    # 'handle_get_graph_schema'）。真实方法名是 handle_export_schema。
    return handler.handle_export_schema(req)


@app.post("/product/graph/relation", summary="Add graph relation", response_model=SimpleResponse)
async def add_graph_relation(req: APIAddRelationRequest):
    """
    Link two existing memories with one typed graph edge.

    This endpoint does not create or modify memory content; it only adds an edge
    between two memory IDs that must already exist in the same cube and user scope.
    """
    mos_instance = get_mos_instance()
    try:
        mos_instance.add_relation(
            mem_cube_id=req.mem_cube_id,
            source_id=req.source_id,
            target_id=req.target_id,
            relation_type=req.relation_type,
            user_id=req.user_id,
        )
        return SimpleResponse(message=f"Relation {req.relation_type} added between {req.source_id} and {req.target_id}")
    except ValueError as e:
        raise ValueError(str(e))  # caught by value_error_handler → 400


@app.post("/memories", summary="Create memories", response_model=MemoryWriteResponse)
def add_memory(memory_create: MemoryCreate):
    """Store new memories in a MemCube."""
    if not any([memory_create.messages, memory_create.memory_content, memory_create.doc_path]):
        raise ValueError("Either messages, memory_content, or doc_path must be provided")
    mos_instance = get_mos_instance()

    # Strip credentials before anything is embedded or persisted. Memories are
    # written automatically from whatever context the assistant holds (error
    # traces, config dumps), and a leaked key here gets re-read into the context
    # window by every later search — so redact at the boundary, not on read.
    if memory_create.memory_content:
        memory_create.memory_content = _redact_text_or_log(
            memory_create.memory_content, where="add_memory"
        )
    if memory_create.messages:
        for message in memory_create.messages:
            if getattr(message, "content", None):
                message.content = _redact_text_or_log(
                    message.content, where="add_memory/messages"
                )

    # Auto-register cube if needed
    if memory_create.mem_cube_id:
        target_user_id = memory_create.user_id or mos_instance.user_id
        _try_auto_register_cube(mos_instance, memory_create.mem_cube_id, target_user_id)

    created_ids: list[str] = []
    add_kwargs = {
        "mem_cube_id": memory_create.mem_cube_id,
        "user_id": memory_create.user_id,
        "session_id": memory_create.session_id,
        "return_details": True,
        "memory_type": memory_create.memory_type,
        "tags": memory_create.tags,
        "confidence": memory_create.confidence,
        "status": memory_create.status,
        "created_at": memory_create.created_at,
        "updated_at": memory_create.updated_at,
        "source": memory_create.source,
        "source_ref": memory_create.source_ref,
        "dialogue_id": memory_create.dialogue_id,
        "turn_index": memory_create.turn_index,
    }
    add_kwargs = {key: value for key, value in add_kwargs.items() if value is not None}

    write_details: dict[str, Any] = {
        "created_ids": [],
        "queued": False,
        "backend": "unknown",
        "warnings": [],
    }
    if memory_create.messages:
        messages = [m.model_dump() for m in memory_create.messages]
        write_details = mos_instance.add(messages=messages, **add_kwargs) or write_details
    elif memory_create.memory_content:
        write_details = mos_instance.add(memory_content=memory_create.memory_content, **add_kwargs) or write_details
    elif memory_create.doc_path:
        write_details = mos_instance.add(doc_path=memory_create.doc_path, **add_kwargs) or write_details

    if isinstance(write_details, list):
        write_details = {
            "created_ids": [str(mid) for mid in write_details],
            "queued": False,
            "backend": "unknown",
            "warnings": [],
        }

    created_ids = [str(mid) for mid in write_details.get("created_ids", [])]
    warnings_out = [str(w) for w in write_details.get("warnings", [])]
    if not created_ids and not write_details.get("queued"):
        warnings_out.append("ids_unavailable: write acknowledged but no memory ids were returned")

    return MemoryWriteResponse(
        message="Memories added successfully",
        data={
            "memory_ids": created_ids,
            "queued": bool(write_details.get("queued", False)),
            "backend": str(write_details.get("backend", "unknown")),
            "warnings": warnings_out,
        },
    )


@app.get("/memories", summary="Get all memories", response_model=MemoryResponse)
def get_all_memories(
    mem_cube_id: str | None = None,
    user_id: str | None = None,
):
    """Retrieve all memories from a MemCube."""
    mos_instance = get_mos_instance()

    # Auto-register cube if needed (when mem_cube_id is provided)
    if mem_cube_id is not None:
        target_user_id = user_id if user_id is not None else mos_instance.user_id
        _try_auto_register_cube(mos_instance, mem_cube_id, target_user_id)

    result = mos_instance.get_all(mem_cube_id=mem_cube_id, user_id=user_id)
    return MemoryResponse(message="Memories retrieved successfully", data=result)


@app.get(
    "/memories/{mem_cube_id}/{memory_id}", summary="Get a memory", response_model=MemoryResponse
)
def get_memory(mem_cube_id: str, memory_id: str, user_id: str | None = None):
    """Retrieve a specific memory by ID from a MemCube."""
    mos_instance = get_mos_instance()
    target_user_id = user_id if user_id is not None else mos_instance.user_id
    _try_auto_register_cube(mos_instance, mem_cube_id, target_user_id)
    result = mos_instance.get(mem_cube_id=mem_cube_id, memory_id=memory_id, user_id=user_id)
    # Convert Pydantic model to dict for JSON serialization
    if result is not None and hasattr(result, "model_dump"):
        result = result.model_dump()
    return MemoryResponse(message="Memory retrieved successfully", data=result)


@app.post("/search", summary="Search memories", response_model=SearchResponse)
def search_memories(search_req: SearchRequest):
    """Search for memories across MemCubes."""
    mos_instance = get_mos_instance()

    # Auto-register cubes if needed
    if search_req.install_cube_ids:
        target_user_id = search_req.user_id or mos_instance.user_id
        for cube_id in search_req.install_cube_ids:
            _try_auto_register_cube(mos_instance, cube_id, target_user_id)

    result = mos_instance.search(
        query=search_req.query,
        user_id=search_req.user_id,
        install_cube_ids=search_req.install_cube_ids,
        top_k=search_req.top_k,
    )
    return SearchResponse(message="Search completed successfully", data=result)


@app.put(
    "/memories/{mem_cube_id}/{memory_id}", summary="Update a memory", response_model=SimpleResponse
)
def update_memory(
    mem_cube_id: str, memory_id: str, updated_memory: dict[str, Any], user_id: str | None = None
):
    """Update an existing memory in a MemCube."""
    mos_instance = get_mos_instance()
    target_user_id = user_id if user_id is not None else mos_instance.user_id
    _try_auto_register_cube(mos_instance, mem_cube_id, target_user_id)
    # Same reasoning as add_memory: an update rewrites stored content, so it is
    # a write path too and must not be the hole redaction leaks through.
    updated_memory, labels = redact_obj(updated_memory)
    if labels:
        logger.warning(
            f"[update_memory] redacted credentials before storing: {', '.join(labels)}"
        )
    mos_instance.update(
        mem_cube_id=mem_cube_id,
        memory_id=memory_id,
        text_memory_item=updated_memory,
        user_id=user_id,
    )
    return SimpleResponse(message="Memory updated successfully")


@app.delete(
    "/memories/{mem_cube_id}/{memory_id}", summary="Delete a memory", response_model=SimpleResponse
)
def delete_memory(mem_cube_id: str, memory_id: str, user_id: str | None = None):
    """Delete a specific memory from a MemCube."""
    mos_instance = get_mos_instance()
    target_user_id = user_id if user_id is not None else mos_instance.user_id
    _try_auto_register_cube(mos_instance, mem_cube_id, target_user_id)
    mos_instance.delete(mem_cube_id=mem_cube_id, memory_id=memory_id, user_id=user_id)
    return SimpleResponse(message="Memory deleted successfully")


@app.delete("/memories/{mem_cube_id}", summary="Delete all memories", response_model=SimpleResponse)
def delete_all_memories(mem_cube_id: str, user_id: str | None = None):
    """Delete all memories from a MemCube."""
    mos_instance = get_mos_instance()
    target_user_id = user_id if user_id is not None else mos_instance.user_id
    _try_auto_register_cube(mos_instance, mem_cube_id, target_user_id)
    mos_instance.delete_all(mem_cube_id=mem_cube_id, user_id=user_id)
    return SimpleResponse(message="All memories deleted successfully")


@app.post("/graph/data", summary="Get graph data", response_model=GraphResponse)
async def get_graph_data(graph_req: APIGraphRequest):
    """Fetch graph nodes and edges for visualization."""
    mos_instance = get_mos_instance()

    # Find the specified cube or search for one that has tree_text memory
    graph_db = None

    if graph_req.mem_cube_id:
        try:
            cube = mos_instance.get_mem_cube(graph_req.mem_cube_id, user_id=graph_req.user_id)
            if hasattr(cube, "text_mem") and hasattr(cube.text_mem, "graph_store"):
                graph_db = cube.text_mem.graph_store
        except Exception as e:
            logger.warning(f"Could not get specified cube {graph_req.mem_cube_id}: {e}")

    if not graph_db:
        # Fallback: search across all active cubes in the instance
        for cube in mos_instance.mem_cubes.values():
            if hasattr(cube, "text_mem") and hasattr(cube.text_mem, "graph_store"):
                graph_db = cube.text_mem.graph_store
                break

    if not graph_db:
        # Try to get from a registered cube if none found in iteration
        try:
            for cube_id in mos_instance.list_mem_cubes(user_id=graph_req.user_id):
                cube = mos_instance.get_mem_cube(cube_id, user_id=graph_req.user_id)
                if hasattr(cube, "text_mem") and hasattr(cube.text_mem, "graph_store"):
                    graph_db = cube.text_mem.graph_store
                    break
        except Exception:
            pass

    if not graph_db:
        return GraphResponse(code=404, message="No graph database found in any memory cube", data=None)

    try:
        # Use the export_graph method from neo4j.py
        graph_data_raw = graph_db.export_graph(
            page=graph_req.page,
            page_size=graph_req.page_size,
            user_name=graph_req.user_id,
            filter=graph_req.filter,
        )

        graph_data = GraphData(
            nodes=graph_data_raw["nodes"],
            edges=graph_data_raw["edges"],
            total_nodes=graph_data_raw["total_nodes"],
            total_edges=graph_data_raw["total_edges"],
        )
        return GraphResponse(code=200, message="Graph data fetched successfully", data=graph_data)
    except Exception as e:
        logger.error(f"Error fetching graph data: {e}", exc_info=True)
        return GraphResponse(code=500, message=f"Internal server error: {e!s}", data=None)


def _get_graph_db(mos_instance, user_id: str | None = None, mem_cube_id: str | None = None):
    """Helper to get graph database from MOS instance."""
    graph_db = None

    if mem_cube_id:
        try:
            cube = mos_instance.get_mem_cube(mem_cube_id, user_id=user_id)
            if hasattr(cube, "text_mem") and hasattr(cube.text_mem, "graph_store"):
                graph_db = cube.text_mem.graph_store
        except Exception as e:
            logger.warning(f"Could not get specified cube {mem_cube_id}: {e}")

    if not graph_db:
        for cube in mos_instance.mem_cubes.values():
            if hasattr(cube, "text_mem") and hasattr(cube.text_mem, "graph_store"):
                graph_db = cube.text_mem.graph_store
                break

    if not graph_db:
        try:
            for cube_id in mos_instance.list_mem_cubes(user_id=user_id):
                cube = mos_instance.get_mem_cube(cube_id, user_id=user_id)
                if hasattr(cube, "text_mem") and hasattr(cube.text_mem, "graph_store"):
                    graph_db = cube.text_mem.graph_store
                    break
        except Exception:
            pass

    return graph_db


@app.post("/graph/trace_path", summary="Trace path between nodes", response_model=TracePathResponse)
async def trace_path(req: APITracePathRequest):
    """Trace reasoning paths between two memory nodes."""
    mos_instance = get_mos_instance()
    graph_db = _get_graph_db(mos_instance, req.user_id, req.mem_cube_id)

    if not graph_db:
        return TracePathResponse(code=404, message="No graph database found", data=None)

    try:
        # Use graph_db to find paths
        if hasattr(graph_db, 'find_path'):
            path_result = graph_db.find_path(
                source_id=req.source_id,
                target_id=req.target_id,
                max_depth=req.max_depth
            )
        else:
            # Fallback: direct Neo4j query (run in thread to avoid blocking event loop)
            path_result = await asyncio.to_thread(_neo4j_find_path, req.source_id, req.target_id, req.max_depth)

        if path_result and path_result.get("path_found"):
            paths = []
            for p in path_result.get("paths", []):
                nodes = [PathNode(id=n["id"], memory=n.get("memory", ""), metadata=n.get("metadata", {})) for n in p.get("nodes", [])]
                edges = [PathEdge(source=e["source"], target=e["target"], type=e.get("type", "RELATE")) for e in p.get("edges", [])]
                paths.append(TracePath(nodes=nodes, edges=edges, length=len(edges)))

            return TracePathResponse(
                code=200,
                message="Path found",
                data=TracePathData(
                    path_found=True,
                    paths=paths,
                    source_id=req.source_id,
                    target_id=req.target_id
                )
            )
        else:
            return TracePathResponse(
                code=200,
                message="No path found between nodes",
                data=TracePathData(
                    path_found=False,
                    paths=[],
                    source_id=req.source_id,
                    target_id=req.target_id
                )
            )

    except Exception as e:
        logger.error(f"Error tracing path: {e}", exc_info=True)
        return TracePathResponse(code=500, message=f"Internal server error: {e!s}", data=None)


@app.post("/graph/schema", summary="Export graph schema", response_model=SchemaResponse)
async def export_schema(req: APISchemaRequest):
    """Export knowledge graph schema and statistics."""
    mos_instance = get_mos_instance()
    graph_db = _get_graph_db(mos_instance, req.user_id, req.mem_cube_id)

    if not graph_db:
        return SchemaResponse(code=404, message="No graph database found", data=None)

    try:
        # Use graph_db to get schema stats
        if hasattr(graph_db, 'get_schema_stats'):
            stats = graph_db.get_schema_stats(sample_size=req.sample_size)
        else:
            # Fallback: direct Neo4j query (run in thread to avoid blocking event loop)
            # 传 mem_cube_id：统计必须按 cube 收敛。此前只传 sample_size，
            # cube 信息在调用边界丢失，导致返回全库合计（实测某 cube 6534 节点
            # 却报 7878 = 所有 cube 之和），跨 cube 串味且数字无法用于诊断。
            stats = await asyncio.to_thread(
                _neo4j_get_schema_stats, req.sample_size, req.mem_cube_id
            )

        return SchemaResponse(
            code=200,
            message="Schema exported successfully",
            data=SchemaData(
                total_nodes=stats.get("total_nodes", 0),
                total_edges=stats.get("total_edges", 0),
                edge_types=stats.get("edge_types", {}),
                memory_types=stats.get("memory_types", {}),
                top_tags=stats.get("top_tags", []),
                avg_connections=stats.get("avg_connections", 0.0),
                max_connections=stats.get("max_connections", 0),
                orphan_nodes=stats.get("orphan_nodes", 0),
                time_range=stats.get("time_range", {})
            )
        )

    except Exception as e:
        logger.error(f"Error exporting schema: {e}", exc_info=True)
        return SchemaResponse(code=500, message=f"Internal server error: {e!s}", data=None)


def _neo4j_find_path(source_id: str, target_id: str, max_depth: int) -> dict:
    """Fallback: Direct Neo4j query for path finding."""
    import httpx

    neo4j_url = os.environ.get("NEO4J_HTTP_URL", "http://localhost:7474/db/neo4j/tx/commit")
    neo4j_user = os.environ.get("NEO4J_USER", "neo4j")
    neo4j_password = os.environ.get("NEO4J_PASSWORD", "12345678")

    query = f"""
    MATCH path = shortestPath((a:Memory {{id: $source_id}})-[*1..{max_depth}]-(b:Memory {{id: $target_id}}))
    RETURN path
    LIMIT 1
    """

    try:
        response = httpx.post(
            neo4j_url,
            json={"statements": [{"statement": query, "parameters": {"source_id": source_id, "target_id": target_id}}]},
            auth=(neo4j_user, neo4j_password),
            timeout=30
        )

        if response.status_code == 200:
            data = response.json()
            results = data.get("results", [{}])[0].get("data", [])
            if results:
                return {"path_found": True, "paths": [{"nodes": [], "edges": []}]}
            return {"path_found": False, "paths": []}
    except Exception as e:
        logger.error(f"Neo4j path query error: {e}")

    return {"path_found": False, "paths": []}


def _neo4j_get_schema_stats(sample_size: int, mem_cube_id: str | None = None) -> dict:
    """委托给 graph_handler.neo4j_schema_stats —— 唯一实现。

    此前 start_api 与 graph_handler 各有一份逐行重复的实现，两份**各自**
    漏掉了度数统计（avg/max/orphan 恒为 0）与 cube 过滤（返回全库合计）。
    重复本身就是缺陷成因，所以收敛为一份，放在 handler 层。

    import 方向安全：start_api 本就 import graph_handler，反向无引用。
    """
    return neo4j_schema_stats(sample_size, mem_cube_id)


@app.post("/chat", summary="Chat with MemOS", response_model=ChatResponse)
async def chat(chat_req: ChatRequest):
    """Chat with the MemOS system."""
    mos_instance = get_mos_instance()
    response = mos_instance.chat(query=chat_req.query, user_id=chat_req.user_id)
    if response is None:
        raise ValueError("No response generated")
    return ChatResponse(message="Chat response generated", data=response)


@app.get("/", summary="Redirect to the OpenAPI documentation", include_in_schema=False)
async def home():
    """Redirect to the OpenAPI documentation."""
    return RedirectResponse(url="/docs", status_code=307)


@app.exception_handler(KeyError)
async def key_error_handler(request: Request, exc: KeyError):
    """Handle KeyError (cube not found) as 404."""
    return JSONResponse(
        status_code=404,
        content={"code": 404, "message": str(exc), "data": None},
    )


@app.exception_handler(ValueError)
async def value_error_handler(request: Request, exc: ValueError):
    """Handle ValueError exceptions globally."""
    return JSONResponse(
        status_code=400,
        content={"code": 400, "message": str(exc), "data": None},
    )


try:
    from neo4j.exceptions import ServiceUnavailable as _Neo4jServiceUnavailable

    @app.exception_handler(_Neo4jServiceUnavailable)
    async def neo4j_unavailable_handler(request: Request, exc: _Neo4jServiceUnavailable):
        """Return 503 (not a raw 500) when the Neo4j graph database is unreachable.

        The graph store hard-fails with ServiceUnavailable / WinError 10061 when Neo4j
        is down or still booting. Surface that as a clear, retryable 503 instead of
        leaking a stack trace to the client.
        """
        logger.error(f"Neo4j graph database unavailable: {exc}")
        return JSONResponse(
            status_code=503,
            content={
                "code": 503,
                "message": (
                    "Graph database (Neo4j) is unavailable. Make sure it is running and "
                    "reachable (e.g. scripts/local/start_db.bat), then retry."
                ),
                "data": None,
            },
        )
except ImportError:
    # neo4j is an optional backend (not installed in general_text / vector-only mode).
    logger.debug("neo4j not installed; skipping ServiceUnavailable exception handler")


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    """Handle all unhandled exceptions globally."""
    logger.exception("Unhandled error:")
    return JSONResponse(
        status_code=500,
        content={"code": 500, "message": str(exc), "data": None},
    )


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8000, help="Port to run the server on")
    parser.add_argument("--host", type=str, default="0.0.0.0", help="Host to run the server on")
    parser.add_argument("--reload", action="store_true", help="Enable auto-reload for development")
    args = parser.parse_args()

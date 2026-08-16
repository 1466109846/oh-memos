# LOCOMO Evaluation for oh-memos

Adapter and runner for benchmarking oh-memos against the [LOCOMO dataset](https://github.com/microsoft/LOCOMO) (Long Context Modeling for conversational memory).

## Architecture

This evaluation targets the **Docker Compose stack** (Neo4j + Qdrant + FastAPI), measuring real-world end-to-end latency including embedding generation, vector search, and graph traversal.

### Components

- **`harness_memos_docker.py`**: Adapter implementing LOCOMO's `add()` / `search()` / `compute_recall_at_10()` interface
  - Injects `[D<dia_id>:<turn_idx>]` markers into turn text before ingestion
  - Extracts markers from retrieved memories to compute recall@10
  - Uses separate user accounts per speaker (locomo_donnie, locomo_abigail)

- **`run_locomo_eval.py`**: Full evaluation runner
  - Loads LOCOMO .jsonl dataset
  - Ingests all dialogue turns with markers
  - Runs queries for turns with gold labels
  - Computes recall@10 and latency statistics
  - Outputs JSON results

## Prerequisites

1. **Docker stack running**:
   ```bash
   cd docker
   docker compose up -d
   ```

2. **Verify API health**:
   ```bash
   curl http://127.0.0.1:18000/health
   ```

3. **Create evaluation users and cube** (one-time setup):
   ```bash
   # Create users
   curl -X POST http://127.0.0.1:18000/users \
     -H 'Content-Type: application/json' \
     -d '{"user_id":"locomo_donnie","user_name":"locomo_donnie","role":"USER"}'

   curl -X POST http://127.0.0.1:18000/users \
     -H 'Content-Type: application/json' \
     -d '{"user_id":"locomo_abigail","user_name":"locomo_abigail","role":"USER"}'

   # Register eval cube for both users
   curl -X POST http://127.0.0.1:18000/mem_cubes \
     -H 'Content-Type: application/json' \
     -d '{"user_id":"locomo_donnie","mem_cube_name_or_path":"/data/cubes/locomo_eval_cube","mem_cube_id":"locomo_eval_cube"}'

   curl -X POST http://127.0.0.1:18000/mem_cubes \
     -H 'Content-Type: application/json' \
     -d '{"user_id":"locomo_abigail","mem_cube_name_or_path":"/data/cubes/locomo_eval_cube","mem_cube_id":"locomo_eval_cube"}'
   ```

## Usage

### Run evaluation on a dataset

```bash
cd evaluation/scripts/locomo
py -3 run_locomo_eval.py --dataset path/to/locomo_dataset.jsonl --output results.json
```

### Expected dataset format

Each line is a JSON object:
```json
{
  "dia_id": "d123",
  "turns": [
    {"speaker": "Donnie", "text": "I love Python", "timestamp": "2026-01-01T10:00:00Z"},
    {"speaker": "Abigail", "text": "Me too!", "timestamp": "2026-01-01T10:01:00Z"}
  ],
  "gold": {
    "1": [0]
  }
}
```

- `gold`: Maps query turn index → list of turn indices that should be retrieved (for recall@10)

### Output format

```json
{
  "dataset": "locomo_dev.jsonl",
  "dialogues_count": 50,
  "total_add_operations": 2500,
  "total_search_operations": 450,
  "add_latency_ms": {
    "mean": 6800.5,
    "median": 6950.2,
    "min": 5500.0,
    "max": 8100.0
  },
  "search_latency_ms": {
    "mean": 210.3,
    "median": 205.8,
    "min": 180.5,
    "max": 350.2
  },
  "recall_at_10": {
    "mean": 0.856,
    "median": 0.875,
    "scores": [0.85, 0.90, ...]
  }
}
```

## Testing

Quick smoke test with minimal dataset:
```bash
cd evaluation/scripts/locomo
py -3 run_locomo_eval.py --dataset test_dataset.jsonl --output test_results.json
```

Expected result: `recall@10` close to 1.0 (perfect retrieval on small test set).

## Implementation notes

### Marker injection and extraction

Markers `[D<dia_id>:<turn_idx>]` are injected into the user message before calling `/memories`:
```python
marked = f"[Dtest_d1:0] I love Python"
```

After ingestion, the oh-memos pipeline:
1. Rewrites the chat message into a descriptive memory
2. Preserves the original text in `metadata.sources`

During search, the adapter:
1. Retrieves top-k memories
2. Extracts markers using regex `r"\[D[\w]+:\d+\]"`
3. Checks both `memory` field and `metadata.sources`
4. Computes recall@10: `|gold ∩ retrieved| / |gold|`

### Multi-user design

LOCOMO dialogues have two speakers. The adapter maps:
- `Donnie` → `locomo_donnie` (user_id)
- `Abigail` → `locomo_abigail` (user_id)

Both share the same `locomo_eval_cube`, so memories from both speakers are searchable by either party.

### Latency measurement

- **add latency**: HTTP round-trip time for POST /memories (includes embedding + Neo4j write + Qdrant upsert)
- **search latency**: HTTP round-trip time for POST /search (includes embedding + Qdrant query + Neo4j graph traversal)

Real-world performance includes network overhead and database I/O, unlike in-memory benchmarks.

## Troubleshooting

### Recall@10 is 0

- Check that markers are injected: `curl http://127.0.0.1:18000/memories/list` and verify `[D...]` in memory text or sources
- Verify regex: `py -3 -c "import re; print(re.findall(r'\[D[\w]+:\d+\]', '[Dtest_d1:0] text'))"`

### API connection refused

- Ensure Docker stack is running: `docker ps | grep oh-memos-api`
- Check logs: `docker logs oh-memos-api`

### Slow add latency (>10s per turn)

- First add is slow due to model loading (embedding + LLM for rewrite)
- Subsequent adds should stabilize around 3-7s depending on hardware

### Search returns empty results

- Verify cube has memories: `curl -X POST http://127.0.0.1:18000/memories/list -d '{"user_id":"locomo_donnie","mem_cube_id":"locomo_eval_cube"}'`
- Check if embedding model is running: `docker logs oh-memos-api | grep -i embed`

"""LOCOMO evaluation runner for oh-memos Docker stack.

Usage:
    py -3 run_locomo_eval.py --dataset locomo_dev.jsonl --output results.json

Expects:
- Docker Compose stack running at http://127.0.0.1:18000
- locomo_eval_cube registered
- locomo_donnie and locomo_abigail users created
- Dataset in LOCOMO format: {dia_id, turns: [{speaker, text, timestamp}], gold: {turn_idx: [turn_idx]}}
"""
import argparse
import json
import sys
from pathlib import Path
from statistics import mean, median
from time import time

# import adapter — harness_memos_docker.py must be in same directory
from harness_memos_docker import (
    add,
    compute_recall_at_10,
    get_client,
    reset_dialogue,
    search,
)


def run_evaluation(dataset_path: Path, output_path: Path):
    """Run LOCOMO eval over the dataset and write metrics."""
    client = get_client()
    dialogues = []
    with dataset_path.open("r", encoding="utf-8") as f:
        for line in f:
            if line.strip():
                dialogues.append(json.loads(line))

    print(f"Loaded {len(dialogues)} dialogues from {dataset_path}")

    all_add_latencies = []
    all_search_latencies = []
    recall_scores = []

    for idx, dia in enumerate(dialogues, 1):
        dia_id = dia["dia_id"]
        turns = dia["turns"]
        gold = {int(k): set(v) for k, v in dia.get("gold", {}).items()}

        print(f"\n[{idx}/{len(dialogues)}] Processing {dia_id} ({len(turns)} turns)...")
        reset_dialogue(dia_id)

        # ingest all turns
        for turn_idx, turn in enumerate(turns):
            speaker = turn["speaker"]
            text = turn["text"]
            timestamp = turn.get("timestamp", "2026-01-01T00:00:00Z")

            lat_add = add(client, dia_id, turn_idx, speaker, text, timestamp)
            all_add_latencies.append(lat_add)

            if (turn_idx + 1) % 10 == 0:
                print(f"  ingested {turn_idx + 1}/{len(turns)} turns...")

        # run queries for turns that have gold
        search_count = 0
        for turn_idx in sorted(gold.keys()):
            if turn_idx >= len(turns):
                continue
            query_text = turns[turn_idx]["text"]
            speaker = turns[turn_idx]["speaker"]

            _, lat_search = search(client, dia_id, turn_idx, query_text, speaker, top_k=10)
            all_search_latencies.append(lat_search)
            search_count += 1

        # compute recall@10 for this dialogue
        if gold:
            recall = compute_recall_at_10(dia_id, gold)
            recall_scores.append(recall)
            print(f"  {dia_id}: {search_count} queries, recall@10={recall:.3f}")

    # aggregate metrics
    results = {
        "dataset": str(dataset_path),
        "dialogues_count": len(dialogues),
        "total_add_operations": len(all_add_latencies),
        "total_search_operations": len(all_search_latencies),
        "add_latency_ms": {
            "mean": mean(all_add_latencies) if all_add_latencies else 0,
            "median": median(all_add_latencies) if all_add_latencies else 0,
            "min": min(all_add_latencies) if all_add_latencies else 0,
            "max": max(all_add_latencies) if all_add_latencies else 0,
        },
        "search_latency_ms": {
            "mean": mean(all_search_latencies) if all_search_latencies else 0,
            "median": median(all_search_latencies) if all_search_latencies else 0,
            "min": min(all_search_latencies) if all_search_latencies else 0,
            "max": max(all_search_latencies) if all_search_latencies else 0,
        },
        "recall_at_10": {
            "mean": mean(recall_scores) if recall_scores else 0,
            "median": median(recall_scores) if recall_scores else 0,
            "scores": recall_scores,
        },
    }

    output_path.write_text(json.dumps(results, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\n=== Evaluation Complete ===")
    print(f"Recall@10: {results['recall_at_10']['mean']:.3f} (mean), {results['recall_at_10']['median']:.3f} (median)")
    print(f"Add latency: {results['add_latency_ms']['mean']:.1f}ms (mean), {results['add_latency_ms']['median']:.1f}ms (median)")
    print(f"Search latency: {results['search_latency_ms']['mean']:.1f}ms (mean), {results['search_latency_ms']['median']:.1f}ms (median)")
    print(f"Results written to {output_path}")


def main():
    parser = argparse.ArgumentParser(description="LOCOMO evaluation for oh-memos Docker")
    parser.add_argument("--dataset", required=True, help="Path to LOCOMO .jsonl dataset")
    parser.add_argument("--output", required=True, help="Output JSON file for results")
    args = parser.parse_args()

    dataset_path = Path(args.dataset)
    output_path = Path(args.output)

    if not dataset_path.exists():
        print(f"Error: dataset not found at {dataset_path}", file=sys.stderr)
        sys.exit(1)

    run_evaluation(dataset_path, output_path)


if __name__ == "__main__":
    main()

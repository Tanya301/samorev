#!/usr/bin/env python3
"""Calculate quality metrics and check for regressions.

Compares current agent results against baseline metrics.
Used in CI quality gates to prevent model downgrades from causing regressions.
"""
from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Any, Optional


@dataclass
class AgentMetrics:
    """Metrics for a single agent."""
    agent: str
    model: str
    fixtures_run: int
    total_must_find: int
    total_found: int
    total_missed: int
    total_false_positives: int
    recall: float  # found / must_find
    fp_rate: float  # false_positives / total_findings

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


# Quality thresholds per agent (from the plan)
THRESHOLDS = {
    'security': {'min_recall': 0.98, 'max_fp_rate': 0.05},
    'bugs': {'min_recall': 0.95, 'max_fp_rate': 0.10},
    'tests': {'min_recall': 0.85, 'max_fp_rate': 0.15},
    'guidelines': {'min_recall': 0.80, 'max_fp_rate': 0.20},
    'docs': {'min_recall': 0.80, 'max_fp_rate': 0.20},
}


def calculate_agent_metrics(results: list[dict], agent: str, model: str) -> AgentMetrics:
    """Calculate aggregate metrics for an agent across all fixtures."""
    total_must_find = 0
    total_found = 0
    total_missed = 0
    total_false_positives = 0
    total_findings = 0

    for result in results:
        total_must_find += result.get('total_must_find', 0)
        total_found += result.get('found_count', 0)
        total_missed += result.get('missed_count', 0)
        total_false_positives += result.get('false_positive_count', 0)
        total_findings += result.get('total_findings', 0)

    recall = total_found / total_must_find if total_must_find > 0 else 1.0
    fp_rate = total_false_positives / total_findings if total_findings > 0 else 0.0

    return AgentMetrics(
        agent=agent,
        model=model,
        fixtures_run=len(results),
        total_must_find=total_must_find,
        total_found=total_found,
        total_missed=total_missed,
        total_false_positives=total_false_positives,
        recall=recall,
        fp_rate=fp_rate,
    )


def check_thresholds(metrics: AgentMetrics) -> tuple[bool, list[str]]:
    """Check if metrics meet minimum thresholds."""
    agent_type = metrics.agent.lower()
    thresholds = THRESHOLDS.get(agent_type)

    if not thresholds:
        return True, []

    failures = []

    if metrics.recall < thresholds['min_recall']:
        failures.append(
            f"Recall {metrics.recall:.1%} < minimum {thresholds['min_recall']:.1%}"
        )

    if metrics.fp_rate > thresholds['max_fp_rate']:
        failures.append(
            f"FP rate {metrics.fp_rate:.1%} > maximum {thresholds['max_fp_rate']:.1%}"
        )

    return len(failures) == 0, failures


def compare_to_baseline(
    current: AgentMetrics,
    baseline: AgentMetrics,
    regression_threshold: float = 0.95,
) -> tuple[bool, list[str]]:
    """Check if current metrics have regressed from baseline.

    Args:
        current: Current metrics
        baseline: Baseline metrics to compare against
        regression_threshold: Minimum ratio of current/baseline (0.95 = allow 5% regression)
    """
    issues = []

    # Check recall regression
    if baseline.recall > 0:
        recall_ratio = current.recall / baseline.recall
        if recall_ratio < regression_threshold:
            issues.append(
                f"Recall regressed: {current.recall:.1%} vs baseline {baseline.recall:.1%} "
                f"({recall_ratio:.1%} of baseline)"
            )

    # Check FP rate regression (higher is worse)
    if baseline.fp_rate > 0:
        # For FP rate, we want current <= baseline * (1/regression_threshold)
        max_fp_rate = baseline.fp_rate / regression_threshold
        if current.fp_rate > max_fp_rate:
            issues.append(
                f"FP rate regressed: {current.fp_rate:.1%} vs baseline {baseline.fp_rate:.1%}"
            )
    elif current.fp_rate > 0:
        # Baseline had no false positives but current does - this is a regression
        issues.append(
            f"FP rate regressed: {current.fp_rate:.1%} vs baseline 0%"
        )

    return len(issues) == 0, issues


def load_baseline(baseline_dir: Path, agent: str) -> Optional[AgentMetrics]:
    """Load baseline metrics for an agent."""
    baseline_file = baseline_dir / f"{agent}_metrics.json"
    if baseline_file.exists():
        data = json.loads(baseline_file.read_text())
        return AgentMetrics(**data)
    return None


def save_metrics(metrics: AgentMetrics, output_dir: Path) -> None:
    """Save metrics to file."""
    output_dir.mkdir(parents=True, exist_ok=True)
    output_file = output_dir / f"{metrics.agent}_metrics.json"
    output_file.write_text(json.dumps(metrics.to_dict(), indent=2))


def print_metrics_table(all_metrics: list[AgentMetrics]) -> None:
    """Print metrics as a formatted table."""
    print("\n" + "=" * 80)
    print("AGENT QUALITY METRICS")
    print("=" * 80)
    print(f"{'Agent':<15} {'Model':<8} {'Recall':>10} {'FP Rate':>10} {'Found':>8} {'Missed':>8}")
    print("-" * 80)

    for m in all_metrics:
        print(f"{m.agent:<15} {m.model:<8} {m.recall:>9.1%} {m.fp_rate:>9.1%} "
              f"{m.total_found:>8} {m.total_missed:>8}")

    print("=" * 80 + "\n")


def main():
    parser = argparse.ArgumentParser(description='Calculate quality metrics')
    parser.add_argument('--results-dir', type=Path, required=True,
                        help='Directory containing test result JSON files')
    parser.add_argument('--baseline', type=Path,
                        help='Directory containing baseline metrics')
    parser.add_argument('--output', type=Path,
                        help='Directory to save current metrics')
    parser.add_argument('--fail-on-regression', action='store_true',
                        help='Exit with error if regression detected')
    parser.add_argument('--fail-on-threshold', action='store_true',
                        help='Exit with error if thresholds not met')
    args = parser.parse_args()

    # Load all result files
    results_by_agent: dict[str, list[dict]] = {}
    models_by_agent: dict[str, str] = {}

    for result_file in args.results_dir.glob('*.json'):
        data = json.loads(result_file.read_text())
        agent = data.get('agent', 'unknown')
        model = data.get('model', 'opus')

        if agent not in results_by_agent:
            results_by_agent[agent] = []
            models_by_agent[agent] = model
        results_by_agent[agent].append(data)

    # Calculate metrics for each agent
    all_metrics = []
    all_failures = []

    for agent, results in results_by_agent.items():
        model = models_by_agent[agent]
        metrics = calculate_agent_metrics(results, agent, model)
        all_metrics.append(metrics)

        # Check thresholds
        if args.fail_on_threshold:
            passed, failures = check_thresholds(metrics)
            if not passed:
                for f in failures:
                    all_failures.append(f"[{agent}] {f}")

        # Compare to baseline
        if args.baseline and args.fail_on_regression:
            baseline = load_baseline(args.baseline, agent)
            if baseline:
                passed, issues = compare_to_baseline(metrics, baseline)
                if not passed:
                    for issue in issues:
                        all_failures.append(f"[{agent}] REGRESSION: {issue}")

        # Save metrics
        if args.output:
            save_metrics(metrics, args.output)

    # Print summary
    print_metrics_table(all_metrics)

    if all_failures:
        print("FAILURES:")
        for f in all_failures:
            print(f"  - {f}")
        sys.exit(1)

    print("All quality checks passed!")
    sys.exit(0)


if __name__ == '__main__':
    main()

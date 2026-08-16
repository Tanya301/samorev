from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path


ROOT = Path(__file__).parent.parent
SCRIPT = ROOT / "scripts" / "summarize-github-ci.sh"
PARITY_CASES = json.loads((ROOT / "tests" / "fixtures" / "github-ci-parity.json").read_text())
SELF_CHECK_VARS = {
    "SAMOREV_IGNORED_GITHUB_CHECK_RUN_IDS",
    "SAMOREV_IGNORED_GITHUB_CHECK_NAME",
    "SAMOREV_IGNORED_GITHUB_CHECK_APP_ID",
}


def clean_env(**overrides: str) -> dict[str, str]:
    base = {key: value for key, value in os.environ.items() if key not in SELF_CHECK_VARS}
    return {**base, **overrides}


def summarize(payload: object, **env: str) -> tuple[dict, str]:
    result = subprocess.run(
        ["bash", str(SCRIPT)],
        input=json.dumps(payload),
        env=clean_env(**env),
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(result.stdout), result.stderr


def test_slurped_pages_and_non_blocking_conclusions():
    summary, _ = summarize([
        {"check_runs": [{"id": 1, "status": "completed", "conclusion": "success"}]},
        {"check_runs": [{"id": 2, "status": "completed", "conclusion": "skipped"}]},
    ])
    assert summary["status"] == "success"
    assert summary["filtered_count"] == 2


def test_matches_shared_shell_typescript_fixture_table():
    for fixture in PARITY_CASES:
        self_check = fixture.get("self_check")
        env = {}
        if self_check:
            env = {
                "SAMOREV_IGNORED_GITHUB_CHECK_RUN_IDS": ",".join(self_check.get("run_ids", [])),
                "SAMOREV_IGNORED_GITHUB_CHECK_NAME": self_check.get("name", ""),
                "SAMOREV_IGNORED_GITHUB_CHECK_APP_ID": self_check.get("app_id", ""),
            }
        summary, _ = summarize(fixture["payload"], **env)
        assert summary["status"] == fixture["status"], fixture["name"]
        assert summary["excluded_self"] == fixture["excluded_self"], fixture["name"]


def test_publisher_exclusion_preserves_independent_success_counts():
    fixture = next(case for case in PARITY_CASES if case["name"] == "publisher_and_independent_success_pass")
    self_check = fixture["self_check"]
    summary, _ = summarize(
        fixture["payload"],
        SAMOREV_IGNORED_GITHUB_CHECK_RUN_IDS=",".join(self_check["run_ids"]),
        SAMOREV_IGNORED_GITHUB_CHECK_NAME=self_check["name"],
        SAMOREV_IGNORED_GITHUB_CHECK_APP_ID=self_check["app_id"],
    )
    assert summary["original_count"] == 2
    assert summary["filtered_count"] == 1
    assert summary["excluded_self"] == 1
    assert summary["status"] == "success"


def test_malformed_payloads_fail_closed():
    assert summarize({"message": "Not Found"})[0]["status"] == "unknown"
    assert summarize({"check_runs": "oops"})[0]["status"] == "unknown"
    assert summarize([{"check_runs": []}, {"message": "partial"}])[0]["status"] == "unknown"
    result = subprocess.run(
        ["bash", str(SCRIPT)], input="not-json", env=clean_env(), capture_output=True, text=True, check=True
    )
    assert json.loads(result.stdout)["status"] == "fetch-error"
    empty = subprocess.run(
        ["bash", str(SCRIPT)], input="", env=clean_env(), capture_output=True, text=True, check=True
    )
    assert json.loads(empty.stdout)["status"] == "fetch-error"
    multi_document = subprocess.run(
        ["bash", str(SCRIPT)],
        input='{"check_runs":[{"conclusion":"success"}]}\n{"check_runs":[{"conclusion":"failure"}]}\n',
        env=clean_env(), capture_output=True, text=True, check=True,
    )
    assert json.loads(multi_document.stdout)["status"] == "failure"


def test_pipeline_link_prefers_failed_actions_run_and_extracts_numeric_id():
    summary, _ = summarize({"check_runs": [
        {"conclusion": "success", "html_url": "https://github.com/o/r/actions/runs/10/job/1"},
        {"conclusion": "failure", "html_url": "https://github.com/o/r/actions/runs/20/job/2"},
    ]})
    assert summary["pipeline_id"] == "20"
    assert summary["pipeline_url"].endswith("/actions/runs/20/job/2")

    non_actions, _ = summarize({"check_runs": [{"conclusion": "failure", "html_url": "https://ci.example/run/7"}]})
    assert non_actions["pipeline_id"] == ""

    hostile, _ = summarize({"check_runs": [{"conclusion": "failure", "html_url": "https://evil/actions/runs/1;rm-rf/"}]})
    assert hostile["pipeline_id"] == "1"
    assert hostile["pipeline_id"].isdigit()


def test_empty_and_trusted_publisher_only_are_blocking_states():
    assert summarize({"check_runs": []})[0]["status"] == "none"
    publisher = {
        "id": 303,
        "name": "base-controlled samorev publisher",
        "app": {"id": 15368},
        "status": "in_progress",
        "conclusion": None,
    }
    summary, _ = summarize(
        {"check_runs": [publisher]},
        SAMOREV_IGNORED_GITHUB_CHECK_RUN_IDS="303",
        SAMOREV_IGNORED_GITHUB_CHECK_NAME=publisher["name"],
        SAMOREV_IGNORED_GITHUB_CHECK_APP_ID="15368",
    )
    assert summary["status"] == "self-only"
    assert summary["excluded_self"] == 1


def test_untrusted_same_name_check_remains_pending():
    publisher = {
        "id": 999,
        "name": "base-controlled samorev publisher",
        "app": {"id": 15368},
        "status": "in_progress",
        "conclusion": None,
    }
    summary, _ = summarize(
        {"check_runs": [publisher]},
        SAMOREV_IGNORED_GITHUB_CHECK_RUN_IDS="303",
        SAMOREV_IGNORED_GITHUB_CHECK_NAME=publisher["name"],
        SAMOREV_IGNORED_GITHUB_CHECK_APP_ID="15368",
    )
    assert summary["status"] == "pending"
    assert summary["excluded_self"] == 0


def test_partial_configuration_warns_and_excludes_nothing():
    summary, stderr = summarize(
        {"check_runs": [{"id": 303, "status": "in_progress", "conclusion": None}]},
        SAMOREV_IGNORED_GITHUB_CHECK_RUN_IDS="303",
    )
    assert summary["status"] == "unknown"
    assert "incomplete or invalid GitHub self-check" in stderr


def test_configuration_normalization_matches_cli_contract():
    publisher = {
        "id": 303,
        "name": "base-controlled samorev publisher",
        "app": {"id": 15368},
        "status": "in_progress",
        "conclusion": None,
    }
    summary, stderr = summarize(
        {"check_runs": [publisher]},
        SAMOREV_IGNORED_GITHUB_CHECK_RUN_IDS="abc, 303 ",
        SAMOREV_IGNORED_GITHUB_CHECK_NAME=f" {publisher['name']} ",
        SAMOREV_IGNORED_GITHUB_CHECK_APP_ID="15368 ",
    )
    assert summary["status"] == "self-only"
    assert "Ignoring non-numeric" in stderr

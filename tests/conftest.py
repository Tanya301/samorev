"""Pytest configuration and fixtures for REV agent testing."""
from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import pytest


# Test directory paths
TESTS_DIR = Path(__file__).parent
FIXTURES_DIR = TESTS_DIR / "fixtures"
GOLDEN_DIR = TESTS_DIR / "golden"
LIB_DIR = TESTS_DIR / "lib"


@dataclass
class FixtureData:
    """Data for a single test fixture."""
    path: Path
    agent: str
    name: str
    diff: str
    expected: dict
    metadata: dict


def pytest_addoption(parser):
    """Add custom command line options."""
    parser.addoption(
        "--model",
        action="store",
        default="opus",
        help="Model to use for agent tests (opus, sonnet, haiku)",
    )
    parser.addoption(
        "--max-fixtures",
        action="store",
        type=int,
        default=None,
        help="Maximum number of fixtures to run per agent (for faster CI)",
    )
    parser.addoption(
        "--save-golden",
        action="store_true",
        default=False,
        help="Save agent outputs to golden directory",
    )


def pytest_configure(config):
    """Register custom markers."""
    config.addinivalue_line(
        "markers", "api: marks tests that make real API calls (deselect with '-m \"not api\"')"
    )
    config.addinivalue_line(
        "markers", "slow: marks tests as slow (deselect with '-m \"not slow\"')"
    )


@pytest.fixture(scope="session")
def model(request) -> str:
    """Get the model to use for testing."""
    return request.config.getoption("--model")


@pytest.fixture(scope="session")
def max_fixtures(request) -> Optional[int]:
    """Get max fixtures limit."""
    return request.config.getoption("--max-fixtures")


@pytest.fixture(scope="session")
def save_golden(request) -> bool:
    """Whether to save golden outputs."""
    return request.config.getoption("--save-golden")


def discover_fixtures(agent: str, max_count: Optional[int] = None) -> list[FixtureData]:
    """Discover all fixtures for an agent."""
    agent_dir = FIXTURES_DIR / agent
    if not agent_dir.exists():
        return []

    fixtures = []
    for fixture_path in sorted(agent_dir.iterdir()):
        if not fixture_path.is_dir():
            continue

        diff_file = fixture_path / "diff.patch"
        if not diff_file.exists():
            continue

        expected_file = fixture_path / "expected.json"
        expected = {}
        if expected_file.exists():
            expected = json.loads(expected_file.read_text())

        metadata_file = fixture_path / "metadata.json"
        metadata = {}
        if metadata_file.exists():
            metadata = json.loads(metadata_file.read_text())

        fixtures.append(FixtureData(
            path=fixture_path,
            agent=agent,
            name=fixture_path.name,
            diff=diff_file.read_text(),
            expected=expected,
            metadata=metadata,
        ))

        if max_count and len(fixtures) >= max_count:
            break

    return fixtures


@pytest.fixture(scope="session")
def security_fixtures(max_fixtures) -> list[FixtureData]:
    """All security agent fixtures."""
    return discover_fixtures("security", max_fixtures)


@pytest.fixture(scope="session")
def bugs_fixtures(max_fixtures) -> list[FixtureData]:
    """All bugs agent fixtures."""
    return discover_fixtures("bugs", max_fixtures)


@pytest.fixture(scope="session")
def tests_fixtures(max_fixtures) -> list[FixtureData]:
    """All test analyzer fixtures."""
    return discover_fixtures("tests", max_fixtures)


@pytest.fixture(scope="session")
def guidelines_fixtures(max_fixtures) -> list[FixtureData]:
    """All guidelines checker fixtures."""
    return discover_fixtures("guidelines", max_fixtures)


@pytest.fixture(scope="session")
def docs_fixtures(max_fixtures) -> list[FixtureData]:
    """All docs reviewer fixtures."""
    return discover_fixtures("docs", max_fixtures)


class AgentTimeoutError(RuntimeError):
    """Raised when an agent times out."""
    pass


def run_agent(agent: str, fixture: FixtureData, model: str) -> str:
    """Run an agent on a fixture and return the output."""
    runner_script = LIB_DIR / "runner.sh"

    result = subprocess.run(
        [str(runner_script), agent, str(fixture.path), "--model", model],
        capture_output=True,
        text=True,
        timeout=180,  # 3 minute timeout
    )

    if result.returncode != 0:
        # Include both stdout and stderr for better error diagnosis
        error_msg = result.stderr
        if result.stdout:
            error_msg += f"\nOutput: {result.stdout[:500]}"
        raise RuntimeError(f"Agent failed: {error_msg}")

    # Check for timeout - runner.sh exits 0 but outputs "TIMEOUT" on timeout
    # Check raw output first (before strip) to handle partial output before timeout
    raw_output = result.stdout
    if raw_output.strip() == "TIMEOUT" or raw_output.rstrip().endswith("\nTIMEOUT"):
        raise AgentTimeoutError(
            f"Agent {agent} timed out on fixture {fixture.name}"
        )

    return raw_output


@pytest.fixture
def agent_runner(model):
    """Fixture that returns a function to run agents."""
    def _run(agent: str, fixture: FixtureData) -> str:
        return run_agent(agent, fixture, model)
    return _run


# Parametrize fixtures for each agent type
def pytest_generate_tests(metafunc):
    """Generate test parameters from discovered fixtures."""
    # Map fixture names to agent types
    fixture_params = {
        "security_fixture": "security",
        "bugs_fixture": "bugs",
        "tests_fixture": "tests",
        "guidelines_fixture": "guidelines",
        "docs_fixture": "docs",
    }

    for fixture_name, agent in fixture_params.items():
        if fixture_name in metafunc.fixturenames:
            max_count = metafunc.config.getoption("--max-fixtures")
            fixtures = discover_fixtures(agent, max_count)
            metafunc.parametrize(
                fixture_name,
                fixtures,
                ids=[f.name for f in fixtures],
            )

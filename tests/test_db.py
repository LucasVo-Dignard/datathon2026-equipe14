"""Database tests.

The connection tests always run. The repository and job tests need the
local Docker Postgres with migrations applied (see db/README.md) and run only
when TEST_DATABASE_URL is set, e.g.:

    TEST_DATABASE_URL=postgresql://bncd_admin:localdev@127.0.0.1:5432/marketdata pytest
"""

import os
from datetime import UTC, date, datetime

import pytest

from marketdata.db import connect
from marketdata.db import repositories as repo
from marketdata.errors import ConfigurationError
from marketdata.jobs import daily_refresh
from marketdata.jobs.daily_refresh import refresh, refresh_enabled
from marketdata.models import (
    AnalystRatingAction,
    FinancialMetrics,
    PriceBar,
    PriceTargetConsensus,
)

# --- connect() ------------------------------------------------------------------


def test_connect_prefers_database_url():
    calls = []
    connect({"DATABASE_URL": "postgresql://x"}, connect_fn=lambda *a, **k: calls.append((a, k)))
    assert calls == [(("postgresql://x",), {})]


def test_connect_reads_credentials_from_secret_and_requires_tls():
    calls, secrets = [], []
    env = {"DB_HOST": "db.internal", "DB_NAME": "marketdata", "DB_SECRET_ARN": "arn:secret"}

    def read_secret(arn):
        secrets.append(arn)
        return {"username": "u", "password": "p"}

    connect(env, read_secret=read_secret, connect_fn=lambda **k: calls.append(k))
    assert secrets == ["arn:secret"]
    assert calls[0]["host"] == "db.internal"
    assert calls[0]["port"] == 5432
    assert calls[0]["user"] == "u" and calls[0]["password"] == "p"
    assert calls[0]["sslmode"] == "require"


def test_connect_without_config_raises():
    with pytest.raises(ConfigurationError, match="DB_HOST"):
        connect({}, connect_fn=lambda **k: None)


# --- REFRESH_ENABLED ------------------------------------------------------------


def test_refresh_enabled_defaults_on_and_accepts_false_values():
    assert refresh_enabled({})
    assert refresh_enabled({"REFRESH_ENABLED": "true"})
    for off in ("false", "False", "0", "no", "off"):
        assert not refresh_enabled({"REFRESH_ENABLED": off})


def test_disabled_job_does_nothing(monkeypatch):
    monkeypatch.setenv("REFRESH_ENABLED", "false")

    def fail(*args, **kwargs):
        raise AssertionError("must not connect when disabled")

    monkeypatch.setattr(daily_refresh, "connect", fail)
    assert daily_refresh.main([]) == 0


# --- Against a real Postgres ----------------------------------------------------

DB_URL = os.environ.get("TEST_DATABASE_URL")
needs_db = pytest.mark.skipif(not DB_URL, reason="TEST_DATABASE_URL not set")
SYMBOL = "ZZTEST.TO"
TABLES = ["price_bars", "financial_metrics", "price_target_consensus",
          "analyst_rating_actions", "tracked_symbols"]


@pytest.fixture
def conn():
    with connect({"DATABASE_URL": DB_URL}) as connection:
        connection.autocommit = True

        def cleanup():
            for table in TABLES:
                connection.execute(f"DELETE FROM {table} WHERE symbol = %s", (SYMBOL,))

        cleanup()
        yield connection
        cleanup()


def _count(conn, table):
    return conn.execute(f"SELECT count(*) FROM {table} WHERE symbol = %s", (SYMBOL,)).fetchone()[0]


@needs_db
def test_upserts_are_idempotent_and_snapshots_accumulate(conn):
    bar = PriceBar(symbol=SYMBOL, date=date(2026, 11, 13), open=1, high=2, low=0.5,
                   close=1.5, adj_close=1.5, volume=10, provider="yahoo")
    action = AnalystRatingAction(symbol=SYMBOL, firm="RBC Capital", provider="yahoo",
                                 graded_at=datetime(2026, 11, 12, 16, 0, tzinfo=UTC),
                                 action="up", price_target=230.0)
    target = PriceTargetConsensus(symbol=SYMBOL, provider="yahoo", target_mean=220.0)
    metrics = FinancialMetrics(symbol=SYMBOL, provider="yahoo", pe_ttm=12.0,
                               raw={"pe": float("nan"), "officers": [{"since": date(2020, 1, 1)}]})
    for _ in range(2):
        repo.save_price_bars(conn, [bar])
        repo.save_rating_actions(conn, [action])
        repo.save_price_target(conn, target)
        repo.save_metrics(conn, metrics)
    assert _count(conn, "price_bars") == 1
    assert _count(conn, "analyst_rating_actions") == 1
    assert _count(conn, "price_target_consensus") == 2  # snapshots
    assert _count(conn, "financial_metrics") == 2


@needs_db
def test_refresh_isolates_failures_and_records_them(conn):
    conn.execute("INSERT INTO tracked_symbols (symbol) VALUES (%s)", (SYMBOL,))
    target = PriceTargetConsensus(symbol=SYMBOL, provider="yahoo", target_mean=1.0)

    def ok(c, s):
        repo.save_price_target(c, target)

    def boom(c, s):
        repo.save_price_target(c, target)  # rolled back with its step
        raise RuntimeError("yahoo down")

    report = refresh(conn, [SYMBOL], [("ok", ok), ("boom", boom)])
    assert (report.succeeded, report.failed) == (1, 1)
    assert not report.nothing_succeeded
    assert _count(conn, "price_target_consensus") == 1
    refreshed_at, error = conn.execute(
        "SELECT last_refreshed_at, last_error FROM tracked_symbols WHERE symbol = %s", (SYMBOL,)
    ).fetchone()
    assert refreshed_at is None  # moves only on full success
    assert error == "boom: yahoo down"

    report = refresh(conn, [SYMBOL], [("ok", ok)])
    refreshed_at, error = conn.execute(
        "SELECT last_refreshed_at, last_error FROM tracked_symbols WHERE symbol = %s", (SYMBOL,)
    ).fetchone()
    assert refreshed_at is not None and error is None


@needs_db
def test_refresh_reports_total_failure(conn):
    def boom(c, s):
        raise RuntimeError("network down")

    assert refresh(conn, [SYMBOL], [("boom", boom)]).nothing_succeeded

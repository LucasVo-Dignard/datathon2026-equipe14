"""Price-move alerts (src/marketdata/jobs/price_alerts.py).

The message tests always run. The database tests need TEST_DATABASE_URL on a
throwaway database with db/migrations V1..V5 applied (they delete rows).
"""

import os
from datetime import UTC, date, datetime, timedelta

import pytest

from marketdata.jobs import daily_refresh, price_alerts
from marketdata.jobs.price_alerts import PriceMove, UserAlert, compose

TODAY = date(2026, 11, 13)  # a Friday


def move(symbol, close, prev, day=TODAY):
    return PriceMove(symbol, day, close, day - timedelta(days=1), prev)


# --- Message ------------------------------------------------------------------


def test_single_move_subject_and_body():
    subject, body = compose(UserAlert("ana", 4.0, [move("RY.TO", 162.35, 171.25)]), "http://app")
    assert subject == "Alerte de prix : RY.TO -5,2 %"
    assert subject.isascii() and len(subject) < 100
    assert "−5,2 %" in body
    assert "171,25 → 162,35" in body
    assert "4 % ou plus" in body
    assert "niveau de risque" in body
    assert "Yahoo Finance" in body  # source
    assert "pas un conseil financier" in body
    assert "http://app" in body


def test_several_moves_in_one_email():
    subject, body = compose(UserAlert("ana", 2.0, [move("SHOP.TO", 160, 150), move("TD.TO", 77, 79.15)]))
    assert subject == "Alerte de prix : 2 titres ont fortement varie"
    assert "▲ SHOP.TO" in body and "+6,7 %" in body
    assert "▼ TD.TO" in body
    assert "Voir votre portefeuille" not in body  # no app URL given


def test_ascii_subject_strips_accents_and_typography():
    assert price_alerts.ascii_subject("Élevé −3 % aujourd’hui") == "Eleve -3 % aujourd'hui"
    assert len(price_alerts.ascii_subject("x" * 200)) == 99


def test_alerts_are_skipped_without_a_topic(caplog):
    caplog.set_level("INFO")
    daily_refresh.send_price_alerts(conn=None, env={})
    assert "no price alerts" in caplog.text


# --- Database -----------------------------------------------------------------

needs_db = pytest.mark.skipif(not os.environ.get("TEST_DATABASE_URL"), reason="TEST_DATABASE_URL not set")


class FakeSns:
    def __init__(self, fail_for=()):
        self.published, self.fail_for = [], set(fail_for)

    def publish(self, **kwargs):
        user = kwargs["MessageAttributes"]["username"]["StringValue"]
        if user in self.fail_for:
            raise RuntimeError("SNS down")
        self.published.append(kwargs)
        return {"MessageId": str(len(self.published))}


@pytest.fixture
def conn():
    import psycopg

    with psycopg.connect(os.environ["TEST_DATABASE_URL"], autocommit=True) as c:
        c.execute("DELETE FROM notification_subscriptions WHERE username LIKE 'pa-%'")
        c.execute("DELETE FROM price_bars WHERE symbol LIKE 'PA%'")
        yield c
        c.execute("DELETE FROM notification_subscriptions WHERE username LIKE 'pa-%'")
        c.execute("DELETE FROM price_bars WHERE symbol LIKE 'PA%'")


def bar(c, symbol, day, close):
    c.execute(
        """INSERT INTO price_bars (symbol, provider, date, open, high, low, close, adj_close, volume, fetched_at)
           VALUES (%s, 'yahoo', %s, %s, %s, %s, %s, %s, 1000, %s)""",
        (symbol, day, close, close, close, close, close, datetime.now(UTC)),
    )


def subscribe(c, username, threshold, symbols):
    c.execute(
        """INSERT INTO notification_subscriptions (username, email, subscription_arn, threshold_pct, symbols)
           VALUES (%s, %s, 'arn:x', %s, %s)""",
        (username, f"{username}@example.com", threshold, symbols),
    )


@needs_db
def test_threshold_freshness_dedup_and_failures(conn):
    thu, fri = TODAY - timedelta(days=1), TODAY
    bar(conn, "PABIG", thu, 100); bar(conn, "PABIG", fri, 95)       # -5 %
    bar(conn, "PASMALL", thu, 100); bar(conn, "PASMALL", fri, 97)   # -3 %
    old = TODAY - timedelta(days=10)
    bar(conn, "PAOLD", old - timedelta(days=1), 100); bar(conn, "PAOLD", old, 80)  # -20 %, stale

    subscribe(conn, "pa-cautious", 2, ["PABIG", "PASMALL", "PAOLD"])  # Faible: 2 %
    subscribe(conn, "pa-bold", 7, ["PABIG"])                           # Élevé: 7 %
    subscribe(conn, "pa-down", 4, ["PABIG"])                           # SNS will fail for this one

    alerts = {a.username: a for a in price_alerts.find_alerts(conn, TODAY)}
    assert set(alerts) == {"pa-cautious", "pa-down"}, "pa-bold: -5 % is under 7 %"
    assert [m.symbol for m in alerts["pa-cautious"].moves] == ["PABIG", "PASMALL"], "largest first; stale PAOLD ignored"
    assert alerts["pa-cautious"].moves[0].change_pct == pytest.approx(-5.0)

    sns = FakeSns(fail_for={"pa-down"})
    report = price_alerts.send_alerts(conn, sns, "arn:topic", list(alerts.values()))
    assert report.users_notified == 1 and report.moves_sent == 2
    assert report.failed_users == ["pa-down"]
    (msg,) = sns.published
    assert msg["MessageAttributes"]["username"]["StringValue"] == "pa-cautious"
    assert msg["Subject"] == "Alerte de prix : 2 titres ont fortement varie"

    # Rerun: already sent for pa-cautious, still pending for pa-down (publish failed).
    again = {a.username for a in price_alerts.find_alerts(conn, TODAY)}
    assert again == {"pa-down"}

    # A new trading day with a new move alerts again.
    bar(conn, "PABIG", fri + timedelta(days=3), 85)  # Monday, -10.5 %
    later = {a.username: a for a in price_alerts.find_alerts(conn, fri + timedelta(days=3))}
    assert set(later) == {"pa-cautious", "pa-bold", "pa-down"}
    assert [m.symbol for m in later["pa-cautious"].moves] == ["PABIG"]


@needs_db
def test_dry_run_sends_and_records_nothing(conn):
    bar(conn, "PABIG", TODAY - timedelta(days=1), 100)
    bar(conn, "PABIG", TODAY, 90)
    subscribe(conn, "pa-dry", 4, ["PABIG"])
    report = price_alerts.run(conn, None, "arn:topic", TODAY, dry_run=True)
    assert report.users_notified == 0
    assert [a.username for a in price_alerts.find_alerts(conn, TODAY)] == ["pa-dry"]

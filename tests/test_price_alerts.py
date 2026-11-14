"""Price-move alerts (src/marketdata/jobs/price_alerts.py).

The message tests always run. The database tests need TEST_DATABASE_URL on a
throwaway database with db/migrations V1..V6 applied (they delete rows).
"""

import os
import uuid
from datetime import UTC, date, datetime, timedelta

import pytest

from marketdata.jobs import daily_refresh, price_alerts
from marketdata.jobs.price_alerts import PriceMove, UserAlert, compose

TODAY = date(2026, 11, 13)  # a Friday
TOKEN = uuid.UUID("12345678-1234-4234-8234-123456789abc")


def move(symbol, close, prev, day=TODAY):
    return PriceMove(symbol, day, close, day - timedelta(days=1), prev)


def alert(username, threshold, moves, email=None):
    return UserAlert(username, email or f"{username}@example.com", threshold, TOKEN, moves)


# --- Message ------------------------------------------------------------------


def test_single_move_email():
    email = compose(alert("ana", 4.0, [move("RY.TO", 162.35, 171.25)]), "http://app")
    assert email.subject == "Alerte de prix : RY.TO −5,2 %"  # SES: UTF-8 subjects are fine
    for part in (email.text, email.html):
        assert "−5,2 %" in part
        assert "171,25 → 162,35" in part
        assert "4 % ou plus" in part
        assert "niveau de risque" in part
        assert "Yahoo Finance" in part  # source
        assert "pas un conseil financier" in part
    assert email.unsubscribe_url == f"http://app/desabonnement?u=ana&t={TOKEN}"
    assert email.unsubscribe_url in email.text
    assert f'href="http://app/desabonnement?u=ana&amp;t={TOKEN}"' in email.html


def test_several_moves_in_one_email():
    email = compose(alert("ana", 2.0, [move("SHOP.TO", 160, 150), move("TD.TO", 77, 79.15)]))
    assert email.subject == "Alerte de prix : 2 titres ont fortement varié"
    assert "▲ SHOP.TO" in email.text and "+6,7 %" in email.text
    assert "▼ TD.TO" in email.text
    assert "Voir votre portefeuille" not in email.text  # no app URL given


def test_html_escapes_and_username_is_url_encoded():
    email = compose(alert("a&b <x>", 4.0, [move("RY.TO", 90, 100)]), "http://app")
    assert "u=a%26b%20%3Cx%3E" in email.unsubscribe_url
    assert "<x>" not in email.html


def test_alerts_are_skipped_without_a_sender(caplog):
    caplog.set_level("INFO")
    daily_refresh.send_price_alerts(conn=None, env={})
    assert "no price alerts" in caplog.text


# --- Database -----------------------------------------------------------------

needs_db = pytest.mark.skipif(not os.environ.get("TEST_DATABASE_URL"), reason="TEST_DATABASE_URL not set")


class FakeSes:
    def __init__(self, reject=()):
        self.sent, self.reject = [], set(reject)

    def send_email(self, **kwargs):
        to = kwargs["Destination"]["ToAddresses"][0]
        if to in self.reject:  # e.g. sandbox, address not verified yet
            raise RuntimeError("MessageRejected: Email address is not verified")
        self.sent.append(kwargs)
        return {"MessageId": str(len(self.sent))}


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
        """INSERT INTO notification_subscriptions (username, email, threshold_pct, symbols)
           VALUES (%s, %s, %s, %s)""",
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
    subscribe(conn, "pa-unverified", 4, ["PABIG"])                     # SES rejects (sandbox)

    alerts = {a.username: a for a in price_alerts.find_alerts(conn, TODAY)}
    assert set(alerts) == {"pa-cautious", "pa-unverified"}, "pa-bold: -5 % is under 7 %"
    assert [m.symbol for m in alerts["pa-cautious"].moves] == ["PABIG", "PASMALL"], "largest first; stale PAOLD ignored"
    assert alerts["pa-cautious"].moves[0].change_pct == pytest.approx(-5.0)
    assert alerts["pa-cautious"].email == "pa-cautious@example.com"
    assert isinstance(alerts["pa-cautious"].unsubscribe_token, uuid.UUID)

    ses = FakeSes(reject={"pa-unverified@example.com"})
    report = price_alerts.send_alerts(conn, ses, "alertes@example.com", list(alerts.values()),
                                      app_url="http://app", configuration_set="cfg")
    assert report.users_notified == 1 and report.moves_sent == 2
    assert report.failed_users == ["pa-unverified"]
    (msg,) = ses.sent
    assert msg["FromEmailAddress"] == "alertes@example.com"
    assert msg["Destination"] == {"ToAddresses": ["pa-cautious@example.com"]}
    assert msg["ConfigurationSetName"] == "cfg"
    simple = msg["Content"]["Simple"]
    assert simple["Subject"]["Data"] == "Alerte de prix : 2 titres ont fortement varié"
    (header,) = simple["Headers"]
    assert header["Name"] == "List-Unsubscribe" and "/desabonnement?u=pa-cautious&t=" in header["Value"]

    # Rerun: already sent for pa-cautious, still pending for pa-unverified (send failed).
    assert {a.username for a in price_alerts.find_alerts(conn, TODAY)} == {"pa-unverified"}

    # A new trading day with a new move alerts again.
    bar(conn, "PABIG", fri + timedelta(days=3), 85)  # Monday, -10.5 %
    later = {a.username: a for a in price_alerts.find_alerts(conn, fri + timedelta(days=3))}
    assert set(later) == {"pa-cautious", "pa-bold", "pa-unverified"}
    assert [m.symbol for m in later["pa-cautious"].moves] == ["PABIG"]


@needs_db
def test_dry_run_sends_and_records_nothing(conn):
    bar(conn, "PABIG", TODAY - timedelta(days=1), 100)
    bar(conn, "PABIG", TODAY, 90)
    subscribe(conn, "pa-dry", 4, ["PABIG"])
    report = price_alerts.run(conn, None, "alertes@example.com", TODAY, dry_run=True)
    assert report.users_notified == 0
    assert [a.username for a in price_alerts.find_alerts(conn, TODAY)] == ["pa-dry"]

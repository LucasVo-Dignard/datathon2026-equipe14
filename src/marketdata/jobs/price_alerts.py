"""Price-move alerts by email, through Amazon SNS.

Runs at the end of the daily refresh (``daily_refresh.py``) when
``NOTIFICATIONS_TOPIC_ARN`` is set, or on its own::

    DATABASE_URL=postgresql://bncd_admin:localdev@127.0.0.1:5432/marketdata \\
    NOTIFICATIONS_TOPIC_ARN=arn:aws:sns:... python -m marketdata.jobs.price_alerts [--dry-run]

For every subscription (table ``notification_subscriptions``, written by the
web app), it compares the two latest daily closes of each of the user's
symbols. A move of ``threshold_pct`` or more (the threshold follows the
user's risk level) becomes an alert. Each user gets at most one email per run,
listing all their moves, published with the ``username`` message attribute:
the SNS subscription's filter policy delivers it to that user only.

``price_alerts_sent`` records what was sent, so a rerun or an AWS Batch retry
never sends the same move twice. A failed publish records nothing, so it is
retried on the next run.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
import unicodedata
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import date
from typing import Any

import psycopg

from marketdata.db import connect

log = logging.getLogger("marketdata.price_alerts")

TOPIC_ENV_VAR = "NOTIFICATIONS_TOPIC_ARN"
PROVIDER = "yahoo"
# Ignore bars older than this (weekend + a holiday): no alert on stale data.
MAX_BAR_AGE_DAYS = 4

MONTHS = ("janvier", "février", "mars", "avril", "mai", "juin", "juillet",
          "août", "septembre", "octobre", "novembre", "décembre")


@dataclass(frozen=True)
class PriceMove:
    symbol: str
    date: date
    close: float
    prev_date: date
    prev_close: float

    @property
    def change_pct(self) -> float:
        return (self.close / self.prev_close - 1) * 100


@dataclass
class UserAlert:
    username: str
    threshold_pct: float
    moves: list[PriceMove] = field(default_factory=list)


# Latest bar of each symbol and the one before it (adjusted closes, so
# dividends and splits don't look like moves), for subscribed symbols only.
FIND_ALERTS_SQL = """
WITH subscribed AS (
    SELECT DISTINCT unnest(symbols) AS symbol FROM notification_subscriptions
),
bars AS (
    SELECT b.symbol, b.date, b.adj_close,
           lag(b.date)      OVER w AS prev_date,
           lag(b.adj_close) OVER w AS prev_close,
           row_number()     OVER (PARTITION BY b.symbol ORDER BY b.date DESC) AS rn
      FROM price_bars b
      JOIN subscribed s ON s.symbol = b.symbol
     WHERE b.provider = %(provider)s
       AND b.date > %(today)s::date - 30
    WINDOW w AS (PARTITION BY b.symbol ORDER BY b.date)
)
SELECT n.username, n.threshold_pct, b.symbol, b.date, b.adj_close, b.prev_date, b.prev_close
  FROM notification_subscriptions n
  CROSS JOIN LATERAL unnest(n.symbols) AS sym(symbol)
  JOIN bars b ON b.symbol = sym.symbol AND b.rn = 1
 WHERE b.prev_close > 0
   AND b.date >= %(today)s::date - %(max_age)s
   AND abs(b.adj_close / b.prev_close - 1) * 100 >= n.threshold_pct
   AND NOT EXISTS (
       SELECT 1 FROM price_alerts_sent a
        WHERE a.username = n.username AND a.symbol = b.symbol AND a.bar_date = b.date)
 ORDER BY n.username, abs(b.adj_close / b.prev_close - 1) DESC, b.symbol
"""


def find_alerts(conn: psycopg.Connection, today: date) -> list[UserAlert]:
    rows = conn.execute(
        FIND_ALERTS_SQL, {"provider": PROVIDER, "today": today, "max_age": MAX_BAR_AGE_DAYS}
    ).fetchall()
    alerts: dict[str, UserAlert] = {}
    for username, threshold, symbol, day, close, prev_day, prev_close in rows:
        alert = alerts.setdefault(username, UserAlert(username, float(threshold)))
        alert.moves.append(PriceMove(symbol, day, float(close), prev_day, float(prev_close)))
    return list(alerts.values())


# --- Message ------------------------------------------------------------------


def ascii_subject(text: str) -> str:
    """SNS email subjects must be ASCII, under 100 characters."""
    for src, dst in (("\u2212", "-"), ("\u2013", "-"), ("\u2019", "'"), ("\u00a0", " "), ("\u202f", " ")):
        text = text.replace(src, dst)
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return text[:99]


def fr_number(value: float, decimals: int = 2) -> str:
    return f"{value:,.{decimals}f}".replace(",", " ").replace(".", ",")


def fr_pct(value: float) -> str:
    sign = "+" if value > 0 else "−" if value < 0 else ""
    return f"{sign}{fr_number(abs(value), 1)} %"


def fr_date(d: date) -> str:
    return f"{d.day} {MONTHS[d.month - 1]} {d.year}"


def compose(alert: UserAlert, app_url: str = "") -> tuple[str, str]:
    moves = alert.moves
    if len(moves) == 1:
        m = moves[0]
        subject = f"Alerte de prix : {m.symbol} {fr_pct(m.change_pct)}"
        intro = f"Un titre de votre portefeuille a fortement varié lors de la séance du {fr_date(m.date)} :"
    else:
        subject = f"Alerte de prix : {len(moves)} titres ont fortement varié"
        intro = "Plusieurs titres de votre portefeuille ont fortement varié lors de la dernière séance :"

    lines = [
        f"  {'▲' if m.change_pct > 0 else '▼'} {m.symbol:<9} {fr_pct(m.change_pct):>9}"
        f"   ({fr_number(m.prev_close)} → {fr_number(m.close)}, du {fr_date(m.prev_date)} au {fr_date(m.date)})"
        for m in moves
    ]
    threshold = fr_number(alert.threshold_pct, 0 if alert.threshold_pct.is_integer() else 1)
    body = [
        "Bonjour,",
        "",
        intro,
        "",
        *lines,
        "",
        f"Pourquoi ce courriel : vous êtes averti dès qu'un titre suivi varie de {threshold} % ou plus "
        "en une journée. Ce seuil découle de votre niveau de risque dans votre profil investisseur "
        "(plus le profil est prudent, plus l'alerte arrive tôt).",
        "",
        "Source : cours de clôture ajustés (dividendes et fractionnements) de Yahoo Finance, "
        "mis à jour par le job quotidien de l'application.",
        "",
        "À garder en tête : une variation d'une seule journée ne dit rien de la tendance à long terme, "
        "et vendre après une forte baisse fige souvent la perte. Comparez-la plutôt à votre horizon "
        "et à vos objectifs avant toute décision.",
    ]
    if app_url:
        body += ["", f"Voir votre portefeuille et demander une explication à l'assistant : {app_url}"]
    body += [
        "",
        "—",
        "Simulation éducative (prototype du Datathon 2026) : ce message n'est pas un conseil financier "
        "personnalisé. Pour ne plus recevoir ces alertes : lien de désabonnement ci-dessous, ou page "
        "« Mon profil » de l'application.",
    ]
    return ascii_subject(subject), "\n".join(body)


# --- Sending ------------------------------------------------------------------


@dataclass
class AlertReport:
    users_notified: int = 0
    moves_sent: int = 0
    failed_users: list[str] = field(default_factory=list)


def send_alerts(
    conn: psycopg.Connection,
    sns: Any,
    topic_arn: str,
    alerts: Sequence[UserAlert],
    app_url: str = "",
) -> AlertReport:
    """Publish one email per user, then record the moves as sent. ``conn``
    must be in autocommit mode (each user is its own transaction)."""
    report = AlertReport()
    for alert in alerts:
        subject, message = compose(alert, app_url)
        try:
            sns.publish(
                TopicArn=topic_arn,
                Subject=subject,
                Message=message,
                MessageAttributes={"username": {"DataType": "String", "StringValue": alert.username}},
            )
        except Exception as exc:  # one failure must not stop the others
            report.failed_users.append(alert.username)
            log.warning("publish to %s failed: %s", alert.username, exc)
            continue
        with conn.transaction():
            for m in alert.moves:
                conn.execute(
                    """
                    INSERT INTO price_alerts_sent (username, symbol, bar_date, change_pct)
                    VALUES (%s, %s, %s, %s)
                    ON CONFLICT DO NOTHING
                    """,
                    (alert.username, m.symbol, m.date, round(m.change_pct, 3)),
                )
        report.users_notified += 1
        report.moves_sent += len(alert.moves)
        log.info("alert sent to %s: %s", alert.username,
                 ", ".join(f"{m.symbol} {m.change_pct:+.1f}%" for m in alert.moves))
    return report


def run(
    conn: psycopg.Connection,
    sns: Any,
    topic_arn: str,
    today: date,
    app_url: str = "",
    dry_run: bool = False,
) -> AlertReport:
    alerts = find_alerts(conn, today)
    log.info("%d user(s) with price moves to report", len(alerts))
    if dry_run:
        for alert in alerts:
            subject, message = compose(alert, app_url)
            log.info("[dry run] %s: %s\n%s", alert.username, subject, message)
        return AlertReport()
    return send_alerts(conn, sns, topic_arn, alerts, app_url)


def sns_client(topic_arn: str) -> Any:
    import boto3

    return boto3.client("sns", region_name=topic_arn.split(":")[3])


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Send price-move alerts by email (SNS).")
    parser.add_argument("--dry-run", action="store_true", help="print the emails, send nothing")
    parser.add_argument("--today", type=date.fromisoformat, default=None, help="override today (YYYY-MM-DD)")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    topic_arn = os.environ.get(TOPIC_ENV_VAR, "")
    if not topic_arn and not args.dry_run:
        log.error("%s is not set", TOPIC_ENV_VAR)
        return 1
    today = args.today or date.today()
    with connect() as conn:
        conn.autocommit = True
        report = run(conn, None if args.dry_run else sns_client(topic_arn), topic_arn, today,
                     os.environ.get("APP_URL", ""), dry_run=args.dry_run)
    log.info("alerts: %d user(s), %d move(s), %d failure(s)",
             report.users_notified, report.moves_sent, len(report.failed_users))
    return 1 if report.failed_users and not report.users_notified else 0


if __name__ == "__main__":
    sys.exit(main())

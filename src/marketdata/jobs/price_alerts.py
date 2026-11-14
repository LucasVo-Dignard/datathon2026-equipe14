"""Price-move alerts by email, through Amazon SES.

Runs at the end of the daily refresh (``daily_refresh.py``) when
``ALERTS_SENDER`` is set, or on its own::

    DATABASE_URL=postgresql://bncd_admin:localdev@127.0.0.1:5432/marketdata \\
    ALERTS_SENDER=alertes@example.com python -m marketdata.jobs.price_alerts [--dry-run]

For every subscription (table ``notification_subscriptions``, written by the
web app), it compares the two latest daily closes of each of the user's
symbols. A move of ``threshold_pct`` or more (the threshold follows the
user's risk level) becomes an alert. Each user gets at most one email per run,
listing all their moves, sent with SES to the subscription's address. Every
email has a one-click unsubscribe link (``/desabonnement`` in the web app).

``price_alerts_sent`` records what was sent, so a rerun or an AWS Batch retry
never sends the same move twice. A failed send records nothing, so it is
retried on the next run. While the SES account is in the sandbox, an address
that has not been verified yet is rejected by SES and simply retried later.

Environment: ``ALERTS_SENDER`` (verified SES identity), optional
``SES_CONFIGURATION_SET`` and ``APP_URL`` (links in the email).
"""

from __future__ import annotations

import argparse
import html
import logging
import os
import sys
import uuid
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import date
from typing import Any
from urllib.parse import quote

import psycopg

from marketdata.db import connect

log = logging.getLogger("marketdata.price_alerts")

SENDER_ENV_VAR = "ALERTS_SENDER"
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
    email: str
    threshold_pct: float
    unsubscribe_token: uuid.UUID | str
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
SELECT n.username, n.email, n.threshold_pct, n.unsubscribe_token,
       b.symbol, b.date, b.adj_close, b.prev_date, b.prev_close
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
    for username, email, threshold, token, symbol, day, close, prev_day, prev_close in rows:
        alert = alerts.setdefault(username, UserAlert(username, email, float(threshold), token))
        alert.moves.append(PriceMove(symbol, day, float(close), prev_day, float(prev_close)))
    return list(alerts.values())


# --- Message ------------------------------------------------------------------


def fr_number(value: float, decimals: int = 2) -> str:
    return f"{value:,.{decimals}f}".replace(",", " ").replace(".", ",")


def fr_pct(value: float) -> str:
    sign = "+" if value > 0 else "−" if value < 0 else ""
    return f"{sign}{fr_number(abs(value), 1)} %"


def fr_date(d: date) -> str:
    return f"{d.day} {MONTHS[d.month - 1]} {d.year}"


def unsubscribe_url(app_url: str, username: str, token: uuid.UUID | str) -> str:
    return f"{app_url}/desabonnement?u={quote(username, safe='')}&t={token}"


@dataclass(frozen=True)
class Email:
    subject: str
    text: str
    html: str
    unsubscribe_url: str


FOOTER = ("Simulation éducative (prototype du Datathon 2026) : ce message n'est pas un "
          "conseil financier personnalisé.")


def compose(alert: UserAlert, app_url: str = "") -> Email:
    moves = alert.moves
    if len(moves) == 1:
        m = moves[0]
        subject = f"Alerte de prix : {m.symbol} {fr_pct(m.change_pct)}"
        intro = f"Un titre de votre portefeuille a fortement varié lors de la séance du {fr_date(m.date)} :"
    else:
        subject = f"Alerte de prix : {len(moves)} titres ont fortement varié"
        intro = "Plusieurs titres de votre portefeuille ont fortement varié lors de la dernière séance :"

    def detail(m: PriceMove) -> str:
        return (f"{fr_number(m.prev_close)} → {fr_number(m.close)}, "
                f"du {fr_date(m.prev_date)} au {fr_date(m.date)}")

    threshold = fr_number(alert.threshold_pct, 0 if alert.threshold_pct.is_integer() else 1)
    explanation = [
        f"Pourquoi ce courriel : vous êtes averti dès qu'un titre suivi varie de {threshold} % ou plus "
        "en une journée. Ce seuil découle de votre niveau de risque dans votre profil investisseur "
        "(plus le profil est prudent, plus l'alerte arrive tôt).",
        "Source : cours de clôture ajustés (dividendes et fractionnements) de Yahoo Finance, "
        "mis à jour par le job quotidien de l'application.",
        "À garder en tête : une variation d'une seule journée ne dit rien de la tendance à long terme, "
        "et vendre après une forte baisse fige souvent la perte. Comparez-la plutôt à votre horizon "
        "et à vos objectifs avant toute décision.",
    ]
    unsubscribe = unsubscribe_url(app_url, alert.username, alert.unsubscribe_token)

    text_lines = [
        "Bonjour,", "", intro, "",
        *(f"  {'▲' if m.change_pct > 0 else '▼'} {m.symbol:<9} {fr_pct(m.change_pct):>9}   ({detail(m)})"
          for m in moves),
        "",
    ]
    for p in explanation:
        text_lines += [p, ""]
    if app_url:
        text_lines += [f"Voir votre portefeuille et demander une explication à l'assistant : {app_url}", ""]
    text_lines += ["—", FOOTER, f"Ne plus recevoir ces alertes : {unsubscribe}"]

    e = html.escape
    rows = "\n".join(
        f'<tr><td style="padding:4px 12px 4px 0;font-weight:600">{e(m.symbol)}</td>'
        f'<td style="padding:4px 12px 4px 0;font-weight:600;color:{"#006300" if m.change_pct > 0 else "#d03b3b"}">'
        f'{"▲" if m.change_pct > 0 else "▼"} {e(fr_pct(m.change_pct))}</td>'
        f'<td style="padding:4px 0;color:#52514e">{e(detail(m))}</td></tr>'
        for m in moves
    )
    link = (f'<p><a href="{e(app_url)}">Voir votre portefeuille et demander une explication à '
            f"l'assistant</a></p>" if app_url else "")
    html_body = (
        '<!doctype html><html lang="fr"><body style="font-family:system-ui,-apple-system,Segoe UI,'
        'Roboto,sans-serif;color:#0b0b0b;line-height:1.5;max-width:600px">'
        f"<p>Bonjour,</p><p>{e(intro)}</p><table>{rows}</table>"
        + "".join(f"<p>{e(p)}</p>" for p in explanation)
        + link
        + '<hr style="border:0;border-top:1px solid #e1e0d9">'
        f'<p style="font-size:12px;color:#52514e">{e(FOOTER)}<br>'
        f'<a href="{e(unsubscribe)}" style="color:#52514e">Ne plus recevoir ces alertes</a></p>'
        "</body></html>"
    )
    return Email(subject, "\n".join(text_lines), html_body, unsubscribe)


# --- Sending ------------------------------------------------------------------


@dataclass
class AlertReport:
    users_notified: int = 0
    moves_sent: int = 0
    failed_users: list[str] = field(default_factory=list)


def send_alerts(
    conn: psycopg.Connection,
    ses: Any,
    sender: str,
    alerts: Sequence[UserAlert],
    app_url: str = "",
    configuration_set: str = "",
) -> AlertReport:
    """Send one email per user with SES, then record the moves as sent.
    ``conn`` must be in autocommit mode (each user is its own transaction)."""
    report = AlertReport()
    for alert in alerts:
        email = compose(alert, app_url)
        request: dict[str, Any] = {
            "FromEmailAddress": sender,
            "Destination": {"ToAddresses": [alert.email]},
            "Content": {"Simple": {
                "Subject": {"Data": email.subject, "Charset": "UTF-8"},
                "Body": {"Text": {"Data": email.text, "Charset": "UTF-8"},
                         "Html": {"Data": email.html, "Charset": "UTF-8"}},
                "Headers": [{"Name": "List-Unsubscribe", "Value": f"<{email.unsubscribe_url}>"}],
            }},
        }
        if configuration_set:
            request["ConfigurationSetName"] = configuration_set
        try:
            ses.send_email(**request)
        except Exception as exc:  # one failure (e.g. unverified address) must not stop the others
            report.failed_users.append(alert.username)
            log.warning("email to %s failed: %s", alert.username, exc)
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
    ses: Any,
    sender: str,
    today: date,
    app_url: str = "",
    configuration_set: str = "",
    dry_run: bool = False,
) -> AlertReport:
    alerts = find_alerts(conn, today)
    log.info("%d user(s) with price moves to report", len(alerts))
    if dry_run:
        for alert in alerts:
            email = compose(alert, app_url)
            log.info("[dry run] %s: %s\n%s", alert.username, email.subject, email.text)
        return AlertReport()
    return send_alerts(conn, ses, sender, alerts, app_url, configuration_set)


def ses_client() -> Any:
    import boto3

    return boto3.client("sesv2")


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Send price-move alerts by email (SES).")
    parser.add_argument("--dry-run", action="store_true", help="print the emails, send nothing")
    parser.add_argument("--today", type=date.fromisoformat, default=None, help="override today (YYYY-MM-DD)")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    sender = os.environ.get(SENDER_ENV_VAR, "")
    if not sender and not args.dry_run:
        log.error("%s is not set", SENDER_ENV_VAR)
        return 1
    today = args.today or date.today()
    with connect() as conn:
        conn.autocommit = True
        report = run(conn, None if args.dry_run else ses_client(), sender, today,
                     os.environ.get("APP_URL", ""), os.environ.get("SES_CONFIGURATION_SET", ""),
                     dry_run=args.dry_run)
    log.info("alerts: %d user(s), %d move(s), %d failure(s)",
             report.users_notified, report.moves_sent, len(report.failed_users))
    return 1 if report.failed_users and not report.users_notified else 0


if __name__ == "__main__":
    sys.exit(main())

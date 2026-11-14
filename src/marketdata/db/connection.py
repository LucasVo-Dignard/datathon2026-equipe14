"""Open a PostgreSQL connection from environment variables.

Two modes, so the same code runs locally and on AWS:

* ``DATABASE_URL`` set (local Docker Postgres, see ``db/README.md``)::

      DATABASE_URL=postgresql://bncd_admin:localdev@127.0.0.1:5432/marketdata

* Otherwise ``DB_HOST``, ``DB_PORT``, ``DB_NAME`` and ``DB_SECRET_ARN`` (the
  AWS Batch job, see ``infra-batch/``). The user name and password are read
  from Secrets Manager at runtime and never written anywhere. TLS is required.
"""

from __future__ import annotations

import json
import os
from collections.abc import Callable, Mapping
from typing import Any

import psycopg

from marketdata.errors import ConfigurationError


def _read_secret(secret_arn: str) -> Mapping[str, Any]:
    import boto3  # only needed on AWS

    response = boto3.client("secretsmanager").get_secret_value(SecretId=secret_arn)
    return json.loads(response["SecretString"])


def connect(
    env: Mapping[str, str] | None = None,
    *,
    read_secret: Callable[[str], Mapping[str, Any]] = _read_secret,
    connect_fn: Callable[..., psycopg.Connection] = psycopg.connect,
) -> psycopg.Connection:
    env = os.environ if env is None else env
    url = env.get("DATABASE_URL")
    if url:
        return connect_fn(url)

    missing = [name for name in ("DB_HOST", "DB_NAME", "DB_SECRET_ARN") if not env.get(name)]
    if missing:
        raise ConfigurationError(
            "set DATABASE_URL, or DB_HOST, DB_NAME and DB_SECRET_ARN (missing: "
            + ", ".join(missing)
            + ")"
        )
    secret = read_secret(env["DB_SECRET_ARN"])
    return connect_fn(
        host=env["DB_HOST"],
        port=int(env.get("DB_PORT") or 5432),
        dbname=env["DB_NAME"],
        user=secret["username"],
        password=secret["password"],
        sslmode="require",
        connect_timeout=10,
        application_name="marketdata-daily-refresh",
    )

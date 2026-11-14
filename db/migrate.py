"""Run Flyway against an environment's RDS database, from any teammate's machine.

    python db/migrate.py            # apply pending migrations
    python db/migrate.py info       # show applied / pending, change nothing
    python db/migrate.py validate   # check applied files were not edited
    python db/migrate.py --env prod info

The environment (lucas, andre, youcef or prod) comes from --env, or from
TF_WORKSPACE (set in .env-dev, like for Terraform). There is no default, so
prod is only touched when asked for by name.

How it works (the database is private, only the web server can reach it):
  1. Packages db/flyway.toml and db/migrations/ and uploads them to the
     environment's private migrations bucket.
  2. Asks the environment's web server, through AWS Systems Manager (no SSH,
     no open port), to download the bundle, read the DB password from Secrets
     Manager and run Flyway in Docker.
  3. Prints Flyway's output and exits non-zero if it failed.

Needs only boto3 and the AWS credentials in .env-aws (loaded automatically,
with .env-dev).
"""

from __future__ import annotations

import argparse
import io
import os
import shlex
import sys
import tarfile
import time
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import boto3

PROJECT = "datathon2026-equipe14"
REGION = "us-east-1"
# Keep in sync with dev_environments in infra*/env.tf. prod = default workspace.
ENVIRONMENTS = ("prod", "lucas", "andre", "youcef")
FLYWAY_IMAGE = "flyway/flyway:13"  # keep in sync with db/docker-compose.yml
COMMANDS = ("migrate", "info", "validate")
TIMEOUT_SECONDS = 600

DB_DIR = Path(__file__).resolve().parent
AWS_ENV_FILE = DB_DIR.parent / ".env-aws"
DEV_ENV_FILE = DB_DIR.parent / ".env-dev"


def load_env_file(path: Path) -> None:
    """Load KEY=VALUE lines into the environment, without overriding variables
    already set. Values are never printed."""
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.removeprefix("export ").split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip("'\""))


def resource_prefix(env: str) -> str:
    """Same naming as local.prefix in infra*/env.tf."""
    return PROJECT if env == "prod" else f"{PROJECT}-{env}"


@dataclass(frozen=True)
class Target:
    """Where and how to run Flyway, discovered from AWS by resource names."""

    instance_id: str
    bucket: str
    db_host: str
    db_port: int
    db_name: str
    db_user: str
    secret_arn: str


def discover_target(session: boto3.Session, prefix: str) -> Target:
    web_instance_name = f"{prefix}-web"
    db_identifier = f"{prefix}-db"
    ec2 = session.client("ec2")
    reservations = ec2.describe_instances(
        Filters=[
            {"Name": "tag:Name", "Values": [web_instance_name]},
            {"Name": "instance-state-name", "Values": ["running"]},
        ]
    )["Reservations"]
    instances = [i for r in reservations for i in r["Instances"]]
    if len(instances) != 1:
        sys.exit(f"Expected 1 running instance named {web_instance_name}, found {len(instances)}.")

    db = session.client("rds").describe_db_instances(DBInstanceIdentifier=db_identifier)[
        "DBInstances"
    ][0]
    if db["DBInstanceStatus"] != "available":
        sys.exit(f"Database is {db['DBInstanceStatus']!r}, not 'available'.")

    account = session.client("sts").get_caller_identity()["Account"]
    return Target(
        instance_id=instances[0]["InstanceId"],
        bucket=f"{prefix}-migrations-{account}",
        db_host=db["Endpoint"]["Address"],
        db_port=db["Endpoint"]["Port"],
        db_name=db["DBName"],
        db_user=db["MasterUsername"],
        secret_arn=db["MasterUserSecret"]["SecretArn"],
    )


def build_bundle() -> bytes:
    """tar.gz of flyway.toml and migrations/, the only files Flyway needs."""
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
        tar.add(DB_DIR / "flyway.toml", arcname="flyway.toml")
        tar.add(DB_DIR / "migrations", arcname="migrations")
    return buffer.getvalue()


def remote_script(target: Target, bundle_key: str, command: str) -> list[str]:
    """Shell commands run as root on the web server. The password goes from
    Secrets Manager into an environment variable and is never printed."""
    q = shlex.quote
    jdbc_url = f"jdbc:postgresql://{target.db_host}:{target.db_port}/{target.db_name}"
    return [
        "set -euo pipefail",
        f"export AWS_DEFAULT_REGION={q(REGION)}",
        "command -v docker >/dev/null || dnf install -y -q docker >/dev/null",
        "systemctl start docker",
        'work="$(mktemp -d)"',
        "trap 'rm -rf \"$work\"' EXIT",
        f'aws s3 cp {q(f"s3://{target.bucket}/{bundle_key}")} "$work/bundle.tar.gz" --only-show-errors',
        'tar -xzf "$work/bundle.tar.gz" -C "$work"',
        "FLYWAY_PASSWORD=\"$(aws secretsmanager get-secret-value"
        f" --secret-id {q(target.secret_arn)} --query SecretString --output text"
        " | python3 -c 'import json,sys; print(json.load(sys.stdin)[\"password\"])')\"",
        "export FLYWAY_PASSWORD",
        'docker run --rm -v "$work":/flyway/project:ro -w /flyway/project'
        f" -e FLYWAY_URL={q(jdbc_url)} -e FLYWAY_USER={q(target.db_user)} -e FLYWAY_PASSWORD"
        f" {q(FLYWAY_IMAGE)} {q(command)}",
    ]


def run_on_instance(session: boto3.Session, instance_id: str, commands: list[str]) -> int:
    ssm = session.client("ssm")
    try:
        command_id = ssm.send_command(
            InstanceIds=[instance_id],
            DocumentName="AWS-RunShellScript",
            Comment="Flyway via db/migrate.py",
            Parameters={"commands": commands, "executionTimeout": [str(TIMEOUT_SECONDS)]},
            TimeoutSeconds=60,
        )["Command"]["CommandId"]
    except ssm.exceptions.InvalidInstanceId:
        sys.exit(
            f"{instance_id} is not reachable through SSM yet. Check that ../infra is applied "
            "(instance profile) and wait a few minutes for the SSM agent to register."
        )

    deadline = time.monotonic() + TIMEOUT_SECONDS + 60
    while time.monotonic() < deadline:
        time.sleep(3)
        try:
            result = ssm.get_command_invocation(CommandId=command_id, InstanceId=instance_id)
        except ssm.exceptions.InvocationDoesNotExist:
            continue
        if result["Status"] in ("Pending", "InProgress", "Delayed"):
            continue
        print(result["StandardOutputContent"], end="")
        if result["StandardErrorContent"]:
            print(result["StandardErrorContent"], end="", file=sys.stderr)
        print(f"\n[{result['Status']}] exit code {result['ResponseCode']}")
        return 0 if result["Status"] == "Success" else 1
    sys.exit(f"Timed out waiting for SSM command {command_id}.")


def resolve_env(cli_env: str | None) -> str:
    env = cli_env or os.environ.get("TF_WORKSPACE", "")
    env = "prod" if env == "default" else env
    if not env:
        sys.exit("No environment: pass --env <name> or set TF_WORKSPACE in .env-dev "
                 f"({', '.join(ENVIRONMENTS)}).")
    if env not in ENVIRONMENTS:
        sys.exit(f"Unknown environment {env!r}: use one of {', '.join(ENVIRONMENTS)}.")
    return env


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    parser.add_argument("command", nargs="?", default="migrate", choices=COMMANDS)
    parser.add_argument("--env", help=f"target environment: {', '.join(ENVIRONMENTS)} (default: $TF_WORKSPACE)")
    args = parser.parse_args()

    if not os.environ.get("AWS_ACCESS_KEY_ID"):
        load_env_file(AWS_ENV_FILE)
    load_env_file(DEV_ENV_FILE)
    env = resolve_env(args.env)
    session = boto3.Session(region_name=REGION)
    target = discover_target(session, resource_prefix(env))

    bundle_key = f"bundles/{datetime.now(UTC):%Y%m%dT%H%M%SZ}-{uuid.uuid4().hex[:8]}.tar.gz"
    session.client("s3").put_object(Bucket=target.bucket, Key=bundle_key, Body=build_bundle())

    migrations = sorted(p.name for p in (DB_DIR / "migrations").glob("*.sql"))
    print(f"[{env.upper()}] flyway {args.command} on {target.db_name}@{target.db_host} via {target.instance_id}")
    print(f"local migrations: {', '.join(migrations) or '(none)'}\n")
    sys.exit(run_on_instance(session, target.instance_id, remote_script(target, bundle_key, args.command)))


if __name__ == "__main__":
    main()

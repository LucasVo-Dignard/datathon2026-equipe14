"""PostgreSQL access: ``connection`` opens a connection from the environment,
``repositories`` writes models to the tables in ``db/migrations``."""

from marketdata.db.connection import connect

__all__ = ["connect"]

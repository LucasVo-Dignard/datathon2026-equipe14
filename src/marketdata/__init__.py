"""Market data fetching for the BNCD info tool.

Layout:
- ``models``: provider-independent data types (one per future RDS table)
- ``fetchers``: abstract interfaces, one per kind of data
- ``providers.yahoo`` / ``providers.finnhub``: concrete implementations
- ``http``: rate limiting and retry policy
- ``errors``: exception hierarchy
"""

from marketdata.values import DateRange, normalize_symbol

__all__ = ["DateRange", "normalize_symbol"]

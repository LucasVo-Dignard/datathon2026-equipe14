-- Symbols refreshed every day by the batch job (src/marketdata/jobs).
-- Everything else is still loaded on demand.
--
-- To follow or drop a symbol, insert a row or set active = false; no new
-- migration is needed for that.

CREATE TABLE tracked_symbols (
    symbol             text        PRIMARY KEY,
    active             boolean     NOT NULL DEFAULT true,
    added_at           timestamptz NOT NULL DEFAULT now(),
    last_refreshed_at  timestamptz,
    last_error         text
);

-- Starter list: large TSX names plus a few US names our users often hold.
INSERT INTO tracked_symbols (symbol) VALUES
    ('RY.TO'), ('TD.TO'), ('BNS.TO'), ('BMO.TO'), ('CM.TO'), ('NA.TO'),
    ('MFC.TO'), ('SLF.TO'), ('ENB.TO'), ('TRP.TO'), ('CNQ.TO'), ('SU.TO'),
    ('CP.TO'), ('CNR.TO'), ('SHOP.TO'), ('CSU.TO'), ('ATD.TO'), ('BCE.TO'),
    ('T.TO'), ('ABX.TO'), ('NTR.TO'), ('WCN.TO'), ('BN.TO'), ('L.TO'),
    ('AAPL'), ('MSFT'), ('NVDA'), ('AMZN'), ('GOOGL'), ('META');

-- Scheduled portfolio reports (Rapports tab).
--
-- The user sets them up with the assistant (app/bot.js, tool set_report_schedule);
-- app/report-schedule-store.js writes these tables. Every hour, the reports
-- job (app/jobs/scheduled-reports.js, AWS Batch) writes the reports that are due.
--
-- report_preferences has one row once the user has answered (even "no
-- reports"), so the app stops suggesting the setup.

CREATE TABLE report_preferences (
    username       text        PRIMARY KEY REFERENCES users (username) ON DELETE CASCADE,
    configured_at  timestamptz NOT NULL DEFAULT now()
);

-- One row per report the user wants. When it runs, in timezone:
--   daily   -> Monday to Friday at hour
--   weekly  -> every weekday (ISO: 1 = Monday ... 7 = Sunday) at hour
--   monthly -> every month_day (1 to 28, so every month has it) at hour
--   yearly  -> every month_day of month at hour
CREATE TABLE report_schedules (
    username     text        NOT NULL REFERENCES report_preferences (username) ON DELETE CASCADE,
    period       text        NOT NULL CHECK (period IN ('daily', 'weekly', 'monthly', 'yearly')),
    weekday      smallint    CHECK (weekday BETWEEN 1 AND 7),
    month_day    smallint    CHECK (month_day BETWEEN 1 AND 28),
    month        smallint    CHECK (month BETWEEN 1 AND 12),
    hour         smallint    NOT NULL CHECK (hour BETWEEN 0 AND 23),
    timezone     text        NOT NULL DEFAULT 'America/Toronto',
    -- scheduled time of the last report written (or being written) by the job
    last_run_at  timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (username, period),
    CHECK (period <> 'weekly' OR weekday IS NOT NULL),
    CHECK (period NOT IN ('monthly', 'yearly') OR month_day IS NOT NULL),
    CHECK (period <> 'yearly' OR month IS NOT NULL)
);

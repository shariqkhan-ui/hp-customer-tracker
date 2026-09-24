-- ============================================================================
-- High Pain Tracker — "Would this ticket be pushed, and if not why?"
-- ----------------------------------------------------------------------------
-- Paste into Metabase (Database = 113, Native query) and set {{mobile}} as a
-- text Variable so the team can self-serve. Every ticket for that customer is
-- listed with the verdict the cron would reach.
--
-- It mirrors scripts/kapture-sync.js. The paths that can bring a ticket in:
--   1  model     SERVICE_TICKET_MODEL: internet title, IS_RESOLVED = 0, 72h–14d
--   2  chat      a CUSTOMER_CHAT ticket still OPEN after 72h
--   3  live-open T_TICKETS_NEW STATUS = 'OPEN', internet title, older than 72h
--                (catches tickets the model wrongly shows as resolved)
--   4  reopened  the ticket carries a TICKET_REOPENED event that is still the
--                last word on it — no TICKET_RESOLVED / TICKET_CLOSED /
--                CUSTOMER_CLOSE_TICKET after it — and it has passed 72h
--
-- Reopens are read from the EVENT LOG, never from
-- SERVICE_TICKET_MODEL.TIMES_REOPENED (a raw count of log rows, which the
-- pipeline duplicates ~94 times, so one reopen reads as 95) or
-- FIRST_REOPENED_TIME (only a ticket's first-ever reopen).
--
-- "WOULD BE PUSHED" means eligible by filter. The cron also skips a ticket that
-- is already in the tracker, sits with an exited CSP or a Wiom Net queue, or
-- has been tombstoned under /purged_tickets.
--
-- Every scan below is narrowed to this customer's tickets first — the log is
-- 125M rows and an unfiltered join to it will not return.
-- ============================================================================
WITH tk AS (
  SELECT
    t.TICKET_ID,
    REGEXP_REPLACE(t.KAPTURE_TICKET_ID, '[^0-9]', '')            AS TICKET,
    t.MOBILE,
    t.TITLE,
    t.STATUS                                                     AS LIVE_STATUS,
    t.CREATED_TIME,
    FLOOR(DATEDIFF(HOUR, t.CREATED_TIME, CURRENT_TIMESTAMP()))   AS AGE_HOURS
  FROM PROD_DB.PUBLIC.T_TICKETS_NEW t
  WHERE RIGHT(REGEXP_REPLACE(t.MOBILE, '[^0-9]', ''), 10)
      = RIGHT(REGEXP_REPLACE('{{mobile}}', '[^0-9]', ''), 10)
),
ev AS (
  SELECT
    TRY_TO_NUMBER(l.TASK_ID)                                                                 AS TID,
    MAX(CASE WHEN l.EVENT_NAME = 'TICKET_REOPENED' THEN l.ADDED_TIME END)                    AS LAST_REOPEN,
    MAX(CASE WHEN l.EVENT_NAME IN ('TICKET_RESOLVED','TICKET_CLOSED','CUSTOMER_CLOSE_TICKET')
             THEN l.ADDED_TIME END)                                                          AS LAST_CLOSE
  FROM PROD_DB.PUBLIC.TICKET_LOGS l
  WHERE l.EVENT_NAME IN ('TICKET_REOPENED','TICKET_RESOLVED','TICKET_CLOSED','CUSTOMER_CLOSE_TICKET')
    AND TRY_TO_NUMBER(l.TASK_ID) IN (SELECT TICKET_ID FROM tk)
  GROUP BY 1
),
md AS (
  SELECT
    REGEXP_REPLACE(stm.KAPTURE_TICKET_ID, '[^0-9]', '') AS TICKET,
    MAX(stm.IS_RESOLVED)                                AS IS_RESOLVED,
    MAX(stm.CURRENT_QUEUE)                              AS CURRENT_QUEUE,
    MAX(stm.CURRENT_PARTNER_NAME)                       AS PARTNER
  FROM PROD_DB.PUBLIC.SERVICE_TICKET_MODEL stm
  WHERE REGEXP_REPLACE(stm.KAPTURE_TICKET_ID, '[^0-9]', '') IN (SELECT TICKET FROM tk)
  GROUP BY 1
)
SELECT
  tk.MOBILE,
  tk.TICKET,
  tk.TITLE,
  TO_CHAR(tk.CREATED_TIME, 'DD/Mon/YYYY HH24:MI')       AS CREATED,
  tk.AGE_HOURS,
  tk.LIVE_STATUS,
  md.IS_RESOLVED,
  md.PARTNER,
  TO_CHAR(ev.LAST_REOPEN, 'DD/Mon HH24:MI')             AS LAST_REOPEN,
  TO_CHAR(ev.LAST_CLOSE,  'DD/Mon HH24:MI')             AS LAST_CLOSE,
  CASE
    WHEN NOT (tk.TITLE ILIKE '%internet%' OR tk.TITLE ILIKE '%slow speed%'
           OR tk.TITLE ILIKE '%frequent disconnection%' OR tk.TITLE ILIKE '%recharge done%')
      THEN '❌ not an internet title'
    WHEN tk.AGE_HOURS <= 72  THEN '⏳ younger than 72 hrs — not due yet'
    WHEN tk.AGE_HOURS > 336  THEN '❌ older than 14 days'
    WHEN COALESCE(md.CURRENT_QUEUE, '') ILIKE '%wiom net%' THEN '❌ Wiom Net queue'
    WHEN COALESCE(md.IS_RESOLVED, 1) = 0 THEN '✅ path 1 — model says unresolved, 72h–14d'
    WHEN tk.LIVE_STATUS = 'OPEN' AND ev.LAST_REOPEN IS NOT NULL
         AND (ev.LAST_CLOSE IS NULL OR ev.LAST_CLOSE < ev.LAST_REOPEN)
      THEN '✅ path 4 — reopened and still open'
    WHEN tk.LIVE_STATUS = 'OPEN' THEN '✅ path 3 — live-open past 72 hrs'
    WHEN ev.LAST_REOPEN IS NOT NULL AND ev.LAST_CLOSE > ev.LAST_REOPEN
      THEN '❌ was reopened on ' || TO_CHAR(ev.LAST_REOPEN, 'DD/Mon HH24:MI')
           || ' but closed again on ' || TO_CHAR(ev.LAST_CLOSE, 'DD/Mon HH24:MI')
    ELSE '❌ closed in Kapture (' || tk.LIVE_STATUS || ')'
  END AS VERDICT
FROM tk
LEFT JOIN ev ON ev.TID = tk.TICKET_ID
LEFT JOIN md ON md.TICKET = tk.TICKET
ORDER BY tk.CREATED_TIME DESC;

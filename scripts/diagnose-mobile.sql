-- ============================================================================
-- High Pain Tracker — "Would this mobile be pushed?" diagnostic
-- ----------------------------------------------------------------------------
-- Paste into Metabase (Database = 113, Native query). Replace the mobile below,
-- or turn '{{mobile}}' into a Metabase text Variable so the team can self-serve.
--
-- It mirrors the cron filter in scripts/kapture-sync.js EXACTLY:
--   internet sub-category · IS_RESOLVED = 0 · aged 72 hrs–14 days · non-blank Kapture ID
-- and prints, per ticket, whether it WOULD be pushed and — if not — every reason.
--
-- NOTE: "WOULD BE PUSHED" means eligible by filter. The live cron ALSO skips a
-- ticket if it is already in the Firebase tracker (dedup by ticket ID), so an
-- eligible ticket that's already tracked simply won't be re-added.
-- ============================================================================
WITH t AS (
  SELECT
    stm.CUSTOMER_MOBILE,
    stm.KAPTURE_TICKET_ID,
    stm.FIRST_TITLE,
    stm.IS_RESOLVED,
    stm.CURRENT_TICKET_STATUS,
    stm.TIMES_REOPENED,
    stm.CURRENT_PARTNER_NAME,
    TO_CHAR(stm.TICKET_ADDED_TIME, 'DD/Mon/YYYY HH24:MI')               AS CREATED,
    FLOOR(DATEDIFF(HOUR, stm.TICKET_ADDED_TIME, CURRENT_TIMESTAMP()))    AS AGE_HOURS,
    (   stm.FIRST_TITLE ILIKE '%internet supply down%'
     OR stm.FIRST_TITLE ILIKE '%slow speed%'
     OR stm.FIRST_TITLE ILIKE '%frequent disconnection%'
     OR stm.FIRST_TITLE ILIKE '%recharge done but no internet%'
     OR stm.FIRST_TITLE ILIKE '%internet not working%'
     OR stm.FIRST_TITLE ILIKE '%no internet%'
     OR stm.FIRST_TITLE ILIKE '%internet issue%'
     OR stm.FIRST_TITLE ILIKE '%internet%'
    )                                                                   AS IS_INTERNET
  FROM SERVICE_TICKET_MODEL stm
  WHERE stm.CUSTOMER_MOBILE = '{{mobile}}'
)
SELECT
  CUSTOMER_MOBILE,
  KAPTURE_TICKET_ID,
  FIRST_TITLE,
  CREATED,
  AGE_HOURS,
  IS_RESOLVED,
  CURRENT_TICKET_STATUS,
  CURRENT_PARTNER_NAME,
  CASE
    WHEN IS_INTERNET
         AND IS_RESOLVED = 0
         AND AGE_HOURS > 72
         AND AGE_HOURS <= 336
         AND KAPTURE_TICKET_ID IS NOT NULL
         AND KAPTURE_TICKET_ID != ''
    THEN '✅ WOULD BE PUSHED'
    ELSE '❌ SKIPPED: ' || TRIM(BOTH ', ' FROM
           (CASE WHEN NOT IS_INTERNET                                  THEN 'not internet sub-category, ' ELSE '' END)
        || (CASE WHEN IS_RESOLVED != 0                                 THEN 'already resolved, '          ELSE '' END)
        || (CASE WHEN AGE_HOURS <= 72                                  THEN 'younger than 72 hrs, '       ELSE '' END)
        || (CASE WHEN AGE_HOURS > 336                                  THEN 'older than 14 days, '        ELSE '' END)
        || (CASE WHEN KAPTURE_TICKET_ID IS NULL OR KAPTURE_TICKET_ID = '' THEN 'blank Kapture ticket ID, ' ELSE '' END)
         )
  END AS VERDICT
FROM t
ORDER BY AGE_HOURS ASC;

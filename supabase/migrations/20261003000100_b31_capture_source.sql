-- B31 (part 1 of 2): the task source for text Tapas shares into Life OS.
--
-- Value only, and nothing in this file USES it: Postgres refuses to use an
-- enum value in the transaction that adds it, which is why the tables are in
-- 20261003000200_b31_push_and_capture.sql (same pattern as B28).
--
--   task_source  capture  text sent from the iOS share sheet (a WhatsApp
--                         message, a note from a call). Often written by
--                         somebody else, so it is fenced as untrusted data
--                         exactly like source = 'email'.
--
-- NOT applied anywhere when it was written. Apply both B31 migrations before
-- deploying the B31 code.

alter type task_source add value if not exists 'capture';

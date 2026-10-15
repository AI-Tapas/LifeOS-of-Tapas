-- B36: terminal state for a queued email the owner saved to drafts instead of
-- sending. Its own file so the value is committed before the guard names it.
alter type assistant_action_status add value if not exists 'saved_as_draft';

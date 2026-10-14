# Send a reviewed message

Required inputs: typed job, preselected recipient, evidence bundle, draft, independent reviewer approval, idempotency key.

Preflight order: product kill switch → mailer kill switch → suppression → production arm → arm expiry/receipt → daily cap → weekly cap → send window → provider readiness.

If any check fails, do not retry blindly. Record a blocked/aborted receipt. In development and staging, write an `.eml` file to the local outbox and explicitly state that no external message was sent.

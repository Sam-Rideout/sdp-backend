# 100-song purchase-history archive

The backend builds a numbered PDF after each 100 eligible completed song purchases for an account. Paid single-song orders and delivered credit-redemption songs count. Test orders, refunds, credit bundles, and free promotions do not. The PDF is queued as an email attachment. The original sale ledger remains intact, and an archive JSON record plus its PDF are retained under `VOICE_DATA_DIR/purchase-history-archive`.

## Email worker

The existing `tools/profile_consent_worker.py` now also polls the protected purchase-archive queue and sends PDF attachments through the same SMTP account. It uses the existing worker's `VOICE_TRANSFER_TOKEN` and `PX_CONSENT_SMTP_*` settings; no new secrets are needed. It also accepts `PX_CONSENT_BACKEND_ORIGIN`, which already configures the profile-consent worker.

- `VOICE_TRANSFER_TOKEN`
- `PX_CONSENT_SMTP_HOST`
- `PX_CONSENT_SMTP_USER`
- `PX_CONSENT_SMTP_PASSWORD`
- `PX_CONSENT_SMTP_PORT` (defaults to `465`)
- `PX_CONSENT_MAIL_FROM`

Run `python tools/profile_consent_worker.py --loop` on the trusted Windows worker to check for queued PDFs once per hour. Override the interval with `--interval <seconds>` if needed. A one-shot run also drains up to five queued archive emails. Do not put the worker secrets in source control or customer-facing code.

## Data integrity

The account's sale ledger remains the accounting source of truth. Archive creation stops if the ledger reports record issues or contains an invalid completed purchase, so an incomplete 100-song PDF is not emailed. Archive state tracks each 100-song batch and its delivery status; sent PDFs are not removed from backend storage. My Orders snapshots and active-song limits are not modified by this feature.

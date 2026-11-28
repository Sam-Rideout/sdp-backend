# 100-song purchase-history archive

The backend builds a numbered PDF after each 100 eligible completed song purchases for an account. Paid single-song orders and delivered credit-redemption songs count. Test orders, refunds, credit bundles, and free promotions do not. The PDF is queued as an email attachment. The original sale ledger remains intact, and an archive JSON record plus its PDF are retained under `VOICE_DATA_DIR/purchase-history-archive`.

## Email worker

`tools/purchase_archive_worker.py` polls the protected archive queue. Run it on a trusted host that has network access to the Render backend and the configured SMTP account. It uses:

- `VOICE_TRANSFER_TOKEN`
- `PX_CONSENT_SMTP_HOST`
- `PX_CONSENT_SMTP_USER`
- `PX_CONSENT_SMTP_PASSWORD`
- `PX_CONSENT_SMTP_PORT` (defaults to `465`)
- `PX_CONSENT_MAIL_FROM`
- optionally `PX_PURCHASE_ARCHIVE_BACKEND_ORIGIN`

Run once to drain up to five queued messages, or use `--loop --interval 300` for continuous polling. Configure the worker with the same protected transfer token and SMTP credentials as the existing trusted mail worker. Do not put these secrets in source control or customer-facing code.

## Data integrity

The account's sale ledger remains the accounting source of truth. Archive creation stops if the ledger reports record issues or contains an invalid completed purchase, so an incomplete 100-song PDF is not emailed. Archive state tracks each 100-song batch and its delivery status; sent PDFs are not removed from backend storage. My Orders snapshots and active-song limits are not modified by this feature.

WIX SOURCE STAGING

These are complete replacement sources for the existing Wix Studio site.
Files in this directory are deployment references; committing them does not
publish Wix page code or activate the accounting synchronization.
The downloadable installer package provides matching .txt copies for pasting.

Deploy the backend, complete the guarded PC source installation, then publish
these Wix changes. Keep PXSalesSyncConfig SETTINGS enabled=false until the
read-only sales preview and Wix SDK readiness checks pass.

PROJECT X — ONE-TIME CREDITS, SALE PRICES, AND WIX ORDERS

Current live Wix CMS regular prices:
  A Song in Your Voice           CAD15.99
  Original Song + Your Message  CAD7.99
  Original Song                 CAD1.99
  20 Song Credits, one-time     CAD79.99
All sale switches are off. Monthly plans continue reading Wix Pricing Plans.

This package requires installation, Render deployment, and Wix publication.
Creating the CMS rows alone does not activate the new checkout or order sync.

1. Run Install_One_Time_Song_Credits.py --mode check using C:\Python314\python.exe.
   This runs synthetic tests and verifies the exact installed sources and existing
   cleanup safeguards. It does not stop workers or create purchases.
2. Run Install_One_Time_Song_Credits.ps1. It requests a graceful stop, installs
   only the three reviewed backend files, updates their verification entries,
   and restores a previously running supervisor. Failed installation rolls back.
   Existing consent, retention deadlines, audio, accounts and payment records
   are not modified by installation.
3. Review and deploy ONLY these backend changes:
     customer-song-requests.js
     song-commerce.js
     song-commerce-routes.js
   Preserve unrelated local changes, including phone_sequence_worker.py.
   Deployment must include all three files together. Do not change old legacy
   price constants: historical unquoted purchases retain their original prices.
4. Run Install_One_Time_Song_Credits.py --mode readiness after Render is live.
5. In Wix Studio's npm package manager, add these official packages:
     @wix/ecom
     @wix/data
     @wix/essentials
   The private accounting bridge uses the Wix backend identity and elevated API
   calls. No API key or customer credentials are added to frontend code.
6. Replace these complete Wix files using the matching .txt copies:
     backend/productPricing.js       Product_Pricing_Backend.txt
     backend/songReview.web.js       Song_Review_Backend.txt
     backend/songCommerceJobs.js     Commerce_Jobs_Backend.txt
   Create these NEW backend files:
     backend/pxWixSales.js           Wix_Orders_Sync_Backend.txt
     backend/salesAdmin.web.js       Sales_Admin_Backend.txt
   Do not replace backend/songCommerce.js; its existing private helper is reused.
   Do not change existing scheduled-job names or schedules.
7. Replace Song Review page code with Song_Review_Page_Code.txt.
   Replace #htmlSongReview's embedded HTML with Song_Review_Embed.txt.
   Replace Products and Pricing #htmlPricing's HTML with Pricing_Embed.txt.
   The pricing page remains informational with live prices and no checkout.
   Its existing page code and iframe placement settings stay in use.
   The new purchase button inherits the PX blue gradient, three shadows,
   198 x 30 dimensions, and 12 px button text.
8. Publish Wix. Using the backend web-method tester as site administrator, run
   salesAdmin.web.js -> checkSalesRecords(). This is read-only. Review that the
   historical individual purchase is the actual CAD8.99 payment, not today's
   CAD1.99 price. The monthly-plan purchase is already a native Wix Order and
   is excluded from the custom mirror.
9. After readiness and the preview pass, set PXSalesSyncConfig item SETTINGS
   enabled=true. Then run reconcileSalesRecords() once from the admin tester.
   Confirm the individual record and original monthly record in Wix Orders.
   Repeated reconciliation must keep the same individual order ID. The existing
   scheduled commerce jobs continue syncing automatically after enablement.

SALE CONTROLS — NO CODE EDIT NEEDED
In Wix CMS, use PXProductPricing for the three individual options and
PXCreditBundles for the one-time bundle:
  priceCad       Regular CAD price.
  salePriceCad   Optional sale CAD price, greater than zero and below priceCad.
  saleEnabled    Turn on to use the sale price; turn off to restore regular price.
  enabled        Product availability; this is separate from the sale switch.
Set a valid sale price first, then turn saleEnabled on. Refresh the pricing page.
The page shows both regular and sale prices using explicit text. Invalid enabled
sale data prevents checkout rather than inventing a fallback price.
Existing saved song quotes and pending bundle checkouts are not repriced.
Monthly plan prices remain managed in Wix Pricing Plans; recurring subscription
discounts are outside this package.

PAYMENT AND ACCOUNTING BEHAVIOR
- Exactly 20 credits are granted only after the authenticated successful Wix
  payment event matches the server price, payment ID, and account.
- Browser success messages do not grant credits or authorize delivery.
- Retrying a pending checkout reuses its payment. Deliberate later purchases can
  add another 20 credits. No monthly subscription is created for the bundle.
- Buying credits records the cash purchase once. Redeeming a credit produces a
  zero-additional-payment song record, avoiding counting the revenue twice.
- Native monthly purchases remain native; the mirror never duplicates them.
- Free tester samples and failed unpaid attempts are not sales imports.
- The order importer records existing paid activity. It does not recharge,
  create subscriptions, grant credits, or send buyer emails/receipts.
- Imported rows contain original provider references. Their dashboard refund
  controls must not be used to refund an original custom Wix Pay transaction;
  refunds belong to the original payment. Partial refunds are flagged for
  provider reconciliation without inventing an unknown refunded amount.
- Tax-inclusive totals preserve the existing custom-payment behavior. This
  package does not introduce tax calculation, tax registration, or a tax split.
- Order sync is accounting only. An accounting outage does not govern production
  or credit grants. A private conditional journal prevents concurrent duplicate
  creation. Lost acknowledgments are recovered by the external order reference.
  An uncertain import missing from Wix search is held for review, never blindly
  recreated. Search may lag. No native Wix order is overwritten.
- Current reconciliation handles 25 mutations per run and up to 5000 exported
  sales. An oversized export stops accounting for review, not song processing.

BACKFILL
One individual successful payment and one native monthly purchase were found.
No historical order has been imported during package preparation. The backfill
uses authenticated Render payment and saved-order facts after deployment. Missing
or mismatching evidence is reported for review; it is not inferred from today's
price or from the payment amount alone.

Disabling the mirror: set PXSalesSyncConfig SETTINGS enabled=false. This stops
accounting imports without disabling payments or the existing song workflow.

No live payment, credit grant, customer email, refund or historical order import
was performed while preparing or synthetically testing this package.

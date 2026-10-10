# [thankyouindoforthecleanair](https://thankyouindoforthecleanair.pages.dev/)

Thank you Indonesia for the clean air you brought over!

The site uses plain HTML, CSS, and JavaScript. Cloudflare Pages hosts it, and
Firebase Realtime Database stores the global counter.

## Static hosting

Cloudflare Pages serves `public/` at
`https://thankyouindoforthecleanair.pages.dev/`. The root `wrangler.jsonc`
configures the static Pages project. It uses Direct Upload with `main` as its
production branch and has no Pages Functions. Deployments run manually with
the approved standalone Wrangler CLI. Git pushes do not deploy this project.

Both original Firebase Hosting URLs redirect to Pages with HTTP 301 and retain
request paths. `firebase.json` uploads only the `hosting-redirect/` fallback page
to Firebase. Pages hosts the images, audio, JavaScript, and main page. Redirect
responses from the old URLs still count toward Firebase Hosting traffic. The
migration does not erase previously recorded usage.

The global counter uses the same Firebase database. The personal thank-you count
uses browser localStorage, which stores data separately for each origin. The
count starts at zero on the Pages domain. The migration does not delete existing
counts on the Firebase domains.

Personal counts are shared across tabs. Web Locks serialize storage updates,
and storage events refresh the other tabs. If browser storage or locking is
unavailable, the personal count stays in memory for the visit. The button waits for a database
connection and shows when a save is pending; keep the page open until it finishes.

Deploy from this checkout using the approved standalone executables:

```sh
export CLOUDFLARE_ACCOUNT_ID=34e1a8164bc64a89ebd693bee26d0976
export WRANGLER_WRITE_LOGS=false WRANGLER_LOG=log WRANGLER_LOG_SANITIZE=true
/private/tmp/turnstile-spin-cli/node_modules/wrangler/bin/wrangler.js pages deploy public --project-name thankyouindoforthecleanair --branch main --commit-dirty=true
/private/tmp/turnstile-spin-cli/node_modules/wrangler/bin/wrangler.js deploy --config worker/wrangler.jsonc
CI=1 NO_UPDATE_NOTIFIER=1 /private/tmp/turnstile-spin-cli/node_modules/firebase-tools/lib/bin/firebase.js deploy --only hosting --project thankyouindoforthecleanair
```

The approved CLI copies are pinned to Wrangler 4.149.0 and Firebase CLI 15.33.0.
They are outside the repository. If those temporary paths no longer exist,
prepare and approve replacement standalone paths and versions before
authenticated operations. Test Pages verification and counter access before
deploying Firebase redirects during any future domain migration.

## Turnstile and Firebase App Check

The site uses the existing Turnstile widget `0x4AAAAAAFS8y0F1moXVqQX1` as a
custom Firebase App Check provider. A Cloudflare Worker verifies each Turnstile
token with Siteverify and exchanges a signed custom token for a 30-minute
Firebase App Check token. The Firebase SDK attaches that token to database
reads and writes. This setup needs no Firebase Extensions or Blaze plan.
The SDK reuses its cached token across reads and button clicks, then refreshes
it automatically. The provider runs Turnstile when it needs a fresh token or a
visitor presses Retry.

The realtime counter connects only after verification succeeds. The thank-you
button becomes available after the initial counter value has loaded. The
Turnstile widget resets after every exchange attempt, including failures. The
provider never reuses tokens. Firebase increments the counter atomically on the
server, and the database rules still allow only increments of one. The Firebase
project enforces App Check for Realtime Database and rejects database requests
without valid App Check tokens.

### Worker configuration

`worker/wrangler.jsonc` targets `thankyouindo-app-check` in Cloudflare account
`34e1a8164bc64a89ebd693bee26d0976`. The endpoint is
`https://thankyouindo-app-check.thankyouindoforthecleanair.workers.dev/api/app-check`.
In production, the Worker accepts only these hostnames and their HTTPS origins:

- `thankyouindoforthecleanair.pages.dev`
- `thankyouindoforthecleanair.web.app`
- `thankyouindoforthecleanair.firebaseapp.com`

Tokens must have action `firebase_app_check` and `success === true`. The hostname
must be in the allowlist and match the request origin. The Worker rejects
invalid, expired, replayed, or oversized tokens. Production does not accept
localhost.

The Worker requires two encrypted secret bindings:

- `TURNSTILE_SECRET`: the existing widget's secret.
- `FIREBASE_SIGNING_KEY`: the PKCS#8 private key of
  `turnstile-app-check@thankyouindoforthecleanair.iam.gserviceaccount.com`.

The dedicated signing service account has no database or project IAM roles.
Its signing key allows it to issue App Check tokens for this project. Keep the
key in the Worker secret store. Never commit, log, or place either secret in
frontend code. The Worker does not log requests. Rotate the signing key in Google
IAM and update its Worker binding when necessary.

### Deployment and verification

Use a trusted standalone copy of Wrangler 4.109 or later outside this checkout
for authenticated deployments and secret operations. Pin its absolute path,
exact version, and account ID. Write secrets through standard-input pipes with
`WRANGLER_WRITE_LOGS=false`, `WRANGLER_LOG=log`, and
`WRANGLER_LOG_SANITIZE=true`. Do not retrieve or write secrets through `npx`,
package scripts, or a project-local executable.

1. Enable the Firebase App Check and IAM APIs in the existing Firebase project.
2. Deploy the Worker using the absolute path to `worker/wrangler.jsonc`.
3. Confirm the existing Worker target with `wrangler secret list`, then validate
   and store the existing Turnstile secret. Store the Firebase signing key only
   in the corresponding Worker secret binding.
4. Deploy the static frontend to Cloudflare Pages using the standalone Wrangler.
5. Verify a real visit succeeds and replaying its Turnstile token returns 403.
6. In Firebase Console, open Security, then App Check. Enable enforcement for
   Realtime Database. Check that verified reads and increments still succeed,
   while a database REST request without `X-Firebase-AppCheck` fails. Enforcement
   changes can take up to 15 minutes to apply.
7. After the Pages site passes verification, deploy the Firebase Hosting
   redirect configuration with the standalone Firebase CLI.

Run the tests with:

```sh
node --test worker/test/*.test.mjs
```

Test the database rules with Java 21 or later and a standalone Firebase CLI:

```sh
/private/tmp/turnstile-spin-cli/node_modules/firebase-tools/lib/bin/firebase.js emulators:exec --only database --project demo-thankyouindo 'node --test worker/test/database-rules.integration.mjs'
```

This test loads `database.rules.json` into the local emulator, checks permitted
and rejected writes, and verifies concurrent server increments. It uses a demo
database and no production credentials or extra test dependencies.

Production checks on the Pages domain on October 10, 2026 confirmed these HTTP
responses:

- A fresh Turnstile exchange returned 200.
- Replaying the token returned 403.
- A verified database read returned 200.
- An unverified database read returned 401.

The live site's counter transaction committed after enforcement. The temporary
validation page was removed after these checks.

Both original Firebase hosts returned HTTP 301 for the main page, an image,
and the App Check helper script. The redirects preserved paths and query strings.
All 17 static site files matched the Pages deployment. The 29 backend and provider
tests passed. A separate check confirmed that the button waits for a delayed
initial counter read before it becomes available.

App Check rejects requests from unverified clients. It does not limit the rate
of requests from verified clients. A verified session can use its token until it
expires. Workers remain subject to the free plan's daily request limit.

# Google Cloud Marketplace Setup

This project now supports the automatic-approval SaaS offer flow end to end at the application layer.

## What the app supports

- Ingests Cloud Marketplace Pub/Sub push messages at `/.netlify/functions/marketplace-pubsub`
- Parses `ENTITLEMENT_OFFER_ACCEPTED`
- Stores `newPendingOfferDuration`, `newOfferStartTime`, and `newOfferEndTime`
- Shows when an offer will become active
- Tracks customer account approval state
- Auto-rejects offers that pass the scheduled start time without approval
- Exposes a customer account approval endpoint at `/.netlify/functions/marketplace-account-approval`

## Google-side configuration you still need later

Set these environment variables in Netlify when you are ready to connect to Google:

- `GOOGLE_SERVICE_ACCOUNT_JSON`
- `GOOGLE_MARKETPLACE_PROVIDER_ID`
- Optional: `PUBSUB_REQUIRE_AUTH=1`
- Optional: `PUBSUB_PUSH_AUDIENCE`
- Optional: `PUBSUB_PUSH_EMAIL`

Recommended Pub/Sub push endpoint:

- `https://dcpo-servicenow-gcp-bynet.netlify.app/.netlify/functions/marketplace-pubsub`

## Pub/Sub push auth

The push handler accepts a Pub/Sub OIDC Bearer token when configured. If you set:

- `PUBSUB_REQUIRE_AUTH=1`
- `PUBSUB_PUSH_AUDIENCE` to the exact push URL
- `PUBSUB_PUSH_EMAIL` to the Pub/Sub push service account email

the handler will verify the token before accepting the message.

## Approval flow

The customer account approval button uses:

- `/.netlify/functions/marketplace-account-approval`

It accepts:

- `account_id`
- optional `entitlement_id`
- optional `approval_name`
- optional `reason`

If the Google service account and provider ID are configured, the endpoint will also call the Google Marketplace API.

## Verification

Run the local checks from the repo root:

```powershell
npm test
```

That covers:

- public page health
- account approval flow
- entitlement storage and state transitions
- scheduled-start rejection handling
- browser checks for the signup and status pages

# Google Cloud Marketplace Setup

This project now supports both the automatic-approval SaaS offer flow and the manual entitlement / plan-change flow at the application layer.

## What the app supports

- Ingests Cloud Marketplace Pub/Sub push messages at `/.netlify/functions/marketplace-pubsub`
- Handles `ENTITLEMENT_CREATION_REQUESTED`, `ENTITLEMENT_OFFER_ACCEPTED`, `ENTITLEMENT_PLAN_CHANGE_REQUESTED`, `ENTITLEMENT_PLAN_CHANGED`, and `ENTITLEMENT_OFFER_ENDED`
- Parses `ENTITLEMENT_OFFER_ACCEPTED`
- Stores `newPendingOfferDuration`, `newOfferStartTime`, and `newOfferEndTime`
- Shows when an offer will become active
- Tracks customer account approval state
- Tracks entitlement approval state for non-automatic private offers
- Tracks pending plan changes and plan-change approvals
- Auto-rejects offers that pass the scheduled start time without approval
- Exposes a customer account approval endpoint at `/.netlify/functions/marketplace-account-approval`
- Exposes an entitlement approval endpoint at `/.netlify/functions/marketplace-entitlement-approval`
- Exposes a plan change approval endpoint at `/.netlify/functions/marketplace-plan-change-approval`

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

The manual entitlement approval flow uses:

- `/.netlify/functions/marketplace-entitlement-approval`

It accepts:

- `entitlement_id`
- optional `account_id`
- optional `approved_by`
- optional `reason`

The plan-change approval flow uses:

- `/.netlify/functions/marketplace-plan-change-approval`

It accepts:

- `entitlement_id`
- `pending_plan_name`
- optional `approved_by`
- optional `reason`

For the non-automatic entitlement doc flow, the expected Google-side sequence is:

1. Receive `ENTITLEMENT_CREATION_REQUESTED`.
2. Update the customer account in your system.
3. Approve the entitlement with `/.netlify/functions/marketplace-entitlement-approval` or the Partner Procurement API.
4. If the customer requests a plan change, receive `ENTITLEMENT_PLAN_CHANGE_REQUESTED`.
5. Approve the plan change with `/.netlify/functions/marketplace-plan-change-approval` or the Partner Procurement API.
6. Receive `ENTITLEMENT_PLAN_CHANGED` when the change becomes effective.
7. If the offer ends, process `ENTITLEMENT_OFFER_ENDED`.

Manual approval in Producer Portal:

- Open Producer Portal.
- Go to the Private Offers page.
- Use the offer's overflow menu.
- Choose the approval action that matches the state: approve entitlement, approve account, or approve plan change.

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

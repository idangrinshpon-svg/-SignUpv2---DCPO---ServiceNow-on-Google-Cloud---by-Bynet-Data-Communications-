# DCPO ServiceNow on Google Cloud

This repository contains the public-facing signup and login experience, approval dashboards, Marketplace simulation tools, and Netlify functions for the DCPO ServiceNow integration.

## Live Routes

- Home: `/`
- Signup: `/signup`
- Login: `/login`
- Approval dashboard: `/approval-dashboard/`
- Entitlement status: `/entitlement-status/`
- Documentation hub: `/docs/`
- User manual: `/docs/user-guide/`
- Admin manual: `/docs/admin-guide/`

## What This App Covers

- Google Cloud Marketplace signup and sign-in flows
- Automatic offer approval handling
- Manual entitlement approval handling
- Plan-change approval handling
- Pub/Sub ingress for Marketplace events
- Approval dashboard with pending-request actions
- Local simulation and regression QA

## Validation

Use the bundled QA flow:

```powershell
npm run qa:full
```

That runs the Marketplace simulator, live regression checks, and browser smoke tests.

## Deployment

The app is configured for Netlify via `netlify.toml`.

Production deploy:

```powershell
npx netlify deploy --prod --dir .
```


#!/usr/bin/env python3
"""Regression checks for the deployed Netlify app.

Run from the repository root:
    python scripts/regression_check.py

Optional:
    python scripts/regression_check.py --base-url https://example.netlify.app
"""

from __future__ import annotations

import argparse
import base64
import json
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_BASE_URL = "https://dcpo-servicenow-gcp-bynet.netlify.app"
SUSPICIOUS_TEXT = ("ג", "נ", "ײ", "׳", "ֲ", "�")


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


OPENER = urllib.request.build_opener(NoRedirectHandler)


@dataclass
class Response:
    status: int
    headers: dict[str, str]
    body: str


class LinkCollector(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.hrefs: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag != "a":
            return
        attr_map = dict(attrs)
        href = attr_map.get("href")
        if href:
            self.hrefs.append(href)


def request(
    method: str,
    url: str,
    *,
    headers: dict[str, str] | None = None,
    form_data: dict[str, str] | None = None,
    json_body: object | None = None,
) -> Response:
    data = None
    req_headers = dict(headers or {})
    if json_body is not None:
        data = json.dumps(json_body).encode("utf-8")
        req_headers.setdefault("Content-Type", "application/json")
    elif form_data is not None:
        data = urllib.parse.urlencode(form_data).encode("utf-8")
        req_headers.setdefault("Content-Type", "application/x-www-form-urlencoded")

    req = urllib.request.Request(url, data=data, headers=req_headers, method=method)
    try:
        with OPENER.open(req, timeout=20) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            return Response(resp.status, dict(resp.headers.items()), body)
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        return Response(exc.code, dict(exc.headers.items()), body)


def expect_ok_or_trailing_slash_redirect(
    response: Response,
    path: str,
    label: str,
    failures: list[str],
) -> None:
    location = response.headers.get("Location")
    ok = response.status == 200 or (
        response.status in {301, 302, 307, 308} and location in {f"{path}/", f"{path}/"}
    )
    expect(
        ok,
        label,
        f"got status={response.status}, location={location!r}",
        failures,
    )


def make_expired_jwt() -> str:
    header = {"alg": "none", "typ": "JWT"}
    payload = {
        "aud": "dcpo-servicenow-gcp-bynet.netlify.app",
        "exp": 1,
        "google": {"user_identity": "demo-uid"},
        "iss": "https://www.googleapis.com/robot/v1/metadata/x509/cloud-commerce-partner@system.gserviceaccount.com",
        "sub": "demo-account",
    }

    # Build true base64url payloads without needing external deps.
    import base64

    def b64url(obj: dict[str, object]) -> str:
        raw = json.dumps(obj, separators=(",", ":")).encode("utf-8")
        return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")

    return f"{b64url(header)}.{b64url(payload)}.sig"


def make_future_iso(days: int) -> str:
    dt = datetime.now(timezone.utc) + timedelta(days=days)
    return dt.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def make_sample_entitlement(entitlement_id: str) -> dict[str, object]:
    start = make_future_iso(7)
    end = make_future_iso(37)
    return {
        "eventId": "evt-demo-1",
        "eventType": "ENTITLEMENT_OFFER_ACCEPTED",
        "entitlement": {
            "id": entitlement_id,
            "updateTime": make_future_iso(0),
            "newPendingOfferDuration": "P30D",
            "newOfferStartTime": start,
            "newOfferEndTime": end,
        },
    }


def make_past_entitlement(entitlement_id: str) -> dict[str, object]:
    start = make_future_iso(-7)
    end = make_future_iso(23)
    return {
        "eventId": "evt-demo-2",
        "eventType": "ENTITLEMENT_OFFER_ACCEPTED",
        "entitlement": {
            "id": entitlement_id,
            "updateTime": make_future_iso(0),
            "newPendingOfferDuration": "P30D",
            "newOfferStartTime": start,
            "newOfferEndTime": end,
        },
    }


def make_pubsub_envelope(payload: dict[str, object]) -> dict[str, object]:
    raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    return {
        "message": {
            "data": base64.b64encode(raw).decode("ascii"),
            "messageId": "demo-message-1",
            "publishTime": make_future_iso(0),
        },
        "subscription": "projects/demo/subscriptions/marketplace-entitlements",
    }


def expect(condition: bool, label: str, detail: str, failures: list[str]) -> None:
    if condition:
        print(f"[PASS] {label}")
    else:
        print(f"[FAIL] {label}: {detail}")
        failures.append(f"{label}: {detail}")


def require_headers(
    response: Response,
    expected: Iterable[str],
    label: str,
    failures: list[str],
) -> None:
    headers = {k.lower(): v for k, v in response.headers.items()}
    missing = [name for name in expected if name.lower() not in headers]
    expect(not missing, label, f"missing headers: {', '.join(missing)}", failures)


def check_for_suspicious_text(body: str, label: str, failures: list[str]) -> None:
    found = sorted({token for token in SUSPICIOUS_TEXT if token in body})
    expect(not found, label, f"found suspicious mojibake markers: {', '.join(found)}", failures)


def run_live_checks(base_url: str, failures: list[str]) -> None:
    expired = make_expired_jwt()

    root = request("GET", f"{base_url}/")
    expect(root.status == 200, "GET / returns 200", f"got {root.status}", failures)
    require_headers(
        root,
        [
            "Content-Security-Policy",
            "Permissions-Policy",
            "Referrer-Policy",
            "Strict-Transport-Security",
            "X-Content-Type-Options",
            "X-Frame-Options",
        ],
        "GET / includes core security headers",
        failures,
    )

    signup = request("GET", f"{base_url}/signup")
    expect(signup.status == 200, "GET /signup returns 200", f"got {signup.status}", failures)
    expect(
        signup.headers.get("Cache-Control") == "no-store",
        "GET /signup disables caching",
        f"got Cache-Control={signup.headers.get('Cache-Control')!r}",
        failures,
    )
    check_for_suspicious_text(signup.body, "GET /signup has no mojibake text", failures)

    login = request("GET", f"{base_url}/login")
    expect(login.status == 200, "GET /login returns 200", f"got {login.status}", failures)
    expect(
        login.headers.get("Cache-Control") == "no-store",
        "GET /login disables caching",
        f"got Cache-Control={login.headers.get('Cache-Control')!r}",
        failures,
    )
    check_for_suspicious_text(login.body, "GET /login has no mojibake text", failures)

    signup_missing = request("POST", f"{base_url}/signup")
    expect(
        signup_missing.status == 303 and signup_missing.headers.get("Location") == "/signup.html?error=missing_token",
        "POST /signup without token redirects to missing_token",
        f"got status={signup_missing.status}, location={signup_missing.headers.get('Location')!r}",
        failures,
    )

    login_missing = request("POST", f"{base_url}/login")
    expect(
        login_missing.status == 303 and login_missing.headers.get("Location") == "/login.html?error=missing_token",
        "POST /login without token redirects to missing_token",
        f"got status={login_missing.status}, location={login_missing.headers.get('Location')!r}",
        failures,
    )

    signup_expired = request(
        "POST",
        f"{base_url}/signup",
        form_data={"demo": "1", "x-gcp-marketplace-token": expired},
    )
    expect(
        signup_expired.status == 303 and signup_expired.headers.get("Location") == "/signup.html?error=token_expired",
        "POST /signup with expired token redirects to token_expired",
        f"got status={signup_expired.status}, location={signup_expired.headers.get('Location')!r}",
        failures,
    )

    login_expired = request(
        "POST",
        f"{base_url}/login",
        form_data={"demo": "1", "x-gcp-marketplace-token": expired},
    )
    expect(
        login_expired.status == 303 and login_expired.headers.get("Location") == "/login.html?error=token_expired",
        "POST /login with expired token redirects to token_expired",
        f"got status={login_expired.status}, location={login_expired.headers.get('Location')!r}",
        failures,
    )

    signup_fn = request("GET", f"{base_url}/.netlify/functions/gcp-signup")
    expect(
        signup_fn.status == 405,
        "GET /.netlify/functions/gcp-signup returns 405",
        f"got {signup_fn.status}",
        failures,
    )

    login_fn = request("GET", f"{base_url}/.netlify/functions/gcp-login")
    expect(
        login_fn.status == 405,
        "GET /.netlify/functions/gcp-login returns 405",
        f"got {login_fn.status}",
        failures,
    )

    login_error_page = request("GET", f"{base_url}/login.html?error=token_expired")
    expect(
        "The marketplace session expired" in login_error_page.body and "err-bar" in login_error_page.body,
        "login error page includes expired-session UX",
        "missing expected login error copy or banner markup",
        failures,
    )

    signup_error_page = request("GET", f"{base_url}/signup.html?error=token_expired")
    expect(
        "The marketplace session has expired" in signup_error_page.body,
        "signup error page includes expired-session UX",
        "missing expected signup error copy",
        failures,
    )

    privacy = request("GET", f"{base_url}/privacy")
    expect_ok_or_trailing_slash_redirect(privacy, "/privacy", "GET /privacy resolves correctly", failures)

    terms = request("GET", f"{base_url}/terms")
    expect_ok_or_trailing_slash_redirect(terms, "/terms", "GET /terms resolves correctly", failures)

    contact = request("GET", f"{base_url}/contact")
    expect_ok_or_trailing_slash_redirect(contact, "/contact", "GET /contact resolves correctly", failures)

    marketplace = request("GET", f"{base_url}/marketplace")
    expect_ok_or_trailing_slash_redirect(marketplace, "/marketplace", "GET /marketplace resolves correctly", failures)

    instance_help = request("GET", f"{base_url}/instance-help")
    expect_ok_or_trailing_slash_redirect(instance_help, "/instance-help", "GET /instance-help resolves correctly", failures)

    access_help = request("GET", f"{base_url}/access-help")
    expect_ok_or_trailing_slash_redirect(access_help, "/access-help", "GET /access-help resolves correctly", failures)

    signup_links = LinkCollector()
    signup_links.feed(signup.body)
    expect(
        "login.html" in signup_links.hrefs or "/login" in signup_links.hrefs,
        "signup page keeps a path to sign in",
        f"found links: {signup_links.hrefs!r}",
        failures,
    )

    login_links = LinkCollector()
    login_links.feed(login.body)
    expect(
        "signup.html" in login_links.hrefs or "/signup" in login_links.hrefs,
        "login page keeps a path to register",
        f"found links: {login_links.hrefs!r}",
        failures,
    )
    expect(
        "/privacy" in login_links.hrefs and "/terms" in login_links.hrefs and "/contact" in login_links.hrefs,
        "login page footer links point to internal subpages",
        f"found links: {login_links.hrefs!r}",
        failures,
    )
    expect(
        "/marketplace" in login_links.hrefs and "/instance-help" in login_links.hrefs,
        "login page support links point to internal subpages",
        f"found links: {login_links.hrefs!r}",
        failures,
    )
    expect(
        "/privacy" in signup_links.hrefs and "/terms" in signup_links.hrefs and "/contact" in signup_links.hrefs,
        "signup page footer links point to internal subpages",
        f"found links: {signup_links.hrefs!r}",
        failures,
    )

    access_help_page = request(
        "GET",
        f"{base_url}/access-help/?instance=acme&target=https%3A%2F%2Facme.service-now.com%2Flogin.do",
    )
    expect(
        "Complete Access With Your Service Provider" in access_help_page.body and "Requested Instance" in access_help_page.body,
        "access-help page renders provider guidance shell",
        "missing expected access-help heading or summary placeholders",
        failures,
    )

    entitlement_id = "demo-entitlement-support"
    entitlement_event = make_sample_entitlement(entitlement_id)
    entitlement_seed = request(
        "POST",
        f"{base_url}/.netlify/functions/marketplace-pubsub",
        json_body=make_pubsub_envelope(entitlement_event),
    )
    expect(
        entitlement_seed.status == 202,
        "POST marketplace-pubsub stores accepted offer",
        f"got status={entitlement_seed.status}, body={entitlement_seed.body!r}",
        failures,
    )

    entitlement_record = request(
        "GET",
        f"{base_url}/.netlify/functions/marketplace-entitlements?entitlement_id={entitlement_id}",
    )
    expect(
        entitlement_record.status == 200 and entitlement_id in entitlement_record.body and "scheduled" in entitlement_record.body,
        "GET marketplace-entitlements returns stored entitlement record",
        f"got status={entitlement_record.status}, body={entitlement_record.body!r}",
        failures,
    )

    approval_response = request(
        "POST",
        f"{base_url}/.netlify/functions/marketplace-entitlement-approval",
        json_body={"entitlement_id": entitlement_id, "approved_by": "regression-check"},
    )
    expect(
        approval_response.status == 200 and '"approvalStatus":"approved"' in approval_response.body,
        "POST marketplace-entitlement-approval approves the stored offer",
        f"got status={approval_response.status}, body={approval_response.body!r}",
        failures,
    )

    approved_record = request(
        "GET",
        f"{base_url}/.netlify/functions/marketplace-entitlements?entitlement_id={entitlement_id}",
    )
    expect(
        approved_record.status == 200,
        "GET marketplace-entitlements remains reachable after approval",
        f"got status={approved_record.status}, body={approved_record.body!r}",
        failures,
    )

    rejected_id = "demo-entitlement-rejected"
    rejected_seed = request(
        "POST",
        f"{base_url}/.netlify/functions/marketplace-entitlements",
        json_body=make_pubsub_envelope(make_past_entitlement(rejected_id)),
    )
    expect(
        rejected_seed.status == 202,
        "POST marketplace-pubsub auto-rejects past-start offers",
        f"got status={rejected_seed.status}, body={rejected_seed.body!r}",
        failures,
    )

    rejected_record = request(
        "GET",
        f"{base_url}/.netlify/functions/marketplace-entitlements?entitlement_id={rejected_id}",
    )
    expect(
        rejected_record.status == 200 and '"status":"rejected"' in rejected_record.body and '"approvalStatus":"rejected"' in rejected_record.body,
        "GET marketplace-entitlements reflects auto-rejected offers",
        f"got status={rejected_record.status}, body={rejected_record.body!r}",
        failures,
    )

    reconcile = request("GET", f"{base_url}/.netlify/functions/marketplace-entitlements-reconcile")
    expect(
        reconcile.status == 200 and '"ok":true' in reconcile.body,
        "GET marketplace-entitlements-reconcile runs successfully",
        f"got status={reconcile.status}, body={reconcile.body!r}",
        failures,
    )

    entitlement_page = request(
        "GET",
        f"{base_url}/entitlement-status/?entitlement_id={entitlement_id}",
    )
    expect_ok_or_trailing_slash_redirect(entitlement_page, "/entitlement-status", "GET /entitlement-status resolves correctly", failures)
    expect(
        "Approve Customer Account" in entitlement_page.body and "Approval Status" in entitlement_page.body,
        "entitlement status page exposes approval controls and state",
        "missing approval control markup",
        failures,
    )


def run_local_checks(failures: list[str]) -> None:
    node_cmd = [
        "node",
        "-e",
        (
            "require('./netlify/functions/gcp-login.js');"
            "require('./netlify/functions/gcp-signup.js');"
            "require('./netlify/functions/marketplace-entitlements.js');"
            "require('./netlify/functions/marketplace-pubsub.js');"
            "require('./netlify/functions/marketplace-entitlement-approval.js');"
            "require('./netlify/functions/marketplace-entitlements-reconcile.js');"
            "console.log('syntax_ok');"
        ),
    ]
    try:
        completed = subprocess.run(
            node_cmd,
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
            timeout=20,
        )
    except FileNotFoundError:
        failures.append("Local Node.js check: node executable not found")
        print("[FAIL] Local Node.js check: node executable not found")
        return

    expect(
        completed.returncode == 0 and "syntax_ok" in completed.stdout,
        "Local Netlify function syntax check passes",
        (completed.stderr or completed.stdout).strip() or f"exit code {completed.returncode}",
        failures,
    )

    for relative_path in ("login.html", "signup.html"):
        file_path = ROOT / relative_path
        body = file_path.read_text(encoding="utf-8")
        check_for_suspicious_text(body, f"Local {relative_path} has no mojibake text", failures)


def main() -> int:
    parser = argparse.ArgumentParser(description="Run live regression checks for the Netlify app.")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL, help="Base URL to test")
    args = parser.parse_args()

    failures: list[str] = []
    print(f"Testing {args.base_url}")
    run_live_checks(args.base_url.rstrip("/"), failures)
    run_local_checks(failures)

    if failures:
        print(f"\n{len(failures)} check(s) failed.")
        for failure in failures:
            print(f"- {failure}")
        return 1

    print("\nAll regression checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

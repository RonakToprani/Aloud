#!/usr/bin/env python3
"""Cold outreach, one personalised email per organisation, scheduled through
Resend so it goes out at a civilised hour without a machine staying awake.

    python3 scripts/send-outreach.py emails/outreach.json                 # dry run
    python3 scripts/send-outreach.py emails/outreach.json --at 2026-09-14T13:00:00Z --stagger-minutes 5
    python3 scripts/send-outreach.py emails/outreach.json --cancel       # before it fires

Each entry: {"to", "greeting", "subject", "why"} and optionally "ask", where
`why` is the one sentence that says why this organisation in particular.
Everything else is shared. Resend ids go to a ledger beside the batch so a
scheduled send can be cancelled, and so a re-run never queues anyone twice.

What keeps this in Gmail's Primary tab rather than Promotions, learned the
hard way: one text colour throughout, no table layout, no List-Unsubscribe
header (a bulk-mail signal; the "reply with stop" line satisfies the law on
its own), and as few links as possible. The small logo in the signature is
the one remaining risk, kept because it reads as a person with a company.
"""
import argparse, json, pathlib, re, sys, time, urllib.request
from datetime import datetime, timedelta

FROM = "Ronak at Aloud <hello@send.aloudreader.org>"
SITE = "https://www.aloudreader.org"
LOGO = f"{SITE}/email/logo.png"
SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif"
INK = "#1f2933"
DEFAULT_ASK = "Would you try it with two or three of your learners and tell me what's missing?"


def from_env(name: str, required: bool = True) -> str | None:
    m = re.search(rf"^{name}=(.+)$", pathlib.Path(".env.local").read_text(), re.M)
    if not m and required:
        sys.exit(f"{name} is not in .env.local")
    return m.group(1).strip() if m else None


def signature_lines() -> list[str]:
    lines = ["Ronak Toprani", "Building Aloud in Toronto"]
    if phone := from_env("PHONE", required=False):
        lines.append(phone)
    return lines


def text_of(e: dict) -> str:
    sig = "\n".join(signature_lines() + [SITE.replace("https://www.", "")])
    if li := from_env("LINKEDIN_URL", required=False):
        sig += "\n" + li.replace("https://www.", "")
    return f"""{e['greeting']}

I'm Ronak, and I'm building Aloud: a reader that reads any book aloud and lights up each word as it's spoken. Readers bring their own EPUB or PDF, or pick from nearly 3,000 classics, and the text never leaves their device. It's free, and it's available right now.

{e['why']}

{e.get('ask', DEFAULT_ASK)} It's at {SITE}, with nothing to install and no sign-up needed. I'd love to hear any feedback, even a short point.

Thank you,

{sig}

If you'd rather not hear from me again, reply with the word stop.
"""


def html_of(e: dict) -> str:
    p = lambda t, b=18, s=15: f'<p style="margin:0 0 {b}px;font:400 {s}px/1.6 {SANS};color:{INK}">{t}</p>'
    links = f'<a href="{SITE}" style="color:#5b7fa6">aloudreader.org</a>'
    if li := from_env("LINKEDIN_URL", required=False):
        links += f' &nbsp;·&nbsp; <a href="{li}" style="color:#5b7fa6">LinkedIn</a>'
    sig = "<br>".join(signature_lines()) + "<br>" + links
    return (
        f'<div style="max-width:520px;font-family:{SANS}">'
        + p(e["greeting"])
        + p("I’m Ronak, and I’m building Aloud: a reader that reads any book aloud and lights up each word as it’s spoken. Readers bring their own EPUB or PDF, or pick from nearly 3,000 classics, and the text never leaves their device. It’s free, and it’s available right now.")
        + p(e["why"])
        + p(f'{e.get("ask", DEFAULT_ASK)} It’s at <a href="{SITE}" style="color:#5b7fa6">aloudreader.org</a>, with nothing to install and no sign-up needed. I’d love to hear any feedback, even a short point.')
        + p("Thank you,", 14)
        + f'<img src="{LOGO}" alt="Aloud" width="80" height="26" style="display:block;border:0;width:80px;height:26px;margin:0 0 8px">'
        + p(sig, 22, 14)
        + p("If you’d rather not hear from me again, reply with the word stop.", 0, 13)
        + "</div>"
    )


def api(path: str, body: dict | None, key: str) -> dict:
    req = urllib.request.Request(
        "https://api.resend.com" + path,
        data=json.dumps(body).encode() if body is not None else None,
        method="POST",
        # Cloudflare in front of Resend rejects Python's default user agent with
        # a bare "error code: 1010", which looks like a key problem and is not.
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json",
                 "User-Agent": "aloud-outreach/1.0"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as err:
        return {"error": err.code, "body": err.read().decode()[:300]}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("batch")
    ap.add_argument("--at", help="ISO 8601 UTC time to send, e.g. 2026-09-14T13:00:00Z")
    ap.add_argument("--stagger-minutes", type=float, default=0,
                    help="space successive sends out, so a morning's outreach does not land as one burst")
    ap.add_argument("--now", action="store_true", help="send immediately")
    ap.add_argument("--cancel", action="store_true", help="cancel everything in the ledger")
    a = ap.parse_args()

    batch_path = pathlib.Path(a.batch)
    entries = json.loads(batch_path.read_text())
    ledger = batch_path.with_suffix(".sent.txt")
    key = from_env("RESEND_SMTP_PASSWORD")
    reply_to = from_env("ANNOUNCE_REPLY_TO")

    if a.cancel:
        if not ledger.exists():
            sys.exit("nothing in the ledger to cancel")
        for line in ledger.read_text().splitlines():
            to, _, msg_id = line.partition("\t")
            r = api(f"/emails/{msg_id}/cancel", None, key)
            print("  cancel", to, "->", "ok" if "id" in r else r)
        return

    done = {l.split("\t")[0].lower() for l in ledger.read_text().splitlines()} if ledger.exists() else set()
    pending = [e for e in entries if e["to"].lower() not in done]
    print(f"{len(entries)} in batch, {len(entries) - len(pending)} already queued, {len(pending)} to go")
    for e in pending:
        print(f"   {e['to']:<44} {e['subject']}")
    if not (a.at or a.now):
        print("\nDRY RUN. Add --at <iso time> to schedule, or --now.")
        return

    start = datetime.strptime(a.at, "%Y-%m-%dT%H:%M:%SZ") if a.at else None
    for i, e in enumerate(pending):
        body = {
            "from": FROM, "to": [e["to"]], "reply_to": reply_to,
            "subject": e["subject"], "text": text_of(e), "html": html_of(e),
        }
        if start:
            body["scheduled_at"] = (start + timedelta(minutes=a.stagger_minutes * i)).strftime("%Y-%m-%dT%H:%M:%SZ")
        r = api("/emails", body, key)
        if "id" in r:
            with ledger.open("a") as f:
                f.write(f"{e['to']}\t{r['id']}\n")
            print("  queued", body.get("scheduled_at", "now"), e["to"])
        else:
            print("  FAILED", e["to"], r)
        time.sleep(0.6)  # Resend allows two requests a second
    print(f"\nledger: {ledger}")


if __name__ == "__main__":
    main()

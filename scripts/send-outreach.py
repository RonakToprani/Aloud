#!/usr/bin/env python3
"""Cold outreach, one personalised email per organisation, scheduled through
Resend so it goes out at a civilised hour without a machine staying awake.

    python3 scripts/send-outreach.py emails/outreach.json                 # dry run
    python3 scripts/send-outreach.py emails/outreach.json --at 2026-09-14T13:00:00Z
    python3 scripts/send-outreach.py emails/outreach.json --cancel       # before it fires

Each entry: {"to", "greeting", "subject", "why"} where `why` is the one
sentence that says why this organisation in particular. Everything else is
shared. Resend ids are written to a ledger beside the batch so a scheduled
send can be cancelled, and so a re-run never queues anyone twice.
"""
import argparse, json, pathlib, re, sys, time, urllib.request

FROM = "Ronak at Aloud <hello@send.aloudreader.org>"
SITE = "https://www.aloudreader.org"
LOGO = f"{SITE}/email/logo.png"
SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif"


def from_env(name: str) -> str:
    m = re.search(rf"^{name}=(.+)$", pathlib.Path(".env.local").read_text(), re.M)
    if not m:
        sys.exit(f"{name} is not in .env.local")
    return m.group(1).strip()


# Early access, not a free tool. "Free while I build it" is true, and it tells
# them without saying so that it will not always be. The ask is a conversation
# with a few learners, never "pass it on": a forward makes it a free resource
# on someone's list, a reply makes them a design partner.
DEFAULT_ASK = "Would you try it with two or three of your learners and tell me what's missing?"


def text_of(e: dict) -> str:
    ask = e.get("ask", DEFAULT_ASK)
    return f"""{e['greeting']}

I'm Ronak, and I'm building Aloud: a reader that reads any book aloud and lights up each word as it's spoken. Readers bring their own EPUB or PDF, or pick from nearly 3,000 classics, and the text never leaves their device. It's free while I build it.

{e['why']}

{ask} It's at {SITE}, with nothing to install and no sign-up needed. One honest sentence in reply would help me more than anything.

Thank you,
Ronak
Aloud, Toronto

If you'd rather not hear from me again, reply with the word stop.
"""


def html_of(e: dict) -> str:
    p = lambda t, c="#52606d", s=15, b=18: f'<p style="margin:0 0 {b}px;font:400 {s}px/1.6 {SANS};color:{c}">{t}</p>'
    return (
        f'<div style="max-width:480px;margin:0 auto;padding:22px 20px;background:#fff;font-family:{SANS}">'
        f'<img src="{LOGO}" alt="Aloud" width="98" height="32" style="display:block;border:0;width:98px;height:32px;margin:0 0 22px">'
        + p(e["greeting"], "#1f2933")
        + p("I’m Ronak, and I’m building Aloud: a reader that reads any book aloud and lights up each word as it’s spoken. Readers bring their own EPUB or PDF, or pick from nearly 3,000 classics, and the text never leaves their device. It’s free while I build it.")
        + p(e["why"])
        + p(f'{e.get("ask", DEFAULT_ASK)} It’s at <a href="{SITE}" style="color:#5b7fa6">aloudreader.org</a>, with nothing to install and no sign-up needed. One honest sentence in reply would help me more than anything.')
        + p("Thank you,<br>Ronak<br>Aloud, Toronto", "#1f2933", b=22)
        + p("If you’d rather not hear from me again, reply with the word stop.", "#7b8794", 12, 0)
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
                    help="space successive sends out by this many minutes, so a morning's outreach does not land as one burst")
    ap.add_argument("--now", action="store_true", help="send immediately")
    ap.add_argument("--cancel", action="store_true", help="cancel everything in the ledger")
    a = ap.parse_args()

    batch_path = pathlib.Path(a.batch)
    entries = json.loads(batch_path.read_text())
    ledger = batch_path.with_suffix(".sent.txt")
    key = from_env("RESEND_SMTP_PASSWORD")
    reply_to = from_env("ANNOUNCE_REPLY_TO")
    unsubscribe = reply_to.split("<")[-1].rstrip(">")

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

    from datetime import datetime, timedelta
    start = datetime.strptime(a.at, "%Y-%m-%dT%H:%M:%SZ") if a.at else None
    for i, e in enumerate(pending):
        body = {
            "from": FROM, "to": [e["to"]], "reply_to": reply_to,
            "subject": e["subject"], "text": text_of(e), "html": html_of(e),
            "headers": {"List-Unsubscribe": f"<mailto:{unsubscribe}?subject=unsubscribe>"},
        }
        if start:
            when = start + timedelta(minutes=a.stagger_minutes * i)
            body["scheduled_at"] = when.strftime("%Y-%m-%dT%H:%M:%SZ")
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

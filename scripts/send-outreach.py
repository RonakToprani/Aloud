#!/usr/bin/env python3
"""Cold outreach, one personalised email per organisation, scheduled through
Resend so it goes out at a civilised hour without a machine staying awake.

    python3 scripts/send-outreach.py emails/outreach.json                 # dry run
    python3 scripts/send-outreach.py emails/outreach.json --at 2026-09-14T13:00:00Z --stagger-minutes 5
    python3 scripts/send-outreach.py emails/outreach.json --cancel       # before it fires

Each entry: {"to", "greeting", "subject", "why"} and optionally "ask" and
"intro", where `why` is the one sentence that says why this organisation in
particular. `intro` replaces the opening paragraph, which is written for
literacy and language programmes; a batch to accessibility offices talks
about course readings instead. Everything else is shared. Resend ids go to a ledger beside the batch so a
scheduled send can be cancelled, and so a re-run never queues anyone twice.

What keeps this in Gmail's Primary tab rather than Promotions, learned the
hard way: one text colour throughout, no table layout, no List-Unsubscribe
header, a bulk-mail signal, and as few links as possible. The signature is
the one table: the logo beside the name, the way a mail client lays one out.
There is no unsubscribe line, by the owner's choice; anti-spam law asks for
one, and the fallback is that every reply reaches a person who will act on it.
"""
import argparse, json, pathlib, re, sys, time, urllib.request
from datetime import datetime, timedelta

FROM = "Ronak at Aloud <hello@send.aloudreader.org>"
SITE = "https://www.aloudreader.org"
LOGO = f"{SITE}/email/logo.png"
SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif"
INK = "#1f2933"
DEFAULT_ASK = "Would you try it with two or three of your learners and tell me what's missing?"
DEFAULT_INTRO = ("I'm Ronak, and I'm building Aloud: a reader that reads any book aloud and lights up each word as it's spoken. "
                 "Readers bring their own EPUB or PDF, or pick from nearly 3,000 classics, and the text never leaves their device. "
                 "It's free, and it's available right now.")


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


def curly(t: str) -> str:
    return t.replace("'", "\u2019")


def text_of(e: dict) -> str:
    sig = "\n".join(signature_lines() + [SITE.replace("https://www.", "")])
    if li := from_env("LINKEDIN_URL", required=False):
        sig += "\n" + li.replace("https://www.", "")
    return f"""{e['greeting']}

{e.get('intro', DEFAULT_INTRO)}

{e['why']}

{e.get('ask', DEFAULT_ASK)} It's at {SITE}, with nothing to install and no sign-up needed. I'd love to hear any feedback, even a short point.

Thank you,

{sig}
"""


def html_of(e: dict) -> str:
    p = lambda t, b=18, s=15: f'<p style="margin:0 0 {b}px;font:400 {s}px/1.6 {SANS};color:{INK}">{t}</p>'
    links = f'<a href="{SITE}" style="color:#5b7fa6">aloudreader.org</a>'
    if li := from_env("LINKEDIN_URL", required=False):
        links += f' &nbsp;·&nbsp; <a href="{li}" style="color:#5b7fa6">LinkedIn</a>'
    sig = f'<span style="font-weight:600">{signature_lines()[0]}</span><br>' + "<br>".join(signature_lines()[1:]) + "<br>" + links
    return (
        f'<div style="max-width:520px;font-family:{SANS}">'
        + p(e["greeting"])
        + p(curly(e.get("intro", DEFAULT_INTRO)))
        + p(e["why"])
        + p(f'{e.get("ask", DEFAULT_ASK)} It’s at <a href="{SITE}" style="color:#5b7fa6">aloudreader.org</a>, with nothing to install and no sign-up needed. I’d love to hear any feedback, even a short point.')
        + p("Thank you,", 12)
        # The one table in the email: the logo beside the name, the way a
        # signature block looks in a mail client. Nothing else is laid out.
        + f'<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0"><tr>'
        f'<td style="padding:0 14px 0 0;vertical-align:middle"><img src="{LOGO}" alt="Aloud" width="80" height="26" style="display:block;border:0;width:80px;height:26px"></td>'
        f'<td style="vertical-align:middle;font:400 14px/1.5 {SANS};color:{INK}">{sig}</td>'
        f'</tr></table>'
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

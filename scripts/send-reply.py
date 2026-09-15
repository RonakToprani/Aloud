#!/usr/bin/env python3
"""Reply to people who wrote back, from the Aloud mailbox, inside their thread.

    python3 scripts/send-reply.py emails/replies.json                     # dry run
    python3 scripts/send-reply.py emails/replies.json --copy you@x.com    # every reply to you instead, now
    python3 scripts/send-reply.py emails/replies.json --at 2026-09-15T13:00:00Z
    python3 scripts/send-reply.py emails/replies.json --cancel

Each entry: {"to", "subject", "in_reply_to", "references", "body", "quote"}.
`in_reply_to` is the Message-ID of the mail being answered and `references`
the chain so far (Gmail shows both under "Show original"); with those set a
reply lands in the recipient's existing thread in every client. `quote` is
their message, appended under an "On ... wrote:" line the way a mail client
does it. Plain text only: this is a person answering a person.
"""
import argparse, json, pathlib, re, sys, time, urllib.request
from datetime import datetime, timedelta

FROM = "Ronak at Aloud <hello@send.aloudreader.org>"

import importlib.util as _ilu
_spec = _ilu.spec_from_file_location("outreach", pathlib.Path(__file__).with_name("send-outreach.py"))
outreach = _ilu.module_from_spec(_spec); _spec.loader.exec_module(outreach)


def from_env(name: str) -> str:
    m = re.search(rf"^{name}=(.+)$", pathlib.Path(".env.local").read_text(), re.M)
    if not m:
        sys.exit(f"{name} is not in .env.local")
    return m.group(1).strip()


def api(path: str, body: dict | None, key: str) -> dict:
    req = urllib.request.Request(
        "https://api.resend.com" + path,
        data=json.dumps(body).encode() if body is not None else None, method="POST",
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json",
                 "User-Agent": "aloud-outreach/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as err:
        return {"error": err.code, "body": err.read().decode()[:300]}


def text_of(e: dict) -> str:
    # The body ends on its sign-off line; the same signature as the outreach
    # goes under it, so a reply looks like the mail it answers.
    sig = "\n".join(outreach.signature_lines() + [outreach.SITE.replace("https://www.", "")])
    if li := outreach.from_env("LINKEDIN_URL", required=False):
        sig += "\n" + li.replace("https://www.", "")
    text = e["body"].rstrip() + "\n\n" + sig + "\n"
    if q := e.get("quote"):
        quoted = "\n".join("> " + line for line in q["text"].strip().splitlines())
        text += f"\n{q['from_line']}\n{quoted}\n"
    return text


def html_of(e: dict) -> str:
    SANS, INK, LOGO, SITE = outreach.SANS, outreach.INK, outreach.LOGO, outreach.SITE
    p = lambda t, b=18, s=15: f'<p style="margin:0 0 {b}px;font:400 {s}px/1.6 {SANS};color:{INK}">{t}</p>'
    paras = [x.strip() for x in e["body"].strip().split("\n\n")]
    links = f'<a href="{SITE}" style="color:#5b7fa6">aloudreader.org</a>'
    if li := outreach.from_env("LINKEDIN_URL", required=False):
        links += f' &nbsp;·&nbsp; <a href="{li}" style="color:#5b7fa6">LinkedIn</a>'
    lines = outreach.signature_lines()
    sig = f'<span style="font-weight:600">{lines[0]}</span><br>' + "<br>".join(lines[1:]) + "<br>" + links
    out = f'<div style="max-width:520px;font-family:{SANS}">'
    out += "".join(p(x.replace("\n", "<br>")) for x in paras[:-1]) + p(paras[-1], 12)
    out += (f'<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 22px"><tr>'
            f'<td style="padding:0 14px 0 0;vertical-align:middle"><img src="{LOGO}" alt="Aloud" width="80" height="26" style="display:block;border:0;width:80px;height:26px"></td>'
            f'<td style="vertical-align:middle;font:400 14px/1.5 {SANS};color:{INK}">{sig}</td></tr></table>')
    if q := e.get("quote"):
        quoted = q["text"].strip().replace("\n", "<br>")
        out += (f'<div style="font:400 13px/1.5 {SANS};color:#5f6b7a;margin:0 0 6px">{q["from_line"]}</div>'
                f'<blockquote style="margin:0 0 0 8px;padding-left:12px;border-left:2px solid #d5dbe1;font:400 14px/1.6 {SANS};color:#5f6b7a">{quoted}</blockquote>')
    return out + "</div>"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("batch")
    ap.add_argument("--at")
    ap.add_argument("--stagger-minutes", type=float, default=3)
    ap.add_argument("--now", action="store_true")
    ap.add_argument("--copy", help="send every reply to this address instead, immediately, for review")
    ap.add_argument("--cancel", action="store_true")
    a = ap.parse_args()

    batch = pathlib.Path(a.batch)
    entries = json.loads(batch.read_text())
    ledger = batch.with_suffix(".sent.txt")
    key, reply_to = from_env("RESEND_SMTP_PASSWORD"), from_env("ANNOUNCE_REPLY_TO")

    if a.cancel:
        for line in ledger.read_text().splitlines() if ledger.exists() else []:
            to, _, mid = line.partition("\t")
            print("  cancel", to, "->", "ok" if "id" in api(f"/emails/{mid}/cancel", None, key) else "failed")
        return

    if a.copy:
        for e in entries:
            r = api("/emails", {"from": FROM, "to": [a.copy], "reply_to": reply_to,
                                "subject": f"[copy to {e['to']}] {e['subject']}", "text": text_of(e), "html": html_of(e)}, key)
            print("  copied", e["to"], "->", "ok" if "id" in r else r)
            time.sleep(0.6)
        return

    done = {l.split("\t")[0].lower() for l in ledger.read_text().splitlines()} if ledger.exists() else set()
    pending = [e for e in entries if e["to"].lower() not in done]
    for e in pending:
        print(f"   {e['to']:<40} {e['subject']}")
    if not (a.at or a.now):
        print(f"\nDRY RUN, {len(pending)} to go. Add --at, --now, or --copy.")
        return
    start = datetime.strptime(a.at, "%Y-%m-%dT%H:%M:%SZ") if a.at else None
    for i, e in enumerate(pending):
        body = {"from": FROM, "to": [e["to"]], "reply_to": reply_to, "subject": e["subject"],
                "text": text_of(e), "html": html_of(e),
                "headers": {"In-Reply-To": e["in_reply_to"], "References": e["references"]}}
        if start:
            body["scheduled_at"] = (start + timedelta(minutes=a.stagger_minutes * i)).strftime("%Y-%m-%dT%H:%M:%SZ")
        r = api("/emails", body, key)
        if "id" in r:
            ledger.open("a").write(f"{e['to']}\t{r['id']}\n")
            print("  queued", body.get("scheduled_at", "now"), e["to"])
        else:
            print("  FAILED", e["to"], r)
        time.sleep(0.6)


if __name__ == "__main__":
    main()

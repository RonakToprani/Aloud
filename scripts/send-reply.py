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
    text = e["body"].rstrip() + "\n"
    if q := e.get("quote"):
        quoted = "\n".join("> " + line for line in q["text"].strip().splitlines())
        text += f"\n{q['from_line']}\n{quoted}\n"
    return text


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
                                "subject": f"[copy to {e['to']}] {e['subject']}", "text": text_of(e)}, key)
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
                "text": text_of(e),
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

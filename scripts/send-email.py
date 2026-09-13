#!/usr/bin/env python3
"""Send one email to every reader who has an address.

Aloud's mail goes out through Resend over SMTP, the same account Supabase
uses for sign-in codes. This exists so a announcement is one command with a
dry run in front of it, rather than something reinvented each time.

    # what would happen, and to how many people
    python3 scripts/send-email.py --subject "..." --html emails/x.html --text emails/x.txt --all

    # one copy to yourself first, always
    python3 scripts/send-email.py --subject "..." --html emails/x.html --text emails/x.txt --to you@example.com --send

    # then, for real
    python3 scripts/send-email.py --subject "..." --html emails/x.html --text emails/x.txt --all --send

Nothing sends without --send. Addresses are masked in output: this prints to
a terminal that may be shared, and they are readers' addresses, not ours.
Everyone already sent is recorded beside the HTML and skipped on a re-run, so
a failure part way through is safe to retry.
"""
import argparse, json, pathlib, re, smtplib, socket, ssl, subprocess, sys, time
from email.message import EmailMessage
from email.utils import formatdate, make_msgid

FROM = "Ronak at Aloud <hello@send.aloudreader.org>"
HOST, PORT, USER = "smtp.resend.com", 465, "resend"
# Resend's free tier allows 100 a day. Well clear of it, but the pause keeps
# us under the per-second limit too.
GAP_SECONDS = 0.6


def from_env(name: str, what: str) -> str:
    m = re.search(rf"^{name}=(.+)$", pathlib.Path(".env.local").read_text(), re.M)
    if not m:
        sys.exit(f"{name} is not in .env.local ({what})")
    return m.group(1).strip()


def api_key() -> str:
    return from_env("RESEND_SMTP_PASSWORD", "the Resend sending key")


def reply_to() -> str:
    """A real inbox, out of the repo because this one is public."""
    return from_env("ANNOUNCE_REPLY_TO", 'e.g. Ronak <you@example.com>')


def mask(address: str) -> str:
    name, _, domain = address.partition("@")
    return f"{name[:2]}{'*' * max(1, len(name) - 2)}@{domain}"


def deliverable(address: str) -> bool:
    """Does the domain accept mail at all?

    A reader who typed gmail.con at sign-up is one hard bounce, and hard
    bounces are what a new sending domain is judged on. Cheap to check, so
    check it rather than spend reputation finding out.
    """
    domain = address.rpartition("@")[2].lower()
    for record in ("MX", "A"):
        out = subprocess.run(["dig", "+short", record, domain, "@1.1.1.1"],
                             capture_output=True, text=True, timeout=10)
        if out.stdout.strip():
            return True
    return False


def readers() -> list[str]:
    """Everyone with an address. Anonymous sessions have none and are skipped."""
    out = subprocess.run(
        ["supabase", "db", "query", "--linked", "--output", "json",
         "select email from auth.users where email is not null and email <> '' "
         "and deleted_at is null order by created_at;"],
        capture_output=True, text=True)
    if out.returncode != 0:
        sys.exit("could not read the reader list:\n" + out.stderr[:400])
    body = re.search(r"\{.*\}", out.stdout, re.S)
    rows = json.loads(body.group(0))["rows"] if body else []
    return [r["email"] for r in rows if r.get("email")]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--subject", required=True)
    ap.add_argument("--html", required=True)
    ap.add_argument("--text", required=True)
    ap.add_argument("--to", action="append", help="one address; repeatable")
    ap.add_argument("--all", action="store_true", help="every reader with an address")
    ap.add_argument("--send", action="store_true", help="actually send; otherwise a dry run")
    a = ap.parse_args()

    html = pathlib.Path(a.html).read_text()
    text = pathlib.Path(a.text).read_text()
    to = list(a.to or [])
    if a.all:
        to += readers()
    if not to:
        sys.exit("no recipients: pass --to or --all")

    seen, unique = set(), []
    for address in to:
        low = address.strip().lower()
        if low and low not in seen:
            seen.add(low)
            unique.append(address.strip())

    undeliverable = [x for x in unique if not deliverable(x)]
    if undeliverable:
        print("skipping, the domain accepts no mail:")
        for address in undeliverable:
            print("   ", mask(address))
        unique = [x for x in unique if x not in undeliverable]

    ledger = pathlib.Path(a.html).with_suffix(".sent.txt")
    already = set(ledger.read_text().split()) if ledger.exists() else set()
    pending = [x for x in unique if x.lower() not in already]

    print(f'subject : {a.subject}')
    print(f'from    : {FROM}')
    print(f'reply-to: {reply_to()}')
    print(f'{len(unique)} recipients, {len(unique) - len(pending)} already sent, {len(pending)} to go')
    for address in pending:
        print("   ", mask(address))
    if not a.send:
        print("\nDRY RUN. Nothing sent. Add --send to do it for real.")
        return
    if not pending:
        print("\nNothing left to send.")
        return

    key = api_key()
    sent = 0
    with smtplib.SMTP_SSL(HOST, PORT, timeout=30, context=ssl.create_default_context()) as s:
        s.login(USER, key)
        for address in pending:
            m = EmailMessage()
            m["Subject"] = a.subject
            m["From"] = FROM
            m["To"] = address
            m["Reply-To"] = reply_to()
            m["Date"] = formatdate(localtime=True)
            m["Message-ID"] = make_msgid(domain="send.aloudreader.org")
            m["List-Unsubscribe"] = f"<mailto:{reply_to().split('<')[-1].rstrip('>')}?subject=unsubscribe>"
            m.set_content(text)
            m.add_alternative(html, subtype="html")
            try:
                s.send_message(m)
                # Written as we go: a crash half way through must not resend
                # to everyone who already had it.
                with ledger.open("a") as f:
                    f.write(address.lower() + "\n")
                sent += 1
                print("  sent", mask(address))
            except Exception as e:
                print("  FAILED", mask(address), type(e).__name__, str(e)[:120])
            time.sleep(GAP_SECONDS)
    print(f"\n{sent} sent. Ledger: {ledger}")


if __name__ == "__main__":
    main()

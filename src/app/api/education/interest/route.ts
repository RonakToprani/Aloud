import { NextResponse } from "next/server";
import { notification, parseInterest, type Interest } from "@/lib/education/interest";
import { isSameOrigin } from "@/lib/speech/edge/guard";

export const dynamic = "force-dynamic";

/** Where a school's interest is read. Forwarded to a person; see "Inbound
 *  mail" in CLAUDE.md. An environment variable so it can move without a deploy. */
const NOTIFY_TO = process.env.EDUCATION_NOTIFY_TO || "hello@aloudreader.org";
/** The send subdomain, so a deliverability problem never touches the domain
 *  the site serves from. */
const FROM = "Aloud for Education <hello@send.aloudreader.org>";

const WINDOW_MS = 10 * 60_000;
const MAX_PER_WINDOW = 5;
const recent = new Map<string, number[]>();

/** A speed bump, per instance: a person fills this in once. */
function allowed(request: Request): boolean {
  const key = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const now = Date.now();
  const times = (recent.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  times.push(now);
  recent.set(key, times);
  if (recent.size > 500) for (const [k, v] of recent) if (v.every((t) => now - t >= WINDOW_MS)) recent.delete(k);
  return times.length <= MAX_PER_WINDOW;
}

async function store(interest: Interest, userAgent: string | null): Promise<boolean> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return false;
  try {
    // A security definer function, not a table insert: the anon key can add
    // a row this way and can never read one back.
    const response = await fetch(`${url}/rest/v1/rpc/submit_education_interest`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        p_name: interest.name,
        p_email: interest.email,
        p_institution: interest.institution,
        p_role: interest.role,
        p_size: interest.size,
        p_current_tool: interest.current,
        p_renewal: interest.renewal,
        p_pilot: interest.pilot,
        p_message: interest.message,
        p_user_agent: userAgent?.slice(0, 300) ?? null,
      }),
      cache: "no-store",
    });
    if (!response.ok) console.error("education interest: store failed", response.status, await response.text());
    return response.ok;
  } catch (error) {
    console.error("education interest: store failed", error);
    return false;
  }
}

async function mail(interest: Interest): Promise<boolean> {
  // Resend's SMTP password is an API key, so either name works.
  const key = process.env.RESEND_API_KEY || process.env.RESEND_SMTP_PASSWORD;
  if (!key) return false;
  const note = notification(interest);
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        // Resend sits behind Cloudflare, which refuses some default agents.
        "User-Agent": "aloud-education/1.0",
      },
      body: JSON.stringify({
        from: FROM,
        to: [NOTIFY_TO],
        // Reply goes straight to the person who asked.
        reply_to: interest.email,
        subject: note.subject,
        text: note.text,
        html: note.html,
      }),
      cache: "no-store",
    });
    if (!response.ok) console.error("education interest: mail failed", response.status, await response.text());
    return response.ok;
  } catch (error) {
    console.error("education interest: mail failed", error);
    return false;
  }
}

export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request, new Set())) return NextResponse.json({ error: "Not allowed." }, { status: 403 });
  if (!allowed(request)) {
    return NextResponse.json({ error: "That's a lot of sign-ups at once. Please try again in a few minutes." }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const parsed = parseInterest(body);
  if (!parsed.ok) {
    if (parsed.spam) return NextResponse.json({ ok: true });
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const [stored, mailed] = await Promise.all([store(parsed.interest, request.headers.get("user-agent")), mail(parsed.interest)]);
  // Either is enough for a person to see it. Neither means it would be lost,
  // so say so rather than thank them for nothing.
  if (!stored && !mailed) {
    return NextResponse.json(
      { error: "We couldn't save that just now. Please try again, or write to hello@aloudreader.org." },
      { status: 502 },
    );
  }
  return NextResponse.json({ ok: true });
}

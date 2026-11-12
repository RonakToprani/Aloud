/**
 * An expression of interest from a school, as the education page's form
 * sends it. Checked here, on the server, before it is stored or mailed: the
 * form's own `required` attributes are a courtesy, not a gate.
 */

export const ROLES = [
  "Disability or accessibility services",
  "Faculty or instructor",
  "Library",
  "IT or educational technology",
  "Student",
  "Other",
] as const;

export const SIZES = ["Under 1,000", "1,000 to 10,000", "10,000 to 30,000", "Over 30,000", "Not sure"] as const;

/** What the school reads with today, so we know whose renewal we are up against. */
export const CURRENT = ["Kurzweil 3000", "Read&Write", "Both", "Something else", "Nothing yet", "Not sure"] as const;

export interface Interest {
  name: string;
  email: string;
  institution: string;
  role: (typeof ROLES)[number];
  size: (typeof SIZES)[number] | null;
  current: (typeof CURRENT)[number] | null;
  message: string | null;
}

export type Parsed = { ok: true; interest: Interest } | { ok: false; error: string; spam?: boolean };

const LIMITS = { name: 120, email: 254, institution: 200, message: 2000 } as const;

/** Deliberately loose: one @, a dot in the domain, no spaces. The address is
 *  read by a person who will write back, not mailed by a list. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function text(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

export function parseInterest(body: unknown): Parsed {
  if (!body || typeof body !== "object") return { ok: false, error: "Something went wrong. Please try again." };
  const raw = body as Record<string, unknown>;

  // The hidden field a person never sees. A bot that fills every input is
  // told it succeeded, so it has no reason to try a different shape.
  if (text(raw.website)) return { ok: false, error: "", spam: true };

  const name = text(raw.name);
  const email = text(raw.email).toLowerCase();
  const institution = text(raw.institution);
  const role = text(raw.role);
  const size = text(raw.size);
  const current = text(raw.current);
  // Line breaks are kept in a message; only its ends are trimmed.
  const message = typeof raw.message === "string" ? raw.message.trim() : "";

  if (!name) return { ok: false, error: "Please add your name." };
  if (!EMAIL.test(email)) return { ok: false, error: "Please check your email address." };
  if (!institution) return { ok: false, error: "Please add your school or institution." };
  if (!(ROLES as readonly string[]).includes(role)) return { ok: false, error: "Please choose your role." };
  if (size && !(SIZES as readonly string[]).includes(size)) return { ok: false, error: "Please choose a size from the list." };
  if (current && !(CURRENT as readonly string[]).includes(current)) return { ok: false, error: "Please choose a tool from the list." };
  if (
    name.length > LIMITS.name ||
    email.length > LIMITS.email ||
    institution.length > LIMITS.institution ||
    message.length > LIMITS.message
  ) {
    return { ok: false, error: "One of the answers is too long." };
  }

  return {
    ok: true,
    interest: {
      name,
      email,
      institution,
      role: role as Interest["role"],
      size: size ? (size as Interest["size"]) : null,
      current: current ? (current as Interest["current"]) : null,
      message: message || null,
    },
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** The note that reaches the Aloud inbox, in both parts: a bulk sender with
 *  no plain text alternative looks like spam, and some clients show only it. */
export function notification(interest: Interest): { subject: string; text: string; html: string } {
  const rows: [string, string][] = [
    ["Name", interest.name],
    ["Email", interest.email],
    ["Institution", interest.institution],
    ["Role", interest.role],
    ["Students", interest.size ?? "Not given"],
    ["Uses today", interest.current ?? "Not given"],
  ];
  const message = interest.message ?? "No message.";
  return {
    subject: `Education interest: ${interest.institution}`,
    text: `${rows.map(([k, v]) => `${k}: ${v}`).join("\n")}\n\n${message}\n`,
    html:
      `<p>${rows.map(([k, v]) => `<strong>${k}:</strong> ${escapeHtml(v)}`).join("<br>")}</p>` +
      `<p>${escapeHtml(message).replace(/\n/g, "<br>")}</p>`,
  };
}

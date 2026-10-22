import { NextResponse, type NextRequest } from "next/server";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";
const own = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]);
try {
  if (process.env.NEXT_PUBLIC_SITE_URL)
    own.add(new URL(process.env.NEXT_PUBLIC_SITE_URL).hostname.toLowerCase());
} catch {}

// Sign-up goes through here (not straight from the browser to the API) so it also works on a customer's own
// domain. The API sees this server as the caller, so the per-address limit has to live here.
const WINDOW_MS = 10 * 60_000;
const MAX = 5;
const hits = new Map<string, { n: number; resetAt: number }>();

function limited(ip: string) {
  const now = Date.now();
  if (hits.size > 5_000) for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  const h = hits.get(ip);
  if (!h || h.resetAt <= now) {
    hits.set(ip, { n: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  return ++h.n > MAX;
}

const fail = (error: string, status: number) => NextResponse.json({ error }, { status });

export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (limited(ip)) return fail("Too many attempts. Please try again in a few minutes.", 429);

  const body = (await req.json().catch(() => null)) as { email?: unknown; slug?: unknown } | null;
  if (!body || typeof body.email !== "string") return fail("Enter a valid email address.", 400);

  // On a customer's domain the page is the host itself; on Upzy's own address it is named in the request.
  const host = (req.headers.get("host") ?? "").split(":")[0]!.toLowerCase();
  const target = own.has(host)
    ? typeof body.slug === "string"
      ? `status/${encodeURIComponent(body.slug)}`
      : null
    : `status-domain/${encodeURIComponent(host)}`;
  if (!target) return fail("Unknown status page.", 404);

  let res: Response;
  try {
    res = await fetch(`${API}/public/${target}/subscribe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: body.email }),
      cache: "no-store",
    });
  } catch {
    return fail("Couldn't reach the status service. Please try again.", 502);
  }
  if (res.ok) return NextResponse.json({ ok: true }, { status: 202 });
  if (res.status === 400) return fail("Enter a valid email address.", 400);
  if (res.status === 404) return fail("Unknown status page.", 404);
  const message = ((await res.json().catch(() => null)) as { message?: string } | null)?.message;
  return fail(message ?? "Couldn't sign you up. Please try again.", res.status === 429 ? 429 : 502);
}

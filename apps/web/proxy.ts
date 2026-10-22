import { NextResponse, type NextRequest } from "next/server";

/**
 * Custom domains. A status page can be served on its owner's own address (status.acme.com), which arrives here as a
 * request for "/" with an unfamiliar Host. Those are rewritten to the status page for that domain; any other path on
 * a foreign host is a 404 (apart from the page's own sign-up form), so a customer's domain never exposes the app. Requests for Upzy's own address (and
 * localhost) pass through untouched.
 *
 * Whether a domain really belongs to a published page is decided by the API (it answers 404 otherwise).
 */
const own = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]);
try {
  if (process.env.NEXT_PUBLIC_SITE_URL)
    own.add(new URL(process.env.NEXT_PUBLIC_SITE_URL).hostname.toLowerCase());
} catch {}

export function proxy(req: NextRequest) {
  const host = (req.headers.get("host") ?? "").split(":")[0]!.toLowerCase();
  if (!host || own.has(host)) return NextResponse.next();
  if (req.nextUrl.pathname === "/") {
    return NextResponse.rewrite(new URL(`/status-domain/${encodeURIComponent(host)}`, req.url));
  }
  // The sign-up form on a customer's status page posts here.
  if (req.nextUrl.pathname === "/status-subscribe" && req.method === "POST")
    return NextResponse.next();
  return new NextResponse("Not found", { status: 404 });
}

export const config = {
  // Static assets (and the favicon) still load on a custom domain.
  matcher: ["/((?!_next/static|_next/image|icon.svg|favicon.ico|robots.txt|opengraph-image).*)"],
};

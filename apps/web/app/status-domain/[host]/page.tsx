import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { StatusView, type Status } from "@/components/status/status-view";

export const revalidate = 30;

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";
const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? "/";

/** The page behind a customer's own domain: the proxy rewrites "/" on that host to here. */
async function load(host: string): Promise<Status | null> {
  let res: Response;
  try {
    res = await fetch(`${API}/public/status-domain/${encodeURIComponent(host)}`, {
      next: { revalidate: 30 },
    });
  } catch {
    throw new Error("The status service is unreachable");
  }
  if (res.status === 404 || res.status === 400) return null;
  if (!res.ok) throw new Error("The status service is unavailable");
  return (await res.json()) as Status;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ host: string }>;
}): Promise<Metadata> {
  const { host } = await params;
  const s = await load(host).catch(() => null);
  return {
    title: s ? s.title : "Status",
    description: s?.description || undefined,
    robots: { index: false, follow: false },
  };
}

export default async function StatusByDomain({ params }: { params: Promise<{ host: string }> }) {
  const { host } = await params;
  const s = await load(host);
  if (!s) notFound();
  // "Powered by" must leave this site: on a customer's domain "/" is the status page itself.
  return <StatusView s={s} homeUrl={SITE} />;
}

import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { StatusView, type Status } from "@/components/status/status-view";

// Re-read at most every 30 seconds: a busy status page never turns into load on the API.
export const revalidate = 30;

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

async function load(slug: string): Promise<Status | null> {
  let res: Response;
  try {
    res = await fetch(`${API}/public/status/${encodeURIComponent(slug)}`, {
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
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const s = await load(slug).catch(() => null);
  return {
    title: s ? s.title : "Status",
    description: s?.description || undefined,
    // A customer's status page is for their customers, not for search results.
    robots: { index: false, follow: false },
  };
}

export default async function StatusPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const s = await load(slug);
  if (!s) notFound();
  return <StatusView s={s} slug={slug} />;
}

import type { Metadata } from "next";
import { cookies } from "next/headers";

import { Shell } from "@/components/app/shell";
import { WorkspaceProvider } from "@/components/app/workspace";

// Private pages: keep them out of search results.
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // Whether the sidebar is folded to icons lives in a cookie, so the first paint is already right.
  const initialCollapsed = (await cookies()).get("upzy-sidebar")?.value === "collapsed";
  return (
    <WorkspaceProvider>
      <Shell initialCollapsed={initialCollapsed}>{children}</Shell>
    </WorkspaceProvider>
  );
}

import { Toaster } from "@upzy/ui/components/sonner";
import type { Metadata } from "next";

import "@/styles/globals.css";
import { Sora } from "next/font/google";

import { ConfirmProvider } from "@/components/app/confirm";
import { ThemeProvider } from "@/components/theme-provider";

const sora = Sora({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-sora",
});

const title = "Upzy: uptime monitoring and attack-surface security";
const description =
  "Know when your sites go down and what's exposed before attackers do. Uptime monitoring, security checks and an AI copilot for small teams.";

export const metadata: Metadata = {
  // Absolute URLs for link previews. Set NEXT_PUBLIC_SITE_URL at build time (see docker/Dockerfile.web).
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3001"),
  title,
  description,
  openGraph: { title, description, type: "website", siteName: "Upzy" },
  twitter: { card: "summary_large_image", title, description },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning className={sora.variable}>
      <body className="font-sans antialiased">
        <ThemeProvider>
          <ConfirmProvider>{children}</ConfirmProvider>
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}

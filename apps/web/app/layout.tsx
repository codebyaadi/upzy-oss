import { Toaster } from "@upzy/ui/components/sonner";
import type { Metadata, Viewport } from "next";

import "@/styles/globals.css";
import { Sora } from "next/font/google";

import { ConfirmProvider } from "@/components/app/confirm";
import { ThemeProvider } from "@/components/theme-provider";
import { AUTHOR, KEYWORDS, SITE_NAME, SITE_URL } from "@/lib/seo";

const sora = Sora({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-sora",
});

const title = "Upzy: uptime monitoring and attack-surface security";
const description =
  "Know when your sites go down and what's exposed before attackers do. Uptime monitoring, public status pages, security checks and optional AI explanations for small teams. Free during early access, open source.";

export const metadata: Metadata = {
  // Absolute URLs for link previews and canonical addresses. Set NEXT_PUBLIC_SITE_URL at build time (docker/Dockerfile.web).
  metadataBase: new URL(SITE_URL),
  // Pages that set a short title ("Pricing") become "Pricing | Upzy" in search results and tabs.
  title: { default: title, template: `%s | ${SITE_NAME}` },
  description,
  applicationName: SITE_NAME,
  keywords: KEYWORDS,
  authors: [AUTHOR],
  creator: AUTHOR.name,
  category: "technology",
  openGraph: {
    title,
    description,
    type: "website",
    siteName: SITE_NAME,
    locale: "en_US",
  },
  twitter: { card: "summary_large_image", title, description },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, "max-image-preview": "large", "max-snippet": -1 },
  },
  formatDetection: { telephone: false, email: false, address: false },
  // Proof of ownership for the search consoles. Set at build time; both are optional.
  verification: {
    google: process.env.NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION || undefined,
    other: process.env.NEXT_PUBLIC_BING_SITE_VERIFICATION
      ? { "msvalidate.01": process.env.NEXT_PUBLIC_BING_SITE_VERIFICATION }
      : undefined,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4f6f3" },
    { media: "(prefers-color-scheme: dark)", color: "#0c1110" },
  ],
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

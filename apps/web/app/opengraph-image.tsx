import { readFile } from "node:fs/promises";
import path from "node:path";

import { ImageResponse } from "next/og";

export const alt = "Upzy: uptime monitoring and attack-surface security";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Sora, the site's typeface, bundled next to this file (SIL OFL, see _og-fonts/OFL-LICENSE.txt): the image
// generator cannot load web fonts, and a request-time download would make link previews depend on a third party.
// next.config.ts makes the production build ship these files. If they are ever missing the image still renders,
// in the default font, rather than failing the preview.
const font = (file: string) => readFile(path.join(process.cwd(), "app", "_og-fonts", file));

const rows = [
  { name: "api.acme.com", ms: "182 ms", up: true, hot: true },
  { name: "acme.com", ms: "96 ms", up: true },
  { name: "checkout.acme.com", ms: "Timeout", up: false },
];

/** The picture shown when a link to Upzy is shared. Mirrors the dark landing page and the README banner. */
export default async function OpengraphImage() {
  const fonts = await Promise.all([
    font("sora-latin-400-normal.woff").then((data) => ({
      name: "Sora",
      data,
      weight: 400 as const,
    })),
    font("sora-latin-600-normal.woff").then((data) => ({
      name: "Sora",
      data,
      weight: 600 as const,
    })),
    font("sora-latin-800-normal.woff").then((data) => ({
      name: "Sora",
      data,
      weight: 800 as const,
    })),
  ]).catch(() => []);

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 72px",
        background: "#0c1110",
        backgroundImage:
          "radial-gradient(circle at 0% 0%, rgba(31,138,120,0.45) 0%, rgba(12,17,16,0) 55%), radial-gradient(circle at 100% 100%, rgba(198,235,225,0.14) 0%, rgba(12,17,16,0) 50%)",
        color: "#f1f4f2",
        fontFamily: "Sora",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", width: 600 }}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 36 }}>
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 17,
              background: "#0f3d3a",
              border: "1px solid rgba(127,216,195,0.3)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
              <path
                d="M2.5 17h6.2l3.3-8.5 5.6 16 3.4-9.5h8.5"
                stroke="#c6ebe1"
                strokeWidth="4.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <div style={{ fontSize: 38, fontWeight: 800, letterSpacing: -1.5, marginLeft: 16 }}>
            Upzy.
          </div>
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            fontSize: 62,
            fontWeight: 800,
            letterSpacing: -3,
            lineHeight: 1.04,
          }}
        >
          <div style={{ display: "flex" }}>Know it&apos;s down</div>
          <div style={{ display: "flex" }}>
            <span style={{ color: "#7fd8c3" }}>before</span>
            <span style={{ marginLeft: 16 }}>your</span>
          </div>
          <div style={{ display: "flex" }}>customers do.</div>
        </div>
        <div
          style={{
            display: "flex",
            marginTop: 28,
            fontSize: 22,
            lineHeight: 1.5,
            color: "#9fa9a6",
          }}
        >
          Uptime monitoring and attack-surface security for small teams.
        </div>
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          width: 420,
          padding: 12,
          borderRadius: 26,
          background: "rgba(23,29,28,0.9)",
          border: "1px solid rgba(255,255,255,0.14)",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "10px 14px 12px",
            fontSize: 16,
            fontWeight: 800,
          }}
        >
          <span>Monitors</span>
          <span
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: "#dff3ed",
              background: "rgba(255,255,255,0.08)",
              padding: "5px 12px",
              borderRadius: 999,
            }}
          >
            All systems
          </span>
        </div>
        {rows.map((r) => (
          <div
            key={r.name}
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "14px 14px",
              borderRadius: 16,
              fontSize: 16,
              background: r.hot ? "rgba(31,138,120,0.16)" : "transparent",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", fontWeight: 600 }}>
              <div
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 5,
                  marginRight: 12,
                  background: r.up ? "#7fd8c3" : "#ffa69b",
                }}
              />
              {r.name}
            </div>
            <div style={{ display: "flex", fontSize: 13, color: "#9fa9a6" }}>
              {r.ms}
              <span
                style={{ marginLeft: 12, fontWeight: 800, color: r.up ? "#f1f4f2" : "#ffa69b" }}
              >
                {r.up ? "Up" : "Down"}
              </span>
            </div>
          </div>
        ))}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            margin: "8px 2px 2px",
            padding: "14px 14px",
            borderRadius: 16,
            background: "rgba(31,138,120,0.3)",
            fontSize: 14,
            lineHeight: 1.5,
            color: "#dff3ed",
          }}
        >
          <div style={{ display: "flex", color: "#7fd8c3", fontWeight: 800, marginBottom: 2 }}>
            AI summary
          </div>
          <div style={{ display: "flex" }}>
            checkout.acme.com stopped responding at 02:14 UTC. The origin times out.
          </div>
        </div>
      </div>
    </div>,
    {
      ...size,
      fonts,
    },
  );
}

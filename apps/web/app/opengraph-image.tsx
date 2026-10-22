import { ImageResponse } from "next/og";

export const alt = "Upzy: uptime monitoring and attack-surface security";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/** The picture shown when a link to Upzy is shared. */
export default function OpengraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: 80,
        background: "linear-gradient(135deg, #e6f4ef 0%, #f6f8f6 55%, #d3eae2 100%)",
        color: "#101615",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
        <div
          style={{
            width: 72,
            height: 72,
            borderRadius: 36,
            background: "#0f3d38",
            color: "#fff",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 40,
          }}
        >
          ~
        </div>
        <div style={{ fontSize: 56, fontWeight: 800, letterSpacing: -2 }}>Upzy.</div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
        <div style={{ fontSize: 84, fontWeight: 800, letterSpacing: -3, lineHeight: 1.02 }}>
          Know it&apos;s down before your customers do.
        </div>
        <div style={{ fontSize: 34, color: "#4b5a57" }}>
          Uptime monitoring and attack-surface security for small teams.
        </div>
      </div>
    </div>,
    size,
  );
}

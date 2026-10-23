import type { MetadataRoute } from "next";

/** Lets the site be added to a home screen, and tells browsers its name and colours. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Upzy",
    short_name: "Upzy",
    description: "Uptime monitoring and external attack-surface security for small teams.",
    start_url: "/",
    display: "standalone",
    background_color: "#f4f6f3",
    theme_color: "#0f3d3a",
    icons: [
      { src: "/icon.png", sizes: "512x512", type: "image/png" },
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
    ],
  };
}

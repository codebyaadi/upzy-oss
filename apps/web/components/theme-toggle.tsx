"use client";

import { Moon02Icon, Sun03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@upzy/ui/components/button";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

/** Switches between light and dark. Shows the icon for the mode you would switch to; nothing until it knows the theme. */
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const dark = mounted && resolvedTheme === "dark";
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      onClick={() => setTheme(dark ? "light" : "dark")}
      className="text-muted-foreground"
    >
      {mounted && <HugeiconsIcon icon={dark ? Sun03Icon : Moon02Icon} aria-hidden />}
    </Button>
  );
}

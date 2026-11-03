"use client";

import { useEffect, useState, type ReactNode } from "react";

/**
 * The bar the navigation sits in. At the top of the page it is fully transparent, so it looks like part of the page;
 * after a few pixels of scrolling it gets a translucent, blurred background so the links stay readable over content.
 * Without JavaScript it simply stays transparent.
 */
export function NavShell({ children }: { children: ReactNode }) {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const update = () => setScrolled(window.scrollY > 8);
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, []);

  return (
    <header
      data-scrolled={scrolled}
      className={`fixed inset-x-0 top-0 z-40 transition-[background-color,backdrop-filter] duration-300 ${
        scrolled ? "bg-background/70 backdrop-blur-xl" : "bg-transparent"
      }`}
    >
      {children}
    </header>
  );
}

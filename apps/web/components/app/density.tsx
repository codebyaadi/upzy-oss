"use client";

import { useEffect, useState } from "react";

import { Segmented } from "./segmented";

export type Density = "comfortable" | "compact";
const KEY = "upzy:density";

/** Comfortable or compact rows for the long lists, remembered in this browser (and shared by every list). */
export function useDensity() {
  const [density, setDensity] = useState<Density>("comfortable");
  useEffect(() => {
    try {
      if (localStorage.getItem(KEY) === "compact") setDensity("compact");
    } catch {
      /* storage unavailable: stay comfortable */
    }
  }, []);
  const choose = (d: Density) => {
    setDensity(d);
    try {
      localStorage.setItem(KEY, d);
    } catch {
      /* not remembered */
    }
  };
  return [density, choose] as const;
}

export function DensityToggle({
  value,
  onValueChange,
}: {
  value: Density;
  onValueChange: (d: Density) => void;
}) {
  return (
    <Segmented
      label="Row density"
      value={value}
      onValueChange={onValueChange}
      options={[
        { value: "comfortable", label: "Comfortable" },
        { value: "compact", label: "Compact" },
      ]}
    />
  );
}

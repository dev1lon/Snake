import { useEffect, useState } from "react";

type PerformanceNavigator = Navigator & {
  connection?: { saveData?: boolean };
  deviceMemory?: number;
};

function shouldUseLiteEffects() {
  if (typeof window === "undefined") {
    return false;
  }

  const performanceNavigator = navigator as PerformanceNavigator;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const lowMemory =
    typeof performanceNavigator.deviceMemory === "number" &&
    performanceNavigator.deviceMemory <= 4;
  const lowCpu = navigator.hardwareConcurrency > 0 && navigator.hardwareConcurrency <= 4;

  return reducedMotion || lowMemory || lowCpu || Boolean(performanceNavigator.connection?.saveData);
}

export function useLiteEffects() {
  const [liteEffects, setLiteEffects] = useState(shouldUseLiteEffects);

  useEffect(() => {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updatePreference = () => setLiteEffects(shouldUseLiteEffects());

    reducedMotion.addEventListener("change", updatePreference);

    return () => reducedMotion.removeEventListener("change", updatePreference);
  }, []);

  return liteEffects;
}

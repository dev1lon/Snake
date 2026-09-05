import { useEffect, useState } from "react";

// The gate is its own page — plain HTML and CSS in public/gate.html, with the
// Base App link written straight into it. Nothing about it is built by Vite, so
// it can be opened, edited and reviewed on its own.
export const GATE_PAGE_PATH = "/gate.html";

// Detection is a set of heuristics, not a guarantee: there is no single flag
// that says "you are inside Base App". Everything here errs towards letting the
// player in — the gate is a signpost for people who opened the URL in Safari,
// not a security boundary.
function detectBaseApp() {
  if (typeof window === "undefined") {
    return true;
  }

  const userAgent = navigator.userAgent.toLowerCase();

  if (/baseapp|base app|coinbasewallet|coinbasebrowser|cbwallet/.test(userAgent)) {
    return true;
  }

  const provider = (window as Window & { ethereum?: Record<string, unknown> }).ethereum;

  if (provider?.isCoinbaseWallet || provider?.isCoinbaseBrowser || provider?.isBaseApp) {
    return true;
  }

  // Mini apps are hosted in a frame by Base App, and its native shell exposes a
  // React Native webview bridge.
  if (window.parent !== window || "ReactNativeWebView" in window) {
    return true;
  }

  return false;
}

export function shouldShowBaseAppGate() {
  // ?gate=1 previews the screen anywhere, including local development.
  try {
    if (new URLSearchParams(window.location.search).get("gate") === "1") {
      return true;
    }
  } catch {
    // No location to read: fall through to environment detection.
  }

  // Production opens the game in Base App. Local development stays accessible.
  if (import.meta.env.DEV) {
    return false;
  }

  return !detectBaseApp();
}

export function useBaseAppGate() {
  const [showGate, setShowGate] = useState<boolean | null>(() =>
    shouldShowBaseAppGate() ? null : false
  );

  // The wallet provider can be injected a tick after first paint, which would
  // otherwise leave a Base App player staring at the gate.
  useEffect(() => {
    if (showGate !== null) {
      return;
    }

    const recheck = () => {
      if (!shouldShowBaseAppGate()) setShowGate(false);
    };
    const timer = window.setTimeout(() => setShowGate(shouldShowBaseAppGate()), 600);

    window.addEventListener("ethereum#initialized", recheck);

    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("ethereum#initialized", recheck);
    };
  }, [showGate]);

  return showGate;
}

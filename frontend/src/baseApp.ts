import { useEffect, useState } from "react";

// The link to the mini app inside Base App. Set VITE_BASE_APP_LINK once the
// final URL exists — until then the gate still shows, with the button disabled
// instead of pointing somewhere wrong.
export const BASE_APP_LINK = (import.meta.env.VITE_BASE_APP_LINK ?? "").trim();
export const CREATOR_HANDLE = (import.meta.env.VITE_CREATOR_HANDLE ?? "@devilonnn").trim();
export const CREATOR_URL = (import.meta.env.VITE_CREATOR_URL ?? "").trim();

// What the gate prints under the button. Falls back to the link without its
// scheme, which is how Base App itself writes these.
export const BASE_APP_LABEL =
  (import.meta.env.VITE_BASE_APP_LABEL ?? "").trim() ||
  BASE_APP_LINK.replace(/^https?:\/\//, "").replace(/\/$/, "");

const SKIP_KEY = "snake.skipBaseAppGate";

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

function hasSkipFlag() {
  try {
    if (new URLSearchParams(window.location.search).get("web") === "1") {
      window.localStorage.setItem(SKIP_KEY, "1");
      return true;
    }

    return window.localStorage.getItem(SKIP_KEY) === "1";
  } catch {
    return false;
  }
}

export function shouldShowBaseAppGate() {
  // Escape hatches, in order: the build opts out, we're on a dev server, or the
  // player asked for the browser build with ?web=1.
  if (import.meta.env.VITE_REQUIRE_BASE_APP === "false" || import.meta.env.DEV) {
    return false;
  }

  if (hasSkipFlag()) {
    return false;
  }

  return !detectBaseApp();
}

export function useBaseAppGate() {
  const [showGate, setShowGate] = useState(shouldShowBaseAppGate);

  // The wallet provider can be injected a tick after first paint, which would
  // otherwise leave a Base App player staring at the gate.
  useEffect(() => {
    if (!showGate) {
      return;
    }

    const recheck = () => setShowGate(shouldShowBaseAppGate());
    const timer = window.setTimeout(recheck, 600);

    window.addEventListener("ethereum#initialized", recheck);

    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("ethereum#initialized", recheck);
    };
  }, [showGate]);

  return showGate;
}

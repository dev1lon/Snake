import { reconnect } from "@wagmi/core";
import { useEffect } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { GATE_PAGE_PATH, useBaseAppGate } from "./baseApp";
import Game from "./Game";
import Landing from "./Landing";
import { wagmiConfig } from "./wagmi";

// BrowserRouter, not MemoryRouter: in a browser the URL has to be real, so
// /game survives a refresh and can be linked to. Render already rewrites
// every path to index.html.
export default function App() {
  const showBaseAppGate = useBaseAppGate();

  useEffect(() => {
    if (showBaseAppGate === false) void reconnect(wagmiConfig);
  }, [showBaseAppGate]);

  // Outside Base App the wallet, sponsorship and notifications all dead-end, so
  // the browser is sent to the gate page rather than into a half-working game.
  // It's a real page, not a route: leaving the SPA is the point.
  useEffect(() => {
    if (showBaseAppGate) {
      window.location.replace(GATE_PAGE_PATH);
    }
  }, [showBaseAppGate]);

  if (showBaseAppGate !== false) {
    return null;
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/game" element={<Game />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

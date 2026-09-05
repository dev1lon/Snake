import { reconnect } from "@wagmi/core";
import { useEffect } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import Game from "./Game";
import Landing from "./Landing";
import { wagmiConfig } from "./wagmi";

// BrowserRouter, not MemoryRouter: in a browser the URL has to be real, so
// /game survives a refresh and can be linked to. Render already rewrites
// every path to index.html.
export default function App() {
  useEffect(() => {
    void reconnect(wagmiConfig);
  }, []);

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

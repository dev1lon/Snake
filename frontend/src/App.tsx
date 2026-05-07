import { reconnect } from "@wagmi/core";
import { useEffect } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import Game from "./Game";
import Landing from "./Landing";
import { wagmiConfig } from "./wagmi";

export default function App() {
  useEffect(() => {
    // Restore wallet connection from localStorage on every page load.
    // For Base App (Coinbase mobile), baseAccount connector detects the
    // mini-app context and auto-connects the Smart Wallet silently.
    void reconnect(wagmiConfig);
  }, []);

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/game" element={<Game />} />
      </Routes>
    </BrowserRouter>
  );
}

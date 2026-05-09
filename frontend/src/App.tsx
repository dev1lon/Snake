import { reconnect } from "@wagmi/core";
import { useEffect } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import Game from "./Game";
import Landing from "./Landing";
import { wagmiConfig } from "./wagmi";

export default function App() {
  useEffect(() => {
    void reconnect(wagmiConfig);
  }, []);

  return (
    <MemoryRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/game" element={<Game />} />
      </Routes>
    </MemoryRouter>
  );
}

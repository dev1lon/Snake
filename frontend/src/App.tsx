import { BrowserRouter, Route, Routes } from "react-router-dom";
import Game from "./Game";
import Landing from "./Landing";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/game" element={<Game />} />
      </Routes>
    </BrowserRouter>
  );
}

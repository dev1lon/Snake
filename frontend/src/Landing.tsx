import { ChevronLeft } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { getLevel, getLevelProgress } from "./levels";
import { WalletConnect } from "./WalletConnect";
import { useLiteEffects } from "./useLiteEffects";
import "./landing.css";

export default function Landing() {
  const navigate = useNavigate();
  const liteEffects = useLiteEffects();
  const [levelIndex] = useState(getLevelProgress);
  const [pickingMode, setPickingMode] = useState(false);
  const level = getLevel(levelIndex);

  return (
    <div className={`lnd-root${liteEffects ? " is-lite" : ""}`}>
      <div className="lnd-grid" />

      <div className="lnd-container">
        {/* Header */}
        <header className="lnd-header">
          <div className="lnd-logo">
            <img src="/coin.png" alt="Base Snake" />
            BASE SNAKE
          </div>
          <div className="lnd-wallet-wrap">
            <WalletConnect />
          </div>
        </header>

        {/* Scrollable content */}
        <main className="lnd-main">
          <h1 className="lnd-h1">
            SLITHER.<br />SURVIVE.
          </h1>
          <p className="lnd-subtitle">
            The classic game, engineered for the Base network. Eat protocol tokens, grow your
            length, top the global index.
          </p>

          {/* Hero */}
          <div className="lnd-hero">
            <div className="lnd-hero-snake-wrap">
              <img src="/hero.png" className="lnd-hero-snake" alt="" aria-hidden="true" />
            </div>
            {/* floating coin overlays matching coin positions in the image */}
            <img src="/coin.png" className="lnd-hero-coin lnd-hero-coin-1" alt="" aria-hidden="true" />
            <img src="/coin.png" className="lnd-hero-coin lnd-hero-coin-2" alt="" aria-hidden="true" />
            <img src="/coin.png" className="lnd-hero-coin lnd-hero-coin-3" alt="" aria-hidden="true" />
            <img src="/coin.png" className="lnd-hero-coin lnd-hero-coin-4" alt="" aria-hidden="true" />
          </div>

        </main>

        {/* Pinned play button - always in view */}
        <div className="lnd-cta">
          <button className="lnd-btn-play" type="button" onClick={() => setPickingMode(true)}>
            PLAY GAME
          </button>
        </div>
      </div>

      {/* Mode picker: play is one button, the choice comes after it. */}
      {pickingMode && (
        <div className="lnd-modes" role="dialog" aria-modal="true" aria-label="Choose a mode">
          <div className="lnd-modes-card">
            <h2>Choose a mode</h2>

            <button
              className="lnd-mode"
              type="button"
              onClick={() => navigate("/game?mode=classic")}
            >
              <strong>CLASSIC</strong>
              <small>16×16 · fill the whole board</small>
            </button>

            <button
              className="lnd-mode lnd-mode-levels"
              type="button"
              onClick={() => navigate("/game?mode=levels")}
            >
              <strong>LEVELS</strong>
              <small>
                LVL {levelIndex + 1} · {level.cols}×{level.rows} · boards keep growing
              </small>
            </button>

            <button className="lnd-modes-back" type="button" onClick={() => setPickingMode(false)}>
              <ChevronLeft size={15} />
              Back
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

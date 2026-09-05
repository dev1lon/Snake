import { useNavigate } from "react-router-dom";
import { WalletConnect } from "./WalletConnect";
import { useLiteEffects } from "./useLiteEffects";
import "./landing.css";

export default function Landing() {
  const navigate = useNavigate();
  const liteEffects = useLiteEffects();

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
          <button className="lnd-btn-play" type="button" onClick={() => navigate("/game")}>
            PLAY GAME
          </button>
        </div>
      </div>
    </div>
  );
}

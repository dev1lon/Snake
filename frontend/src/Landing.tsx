import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { API_URL } from "./api";
import { WalletConnect } from "./WalletConnect";
import { useLiteEffects } from "./useLiteEffects";
import "./landing.css";

export default function Landing() {
  const navigate = useNavigate();
  const liteEffects = useLiteEffects();
  const [players, setPlayers] = useState<number>(0);

  useEffect(() => {
    fetch(`${API_URL}/api/stats`)
      .then((r) => r.json())
      .then((d: { players: number }) => setPlayers(d.players ?? 0))
      .catch(() => {});
  }, []);

  const playerLabel = players.toLocaleString("en-US");

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
            SLITHER.<br />EARN.
          </h1>
          <p className="lnd-subtitle">
            The classic game, engineered for the Base network. Eat protocol tokens, grow your
            length, top the global index.
          </p>

          {/* 3D Scene */}
          <div className="lnd-scene">
            {/* Left tile */}
            <div className="lnd-tile lnd-tile-left">
              <svg className="lnd-tile-icon" viewBox="0 0 48 48" fill="none">
                <path d="M24 8L36 32H12L24 8Z" stroke="url(#lnd-cyan-grad)" strokeWidth="2" strokeLinejoin="round" />
                <path d="M24 18V28M24 28L28 24M24 28L20 24" stroke="rgba(255,255,255,0.5)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                <defs>
                  <linearGradient id="lnd-cyan-grad" x1="24" y1="8" x2="24" y2="32" gradientUnits="userSpaceOnUse">
                    <stop stopColor="#00E5FF" />
                    <stop offset="1" stopColor="rgba(0,229,255,0)" />
                  </linearGradient>
                </defs>
              </svg>
              <div className="lnd-tile-label">BOOST</div>
              <div className="lnd-tile-sub">x2.5 MULTI</div>
            </div>

            {/* Center tile */}
            <div className="lnd-tile lnd-tile-center">
              <div className="lnd-center-graphic">
                <svg viewBox="0 0 140 140" fill="none" style={{ position: "absolute", inset: 0, filter: "drop-shadow(0 10px 10px rgba(0,0,0,0.8))" }}>
                  <circle cx="100" cy="40" r="16" fill="#0052FF" filter="url(#lnd-glow)" />
                  <filter id="lnd-glow">
                    <feDropShadow dx="0" dy="0" stdDeviation="6" floodColor="#00E5FF" floodOpacity="0.9" />
                  </filter>
                  <path d="M100 48C104.418 48 108 44.4183 108 40C108 35.5817 104.418 32 100 32C95.5817 32 92 35.5817 92 40" stroke="white" strokeWidth="4" />
                  <path d="M20 120 C 40 120, 50 80, 80 80 C 110 80, 110 50, 90 40" stroke="url(#lnd-snake-gloss)" strokeWidth="24" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M20 120 C 40 120, 50 80, 80 80 C 110 80, 110 50, 90 40" stroke="rgba(255,255,255,0.3)" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" style={{ transform: "translate(-2px, -2px)" }} />
                  <defs>
                    <linearGradient id="lnd-snake-gloss" x1="20" y1="120" x2="90" y2="40" gradientUnits="userSpaceOnUse">
                      <stop stopColor="#0A0C10" />
                      <stop offset="0.5" stopColor="#1A2030" />
                      <stop offset="1" stopColor="#0A0C10" />
                    </linearGradient>
                  </defs>
                </svg>
              </div>
            </div>

            {/* Right tile */}
            <div className="lnd-tile lnd-tile-right">
              <svg className="lnd-tile-icon" viewBox="0 0 48 48" fill="none">
                <rect x="12" y="16" width="24" height="16" rx="4" stroke="url(#lnd-blue-grad)" strokeWidth="2" />
                <circle cx="24" cy="24" r="4" stroke="url(#lnd-blue-grad)" strokeWidth="2" />
                <path d="M12 24H8M40 24H36" stroke="rgba(255,255,255,0.3)" strokeWidth="2" strokeLinecap="round" />
                <defs>
                  <linearGradient id="lnd-blue-grad" x1="24" y1="16" x2="24" y2="32" gradientUnits="userSpaceOnUse">
                    <stop stopColor="#0052FF" />
                    <stop offset="1" stopColor="#00E5FF" />
                  </linearGradient>
                </defs>
              </svg>
              <div className="lnd-tile-label">POOL</div>
              <div className="lnd-tile-sub">1.2M $ETH</div>
            </div>
          </div>

        </main>

        {/* Pinned play button - always in view */}
        <div className="lnd-cta">
          <div className="lnd-players-badge" aria-label={`${playerLabel} players`}>
            <span className="lnd-players-value">{playerLabel}</span>
            <span className="lnd-players-label">PLAYERS</span>
          </div>
          <button className="lnd-btn-play" type="button" onClick={() => navigate("/game")}>
            PLAY GAME
          </button>
        </div>
      </div>
    </div>
  );
}

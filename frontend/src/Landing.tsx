import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAccount } from "wagmi";
import "./landing.css";

type LeaderboardEntry = {
  id: string;
  name: string;
  score: number;
  cells: number;
  won: boolean;
  createdAt: string;
};

const API_URL = import.meta.env.VITE_API_URL
  ? import.meta.env.VITE_API_URL.startsWith("http")
    ? import.meta.env.VITE_API_URL
    : `https://${import.meta.env.VITE_API_URL}`
  : "http://localhost:4000";

function formatAddress(address?: string) {
  if (!address) return null;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function formatScore(score: number) {
  return score.toLocaleString("en-US");
}

const BaseIcon = () => (
  <svg viewBox="0 0 200 200" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="100" cy="100" r="100" fill="#0052FF" />
    <path
      d="M100 156C130.928 156 156 130.928 156 100C156 69.072 130.928 44 100 44C69.072 44 44 69.072 44 100"
      stroke="white"
      strokeWidth="24"
    />
  </svg>
);

const ScoreIcon = () => (
  <svg className="lnd-score-icon" viewBox="0 0 24 24">
    <circle cx="12" cy="12" r="10" fill="#0052FF" />
    <path
      d="M12 17C14.7614 17 17 14.7614 17 12C17 9.23858 14.7614 7 12 7C9.23858 7 7 9.23858 7 12"
      stroke="white"
      strokeWidth="2"
      fill="none"
    />
  </svg>
);

const AVATAR_COLORS = [
  "linear-gradient(135deg, #0052FF, #7000FF)",
  "linear-gradient(135deg, #00C6FF, #0072FF)",
  "linear-gradient(135deg, #F09819, #EDDE5D)",
  "linear-gradient(135deg, #00E5FF, #0052FF)",
];

export default function Landing() {
  const navigate = useNavigate();
  const { address, isConnected } = useAccount();
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);

  useEffect(() => {
    fetch(`${API_URL}/api/leaderboard`)
      .then((r) => r.json())
      .then((data: { entries: LeaderboardEntry[] }) => setLeaderboard(data.entries.slice(0, 3)))
      .catch(() => {});
  }, []);

  const walletLabel = isConnected && address ? formatAddress(address) : null;

  return (
    <div className="lnd-root">
      <div className="lnd-grid" />

      <div className="lnd-container">
        {/* Header */}
        <header className="lnd-header">
          <div className="lnd-logo">
            <BaseIcon />
            BASE SNAKE
          </div>
          <button className="lnd-wallet-btn" type="button" onClick={() => navigate("/game")}>
            {walletLabel ?? "0x8F...3a1B"}
          </button>
        </header>

        <main>
          {/* Hero */}
          <section className="lnd-hero">
            <div className="lnd-sys-badge">
              <span className="lnd-pulse" />
              BASE MAINNET // LIVE
            </div>

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
                  <path
                    d="M24 8L36 32H12L24 8Z"
                    stroke="url(#lnd-cyan-grad)"
                    strokeWidth="2"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M24 18V28M24 28L28 24M24 28L20 24"
                    stroke="rgba(255,255,255,0.5)"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
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
                    <path
                      d="M100 48C104.418 48 108 44.4183 108 40C108 35.5817 104.418 32 100 32C95.5817 32 92 35.5817 92 40"
                      stroke="white"
                      strokeWidth="4"
                    />
                    <path
                      d="M20 120 C 40 120, 50 80, 80 80 C 110 80, 110 50, 90 40"
                      stroke="url(#lnd-snake-gloss)"
                      strokeWidth="24"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                    <path
                      d="M20 120 C 40 120, 50 80, 80 80 C 110 80, 110 50, 90 40"
                      stroke="rgba(255,255,255,0.3)"
                      strokeWidth="4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      style={{ transform: "translate(-2px, -2px)" }}
                    />
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

            {/* CTA */}
            <div className="lnd-action-area">
              <button className="lnd-btn-play" type="button" onClick={() => navigate("/game")}>
                INITIATE GAME
              </button>
              <div className="lnd-meta-stats">
                <div className="lnd-stat">
                  <div className="lnd-stat-value">12,408</div>
                  <div className="lnd-stat-label">Players Online</div>
                </div>
                <div className="lnd-stat">
                  <div className="lnd-stat-value">24ms</div>
                  <div className="lnd-stat-label">Network Latency</div>
                </div>
              </div>
            </div>
          </section>

          {/* Leaderboard */}
          <section>
            <div className="lnd-section-header">
              <div className="lnd-section-title">Global Index</div>
              <span className="lnd-section-link">VIEW ALL →</span>
            </div>

            <div className="lnd-leaderboard">
              {leaderboard.length > 0
                ? leaderboard.map((entry, i) => (
                    <div key={entry.id} className={`lnd-lb-row ${i === 0 ? "lnd-lb-row--first" : ""}`}>
                      <div className="lnd-lb-rank">{String(i + 1).padStart(2, "0")}</div>
                      <div className="lnd-lb-user">
                        <div
                          className="lnd-avatar"
                          style={{ background: AVATAR_COLORS[i % AVATAR_COLORS.length] }}
                        />
                        <div className="lnd-wallet">{entry.name}</div>
                      </div>
                      <div className="lnd-lb-score">
                        {formatScore(entry.score)}
                        <ScoreIcon />
                      </div>
                    </div>
                  ))
                : STATIC_BOARD.map((row, i) => (
                    <div key={row.wallet} className={`lnd-lb-row ${i === 0 ? "lnd-lb-row--first" : ""}`}>
                      <div className="lnd-lb-rank">{String(i + 1).padStart(2, "0")}</div>
                      <div className="lnd-lb-user">
                        <div className="lnd-avatar" style={{ background: AVATAR_COLORS[i] }} />
                        <div className="lnd-wallet">{row.wallet}</div>
                      </div>
                      <div className="lnd-lb-score">
                        {formatScore(row.score)}
                        <ScoreIcon />
                      </div>
                    </div>
                  ))}
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}

const STATIC_BOARD = [
  { wallet: "vitalik.base", score: 942050 },
  { wallet: "0x71...A9c2", score: 884100 },
  { wallet: "snakeking.eth", score: 750220 },
];

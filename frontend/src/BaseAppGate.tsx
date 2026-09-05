import { BASE_APP_LABEL, BASE_APP_LINK, CREATOR_HANDLE, CREATOR_URL } from "./baseApp";
import "./baseAppGate.css";

// Shown when the game is opened outside Base App. The game is built for the
// Base App webview — wallet, sponsorship and notifications all assume it — so
// rather than half-working in a desktop browser it points the player home.
export function BaseAppGate() {
  return (
    <div className="bag-root">
      <div className="bag-card">
        <span className="bag-corner bag-corner-tl" aria-hidden="true" />
        <span className="bag-corner bag-corner-tr" aria-hidden="true" />
        <span className="bag-corner bag-corner-bl" aria-hidden="true" />
        <span className="bag-corner bag-corner-br" aria-hidden="true" />

        <div className="bag-content">
          <span className="bag-badge">
            <i className="bag-dot" aria-hidden="true" />
            Base App only
          </span>

          <h1 className="bag-title">BASE SNAKE</h1>

          <p className="bag-subtitle">
            Open the game inside Base App to connect your wallet and play.
          </p>

          {BASE_APP_LINK ? (
            <a className="bag-button" href={BASE_APP_LINK} rel="noreferrer">
              Open in Base App
            </a>
          ) : (
            <button className="bag-button" type="button" disabled title="Link coming soon">
              Open in Base App
            </button>
          )}

          {BASE_APP_LABEL ? (
            <p className="bag-url">{BASE_APP_LABEL}</p>
          ) : (
            <p className="bag-url bag-url-pending">link coming soon</p>
          )}

          <p className="bag-credit">
            Created by{" "}
            {CREATOR_URL ? (
              <a href={CREATOR_URL} target="_blank" rel="noreferrer">
                {CREATOR_HANDLE}
              </a>
            ) : (
              <span>{CREATOR_HANDLE}</span>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}

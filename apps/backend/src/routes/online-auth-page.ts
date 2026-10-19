export function onlineAuthPage(completed: boolean, nonce: string): string {
  const title = completed ? "You're signed in." : "Sign-in couldn't be completed.";
  const description = completed
    ? "Return to RaceIQ to review your sharing permissions. Nothing is shared until you confirm your choices."
    : "RaceIQ couldn't finish connecting your account. The Online service may be unavailable, or this sign-in attempt may have expired.";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>${completed ? "Signed in" : "Sign-in incomplete"} · RaceIQ</title>
  <style>
    :root { color-scheme: dark; --bg: #09090b; --surface: #141417; --border: #303036; --text: #f5f5f5; --secondary: #b6b6bf; --accent: #22d3ee; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100svh; display: grid; place-items: center; padding: 32px 24px; background: var(--bg); color: var(--text); font: 15px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { width: min(100%, 520px); }
    header { display: flex; align-items: center; gap: 12px; padding-bottom: 24px; border-bottom: 1px solid var(--border); font-size: 20px; font-weight: 700; letter-spacing: -.03em; }
    header span { color: var(--secondary); font-size: 14px; font-weight: 400; letter-spacing: 0; }
    .status { width: 48px; height: 48px; margin: 32px 0 20px; display: grid; place-items: center; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); }
    svg { width: 24px; height: 24px; }
    h1 { margin: 0 0 16px; font-size: clamp(26px, 5vw, 34px); line-height: 1.2; letter-spacing: -.03em; text-wrap: balance; }
    p { margin: 0; color: var(--secondary); }
    .guidance { margin-top: 28px; padding-top: 24px; border-top: 1px solid var(--border); }
    .guidance strong { display: block; margin-bottom: 8px; color: var(--text); font-weight: 600; }
    button { min-height: 44px; margin: 28px 0 12px; padding: 10px 20px; border: 0; border-radius: 6px; background: var(--accent); color: #09090b; font: inherit; font-weight: 600; cursor: pointer; }
    button:hover { background: #67e8f9; }
    button:active { transform: translateY(1px); }
    button:focus-visible { outline: 2px solid var(--text); outline-offset: 4px; }
    .hint { font-size: 13px; }
    footer { margin-top: 36px; color: var(--secondary); font-size: 13px; }
    @media (max-width: 480px) { body { padding: 28px 20px; } button { width: 100%; } }
  </style>
</head>
<body>
  <main aria-labelledby="result-title">
    <header>RaceIQ <span>Online</span></header>
    <div class="status" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${completed ? '<path d="m5 12 4 4L19 6"/>' : '<circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 4h.01"/>'}</svg></div>
    <h1 id="result-title">${title}</h1>
    <p>${description}</p>
    <div class="guidance">
      <strong>${completed ? "Continue in RaceIQ" : "Start a fresh sign-in in RaceIQ"}</strong>
      <p>${completed ? "Your next step is waiting in the app." : "Return to the app and choose Discord sign-in again. If the service is unavailable, try again later. Reloading this page won't restart sign-in."}</p>
    </div>
    <button id="close-tab" type="button" hidden>Close this tab</button>
    <p class="hint">You can close this tab and switch back to RaceIQ.</p>
    ${completed ? "" : "<footer>Your offline recording and analysis remain available.</footer>"}
  </main>
  <script nonce="${nonce}">
    history.replaceState(null, '', location.pathname);
    const closeButton = document.getElementById('close-tab');
    closeButton.hidden = false;
    closeButton.addEventListener('click', () => {
      window.close();
      document.querySelector('.hint').textContent = "If this tab stays open, close it manually and switch back to RaceIQ.";
    });
  </script>
</body>
</html>`;
}

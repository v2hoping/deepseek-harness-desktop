/**
 * The page the window shows while the Host is still starting.
 *
 * The window is created before the Host answers, so the wait is visible
 * instead of being a period with nothing on screen at all. A first launch on
 * Windows spends that time loading the Host's plugin tree past on-access
 * virus scanning, which is long enough that an empty desktop reads as a
 * failure to start.
 *
 * The markup carries no script and no external reference: it is handed to the
 * renderer as a data URL, under the same `webSecurity` the real page loads
 * with, and is replaced by the Host's own origin as soon as that answers.
 */

/** The product name shown while waiting. */
const TITLE = 'DeepSeek Harness'

const DOCUMENT = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>${TITLE}</title>
<style>
  :root { color-scheme: light dark }
  body {
    margin: 0; height: 100vh; display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: 14px;
    font: 14px/1.5 -apple-system, "Segoe UI", system-ui, sans-serif;
    background: #fff; color: #1a1a1a;
  }
  @media (prefers-color-scheme: dark) { body { background: #1a1a1a; color: #f5f5f5 } }
  .name { font-size: 15px; font-weight: 600; letter-spacing: .2px }
  .status { opacity: .6 }
  .bar { width: 180px; height: 2px; border-radius: 2px; overflow: hidden; background: currentColor; opacity: .15 }
  .bar::after {
    content: ""; display: block; width: 40%; height: 100%; border-radius: 2px;
    background: currentColor; animation: slide 1.4s ease-in-out infinite;
  }
  @keyframes slide { 0% { transform: translateX(-100%) } 100% { transform: translateX(350%) } }
</style>
<body>
  <div class="name">${TITLE}</div>
  <div class="bar"></div>
  <div class="status">Starting the agent runtime…</div>
</body>
</html>`

/**
 * The splash page as a data URL.
 * @returns a `data:` URL holding the complete document.
 */
export function splashUrl(): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(DOCUMENT)}`
}

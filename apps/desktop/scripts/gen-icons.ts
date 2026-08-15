/**
 * Render the desktop application and tray icons from the Web client's fish
 * mark, so the packaged application, the browser tab, and the sidebar logo all
 * show one shape.
 *
 * Run: `node --import tsx apps/desktop/scripts/gen-icons.ts`. The rendered
 * bytes depend on the installed Chromium, so a regenerated icon changes the
 * digest `tests/packaging-config.spec.ts` pins; update that digest in the same
 * change, which is what makes an unintended icon swap fail.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

const desktopRoot = resolve(import.meta.dirname, '..')
const repositoryRoot = resolve(desktopRoot, '../..')
const markSource = resolve(repositoryRoot, 'apps/web/public/favicon.svg')

/**
 * macOS icon geometry: the artwork sits on a rounded plate inset in a
 * transparent square, which is what gives the Dock its uniform tile.
 */
const CANVAS = 1024
const PLATE_INSET = 100
const PLATE_RADIUS = 185
/** The mark's own box is wider than its ink, so it scales past the plate's optical margin. */
const PLATE_MARK = 700

/** Menu-bar template sizes: the standard point size and its Retina variant. */
const TRAY_SIZES = [16, 32] as const

/** One icon to render. */
interface IconTarget {
  /** Path written, relative to the desktop package. */
  readonly file: string
  /** Rendered square edge in pixels. */
  readonly size: number
  /** Draw the rounded plate behind the mark. */
  readonly plate: boolean
}

const TARGETS: readonly IconTarget[] = [
  { file: 'build/icon.png', size: CANVAS, plate: true },
  { file: 'resources/trayTemplate.png', size: TRAY_SIZES[0], plate: false },
  { file: 'resources/trayTemplate@2x.png', size: TRAY_SIZES[1], plate: false },
]

/**
 * Build the page that renders one icon.
 * @param mark - The fish mark's SVG source.
 * @param target - Geometry and plate choice for this icon.
 * @returns A complete HTML document sized to the icon.
 */
function iconDocument(mark: string, target: IconTarget): string {
  const markSize = target.plate ? PLATE_MARK : target.size
  const plate = target.plate
    ? `.plate {
        width: ${String(CANVAS - PLATE_INSET * 2)}px;
        height: ${String(CANVAS - PLATE_INSET * 2)}px;
        border-radius: ${String(PLATE_RADIUS)}px;
        background: #ffffff;
        display: flex;
        align-items: center;
        justify-content: center;
      }`
    : ''
  return `<!doctype html>
<style>
  html, body { margin: 0; padding: 0; background: transparent; }
  body {
    width: ${String(target.size)}px;
    height: ${String(target.size)}px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  ${plate}
  svg { width: ${String(markSize)}px; height: ${String(markSize)}px; display: block; }
</style>
<div class="${target.plate ? 'plate' : 'mark'}">${mark}</div>
`
}

async function main(): Promise<void> {
  const mark = await readFile(markSource, 'utf8')
  const browser = await chromium.launch()
  try {
    // The mark's own stylesheet turns the fish white under a dark scheme; the
    // icons are always the black mark, plated or transparent.
    const page = await browser.newPage({ colorScheme: 'light', deviceScaleFactor: 1 })
    for (const target of TARGETS) {
      await page.setViewportSize({ width: target.size, height: target.size })
      await page.setContent(iconDocument(mark, target))
      const png = await page.screenshot({ omitBackground: true, type: 'png' })
      const path = resolve(desktopRoot, target.file)
      await writeFile(path, png)
      console.log(`gen-icons: wrote ${target.file} (${String(target.size)}px)`)
    }
  } finally {
    await browser.close()
  }
}

await main()

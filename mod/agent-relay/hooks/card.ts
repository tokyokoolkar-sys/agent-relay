import type { ActivityEntry } from '../types'

// A card's look, apart from the mod: the rail of steps an agent has hopped through, built from its
// tool calls, and the card drawn as SVG. While the agent works, a light runs along the card's
// outline and the text shimmers in time with it; otherwise the card is still.

export type RailStep = { verb: string; count: number }

const VERBS: Record<string, string> = {
  read: 'Read',
  edit: 'Write',
  execute: 'Run',
  search: 'Search',
  fetch: 'Fetch',
  think: 'Think',
  delete: 'Delete',
  move: 'Move',
}
const QUESTION_TOOL = /question/i
const RAIL_SHOWN = 4
/** A step titled with its tool's name alone says nothing about what it touches. */
const BARE_TOOL = /^(read|write|edit|patch|shell|bash|search|grep|glob|list|fetch|question|task|todowrite)$/i

export const CARD_WIDTH = 280
const BASE_HEIGHT = 166
const PENDING_HEIGHT = 46
/** Room outside the outline for its glow. */
const INSET = 4
const PAD = INSET + 14
const CORNER = 14
const LOOP_SECONDS = 4
/** About how many characters fit the card's width, at each line's size. */
const FITS = { title: 30, meta: 38, target: 36, pending: 38 }

function verbOf(entry: ActivityEntry): string {
  const known = VERBS[entry.toolKind ?? '']
  if (known !== undefined) return known
  if (QUESTION_TOOL.test(entry.text)) return 'Ask'
  const word = /^[\p{L}\p{N}_-]+/u.exec(entry.text.trim())?.[0] ?? 'Step'

  return word.charAt(0).toUpperCase() + word.slice(1, 12).toLowerCase()
}

/** The steps in the order they happened; a tool used several times running is one step with a count. */
export function railOf(activity: readonly ActivityEntry[]): RailStep[] {
  const rail: RailStep[] = []
  for (const entry of activity) {
    if (entry.kind !== 'tool' || typeof entry.text !== 'string') continue
    const verb = verbOf(entry)
    const last = rail.at(-1)
    if (last?.verb === verb) last.count += 1
    else rail.push({ verb, count: 1 })
  }

  return rail
}

const stepText = (step: RailStep) => (step.count > 1 ? `${step.verb} ×${step.count}` : step.verb)

/** The rail on one line, for a surface without SVG; only the last few steps. */
export function railLine(rail: readonly RailStep[]): string {
  const shown = rail.slice(-RAIL_SHOWN).map(stepText).join(' › ')

  return rail.length > RAIL_SHOWN ? `… › ${shown}` : shown
}

/**
 * What a step's title is about, for the line under the rail: the title without its tool's name,
 * and a path as its last two parts ("Write: C:\repo\src\Login.tsx" is "src/Login.tsx"). A title
 * that is only a tool's name gives way to the file last touched.
 */
export function targetOf(title: string, lastFile = ''): string {
  if (BARE_TOOL.test(title.trim())) return lastFile
  const after = /^[A-Za-z_]+: (.+)$/.exec(title)?.[1] ?? title
  if (!/[\\/]/.test(after) || /\s/.test(after)) return after

  return after.split(/[\\/]+/).filter(Boolean).slice(-2).join('/')
}

/** Agent text goes into SVG markup: every character markup could read is escaped, and what XML refuses dropped. */
export function escapeXml(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]|[\ufffe\uffff]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function fit(text: string, max: number): string {
  const chars = Array.from(text)

  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text
}

export type CardLook = {
  title: string
  status: string
  /** 'alert' and 'good' colour the status word; the rest stays quiet. */
  tone: 'plain' | 'alert' | 'good'
  meta: string
  rail: readonly RailStep[]
  target: string
  numbers: string
  isWorking: boolean
  /** A question or permission in the air, and who is answering it. */
  pending?: { title: string; who: string }
}

export const cardHeight = (look: Pick<CardLook, 'pending'>) => BASE_HEIGHT + (look.pending !== undefined ? PENDING_HEIGHT : 0)

const RAIL_Y = 84

/** Where each shown step's dot sits on the rail. */
function railDots(look: CardLook) {
  const shown = look.rail.slice(-RAIL_SHOWN)
  const span = CARD_WIDTH - 2 * PAD - 36
  const gap = span / (RAIL_SHOWN - 1)

  return shown.map((step, i) => ({ step, x: PAD + 18 + i * gap, isCurrent: i === shown.length - 1 }))
}

/** One copy of the card's text. The steady copy is painted by class; the shimmer's copy, by its group. */
function lines(look: CardLook, isPainted: boolean): string {
  const cls = (name: string) => (isPainted ? ` class="${name}"` : '')
  const dots = railDots(look)
  const labels = dots.map(
    ({ step, x, isCurrent }) =>
      `<text x="${x}" y="${RAIL_Y + 22}" font-size="11" text-anchor="middle"${isCurrent ? ' font-weight="600"' : ''}${cls(isCurrent ? 'primary' : 'quiet')}>${escapeXml(fit(stepText(step), 10))}</text>`,
  )
  const pending =
    look.pending === undefined
      ? []
      : [
          `<text x="${PAD}" y="${BASE_HEIGHT - 8}" font-size="12"${cls('secondary')}>${escapeXml(fit(look.pending.title, FITS.pending))}</text>`,
          `<text x="${PAD}" y="${BASE_HEIGHT + 12}" font-size="12" font-weight="600"${cls('warn')}>${escapeXml(look.pending.who)}</text>`,
        ]

  return [
    `<text x="${PAD}" y="${INSET + 24}" font-size="15" font-weight="600"${cls('primary')}>${escapeXml(fit(look.title, FITS.title))}</text>`,
    `<text x="${PAD}" y="${INSET + 44}" font-size="12"${cls('quiet')}><tspan${cls(look.tone)}>${escapeXml(look.status)}</tspan> · ${escapeXml(fit(look.meta, Math.max(8, FITS.meta - look.status.length)))}</text>`,
    ...labels,
    `<text x="${PAD}" y="${RAIL_Y + 44}" font-size="12" font-family="ui-monospace,Consolas,monospace"${cls('secondary')}>${escapeXml(fit(look.target, FITS.target))}</text>`,
    `<text x="${PAD}" y="${RAIL_Y + 64}" font-size="12"${cls('quiet')}>${escapeXml(look.numbers)}</text>`,
    ...pending,
  ].join('')
}

/** The rail's line and dots; the current step's dot pulses while the agent works. */
function railShapes(look: CardLook): string {
  const dots = railDots(look)
  const first = dots[0]
  const last = dots.at(-1)
  if (first === undefined || last === undefined) return ''
  const before = look.rail.length > RAIL_SHOWN ? `<line x1="${PAD}" y1="${RAIL_Y}" x2="${first.x}" y2="${RAIL_Y}" class="trail" stroke-dasharray="3 4"/>` : ''
  const ahead = look.isWorking ? `<line x1="${last.x}" y1="${RAIL_Y}" x2="${CARD_WIDTH - PAD}" y2="${RAIL_Y}" class="trail" stroke-dasharray="3 4"/>` : ''
  const halo = look.isWorking
    ? `<circle cx="${last.x}" cy="${RAIL_Y}" r="8" class="node-now motion" opacity=".4"><animate attributeName="r" values="7;12;7" dur="2s" repeatCount="indefinite"/><animate attributeName="opacity" values=".45;.08;.45" dur="2s" repeatCount="indefinite"/></circle>`
    : ''

  return (
    before +
    ahead +
    `<line x1="${first.x}" y1="${RAIL_Y}" x2="${last.x}" y2="${RAIL_Y}" class="trail-done"/>` +
    halo +
    dots.map(({ x, isCurrent }) => `<circle cx="${x}" cy="${RAIL_Y}" r="${isCurrent ? 5.5 : 4}" class="${isCurrent ? 'node-now' : 'node'}"/>`).join('')
  )
}

/**
 * The card as an SVG document. Working: a band of light runs clockwise along the outline, and a
 * second copy of the text, painted by a gradient on the same clock, shimmers left to right while
 * the light is on the top edge and back while it is on the bottom. The viewer's reduced-motion
 * setting hides everything that moves. An SVG drawn isolated reads no theme of the page, so its
 * colours follow the colour scheme.
 */
export function cardSvg(look: CardLook): string {
  const height = cardHeight(look)
  const w = CARD_WIDTH - 2 * INSET
  const h = height - 2 * INSET
  const outline = `x="${INSET}" y="${INSET}" width="${w}" height="${h}" rx="${CORNER}"`
  // the share of the loop the light spends on the top edge, then the right one, measured along the outline
  const across = w / (2 * (w + h))
  const down = h / (2 * (w + h))
  const at = [0, across, across + down, 2 * across + down, 1].map(t => t.toFixed(3)).join(';')
  const sweepOut = CARD_WIDTH + 120
  const defs = look.isWorking
    ? `<linearGradient id="sweep" gradientUnits="userSpaceOnUse" x1="-120" x2="0" y1="0" y2="0">` +
      `<stop offset="0" class="light" stop-opacity="0"/><stop offset=".5" class="light" stop-opacity="1"/><stop offset="1" class="light" stop-opacity="0"/>` +
      `<animate attributeName="x1" values="-120;${CARD_WIDTH};${CARD_WIDTH};-120;-120" keyTimes="${at}" dur="${LOOP_SECONDS}s" repeatCount="indefinite"/>` +
      `<animate attributeName="x2" values="0;${sweepOut};${sweepOut};0;0" keyTimes="${at}" dur="${LOOP_SECONDS}s" repeatCount="indefinite"/>` +
      `</linearGradient>` +
      `<linearGradient id="wash" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="glow-stop" stop-opacity=".14"/><stop offset=".45" class="glow-stop" stop-opacity="0"/></linearGradient>` +
      `<filter id="soft" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="2.5"/></filter>`
    : ''
  const run = `<animate attributeName="stroke-dashoffset" values="100;0" dur="${LOOP_SECONDS}s" repeatCount="indefinite"/>`
  const glow = look.isWorking
    ? `<rect ${outline} fill="url(#wash)" class="motion"><animate attributeName="opacity" values="1;.45;1" dur="${LOOP_SECONDS}s" repeatCount="indefinite"/></rect>` +
      `<rect ${outline} pathLength="100" fill="none" class="glow motion" stroke-width="4" stroke-dasharray="16 84" stroke-linecap="round" filter="url(#soft)">${run}</rect>` +
      `<rect ${outline} pathLength="100" fill="none" class="glow-core motion" stroke-width="1.2" stroke-dasharray="10 90" stroke-linecap="round">${run}</rect>`
    : ''
  const sheen = look.isWorking ? `<g class="sheen motion" fill="url(#sweep)">${lines(look, false)}</g>` : ''
  const style =
    `text{font-family:system-ui,-apple-system,'Segoe UI',sans-serif}` +
    `.card{fill:#ffffff;stroke:#e6e4dc}.primary,.plain{fill:#1a1a18}.secondary{fill:#5f5e5a}.quiet{fill:#8a8983}.alert{fill:#a32d2d}.good{fill:#3b6d11}.warn{fill:#854f0b}` +
    `.light{stop-color:#000}.glow-stop{stop-color:#378add}.glow{stroke:#378add}.glow-core{stroke:#185fa5}` +
    `.node{fill:#85b7eb}.node-now{fill:#378add}.trail{stroke:#d3d1c7;fill:none}.trail-done{stroke:#b5d4f4;stroke-width:2}` +
    `@media (prefers-color-scheme:dark){.card{fill:#1f1f1e;stroke:#2e2e2c}.primary,.plain{fill:#f1efe8}.secondary{fill:#b4b2a9}.quiet{fill:#888780}.alert{fill:#f09595}.good{fill:#97c459}.warn{fill:#fac775}` +
    `.light{stop-color:#fff}.glow-stop{stop-color:#85b7eb}.glow{stroke:#378add}.glow-core{stroke:#b5d4f4}` +
    `.node{fill:#378add}.node-now{fill:#b5d4f4}.trail{stroke:#3a3a38}.trail-done{stroke:#185fa5}}` +
    `@media (prefers-reduced-motion:reduce){.motion{display:none}}`

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${height}" viewBox="0 0 ${CARD_WIDTH} ${height}" preserveAspectRatio="xMinYMin meet">` +
    `<style>${style}</style><defs>${defs}</defs><rect ${outline} class="card"/>${glow}${railShapes(look)}${lines(look, true)}${sheen}</svg>`
  )
}

// Max Planner: paste a village export, get the plan to max it.
// Pages are views switched by the URL hash: #start, #plan, #items, #compare, #about.
import type { GameData, GameEvent, Lane, MagicItem } from "@max-planner/gamedata";
import {
  DEFAULT_GEMS,
  DEFAULT_ITEM_RULES,
  gemCost,
  STRATEGIES,
  compareVillages,
  formatDuration,
  parseExport,
  type PlacedStep,
  type Plan,
  type Strategy,
  type Village,
} from "@max-planner/core";
import { makeContext } from "./context.ts";
import { DEMO_TAG, demoExport } from "./demo.ts";
import { FILES } from "./files.ts";
import { planVillage, type PlanInput, type PlanOutput, type PlanSettings } from "./planner.ts";
import { store, type SavedVillage } from "./store.ts";

const HOUR = 3600;
const DAY = 86_400;
const ctx = makeContext(FILES);
const { gd, items, events: gameEvents } = ctx;

// --- Settings and state ------------------------------------------------------------------------
const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const DEFAULTS: PlanSettings = {
  target: null,
  strategy: "balanced",
  goldPass: true,
  goldPassPct: null,
  offline: { on: true, from: "23:00", to: "07:00" },
  timeZone: localZone,
  helpers: true,
  stock: {},
  perMonth: {},
  enabled: null,
  rules: { ...DEFAULT_ITEM_RULES },
  gems: { ...DEFAULT_GEMS },
};
const saved = store.settings<PlanSettings>() ?? {};
const settings: PlanSettings = {
  ...DEFAULTS,
  ...saved,
  offline: { ...DEFAULTS.offline, ...(saved.offline ?? {}) },
  rules: { ...DEFAULTS.rules, ...(saved.rules ?? {}) },
  gems: { ...DEFAULTS.gems, ...(saved.gems ?? {}) },
};

type View = "start" | "plan" | "items" | "compare" | "about";
const VIEWS: View[] = ["start", "plan", "items", "compare", "about"];

const state = {
  /** The village being planned: its export text and where it came from. */
  text: null as string | null,
  source: null as null | "demo" | "saved",
  savedId: null as string | null,
  result: null as PlanOutput | null,
  planning: false,
  pasteError: null as string | null,
  selected: null as string | null,
  zoom: 1,
  showAll: false,
  laneFilter: "all" as "all" | Lane,
  compare: { a: "", b: "", pasted: "", out: null as null | { a?: PlanOutput; b?: PlanOutput } },
};

const persist = () => store.saveSettings(settings);

// --- The planner, in a worker when the browser allows -----------------------------------------
class Runner {
  private worker: Worker | null = null;
  private next = 1;
  private waiting = new Map<number, (o: PlanOutput) => void>();
  private failed = false;

  constructor() {
    this.start();
  }

  private start() {
    if (this.failed) return;
    try {
      const src = document.getElementById("worker-src")?.textContent;
      if (!src) throw new Error("No worker source in the page.");
      const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
      const w = new Worker(url);
      w.onmessage = (e: MessageEvent) => {
        const m = e.data as { kind: string; id?: number; out?: PlanOutput };
        if (m.kind !== "plan" || m.id === undefined) return;
        const done = this.waiting.get(m.id);
        this.waiting.delete(m.id);
        done?.(m.out!);
      };
      w.onerror = () => this.giveUp();
      w.postMessage({ kind: "init", files: FILES });
      this.worker = w;
    } catch {
      this.giveUp();
    }
  }

  /** Workers can be blocked; then plans run on the page, a little less smoothly. */
  private giveUp() {
    this.failed = true;
    this.worker?.terminate();
    this.worker = null;
    for (const done of this.waiting.values()) done({ ok: false, message: "retry" });
    this.waiting.clear();
  }

  /** Plans `input`. With `latestOnly`, any plan still running is dropped first. */
  plan(input: PlanInput, latestOnly: boolean): Promise<PlanOutput> {
    if (latestOnly && this.waiting.size > 0 && this.worker) {
      this.worker.terminate();
      this.waiting.clear();
      this.worker = null;
      this.start();
    }
    if (!this.worker) {
      return new Promise((resolve) => setTimeout(() => resolve(planVillage(ctx, input)), 0));
    }
    const id = this.next++;
    return new Promise((resolve) => {
      this.waiting.set(id, (out) => {
        if (!out.ok && out.message === "retry") resolve(planVillage(ctx, input));
        else resolve(out);
      });
      this.worker!.postMessage({ kind: "plan", id, input });
    });
  }
}
const planner = new Runner();
const comparer = new Runner();

let planSeq = 0;
let planTimer = 0;
function replan(delay = 80) {
  clearTimeout(planTimer);
  if (!state.text) return;
  state.planning = true;
  renderHeadline();
  renderBoostBar();
  planTimer = window.setTimeout(async () => {
    const seq = ++planSeq;
    const input: PlanInput = {
      text: state.text!,
      settings: structuredClone(settings),
      ...(state.source === "demo" ? {} : { now: Math.floor(Date.now() / 1000) }),
    };
    const out = await planner.plan(input, true);
    if (seq !== planSeq) return;
    state.planning = false;
    state.result = out;
    if (out.ok && settings.target !== out.target) settings.target = out.target;
    renderPlan();
    renderItems();
  }, delay);
}

// --- Loading villages ------------------------------------------------------------------------
function openDemo() {
  state.text = demoExport(gd, Math.floor(Date.now() / 1000 / HOUR) * HOUR);
  state.source = "demo";
  state.savedId = null;
  settings.target = null;
  afterOpen();
}

function openText(text: string): string | null {
  const parsed = parseExport(text, gd, { now: Math.floor(Date.now() / 1000) });
  if (!parsed.ok) return parsed.error.message;
  const v = parsed.village;
  const tag =
    typeof JSON.parse(text).tag === "string" ? (JSON.parse(text).tag as string) : "Village";
  const s = store.saveVillage(
    { tag, townHall: v.townHall, exportedAt: v.exportedAt, text },
    Date.now() / 1000,
  );
  openSaved(s);
  return null;
}

function openSaved(s: SavedVillage) {
  state.text = s.text;
  state.source = "saved";
  state.savedId = s.id;
  store.setCurrent(s.id);
  settings.target = null;
  afterOpen();
}

function afterOpen() {
  state.result = null;
  state.selected = null;
  state.showAll = false;
  persist();
  go("plan");
  replan(0);
}

// --- Formatting ------------------------------------------------------------------------------
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const num = new Intl.NumberFormat();
const fmt = (o: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat(undefined, { timeZone: settings.timeZone, ...o });
const when = (t: number) =>
  fmt({
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(t * 1000));
const day = (t: number) =>
  fmt({ day: "numeric", month: "short", year: "numeric" }).format(new Date(t * 1000));
const span = (seconds: number) => (seconds <= 0 ? "0m" : formatDuration(seconds));
const daysText = (seconds: number) => {
  const d = seconds / DAY;
  return d >= 10 ? `${Math.round(d)}` : d >= 1 ? d.toFixed(1) : (seconds / HOUR).toFixed(1);
};
const daysUnit = (seconds: number) => (seconds >= DAY ? "days" : "hours");
const LANE_NAME: Record<Lane, string> = {
  builder: "Builder",
  lab: "Laboratory",
  petHouse: "Pet House",
};
const REASON: Record<PlacedStep["reason"], string> = {
  running: "Already running in your export",
  critical: "On the critical path: delaying it delays the finish",
  value: "Best value per hour for your strategy, with time to spare",
  "only-ready": "The only upgrade that could start then",
  instant: "Takes no time, so it happens as soon as it can",
  hammer: "Finished by a hammer the moment a worker was free",
};
const BOTTLENECK_SHORT: Record<string, string> = {
  lab: "Laboratory",
  petHouse: "Pet House",
  chain: "Longest chain",
  builders: "Builders",
};
function itemsTile(r: Ok) {
  if (!r.hasItems)
    return `<a class="stat" href="#items"><span>Magic items</span><b>Add yours</b></a>`;
  if (r.savedSeconds > 0)
    return `<a class="stat good" href="#items"><span>Magic items save</span><b>${span(r.savedSeconds)}</b></a>`;
  return `<a class="stat" href="#items" title="With this plan, using your items does not bring the max date forward."><span>Magic items</span><b>No change</b></a>`;
}
function gemsTile(r: Ok) {
  if (!r.hasGems) return `<a class="stat" href="#items"><span>Gems</span><b>Add yours</b></a>`;
  if (r.gemsSaved > 0)
    return `<a class="stat good" href="#items"><span>Gems save</span><b>${span(r.gemsSaved)}</b></a>`;
  return `<a class="stat" href="#items" title="No upgrade on the path that sets your max date is long or cheap enough for your gems yet."><span>Gems</span><b>No change</b></a>`;
}
const gemBody = `<path d="M7 4h10l4 5-9 11L3 9z" fill="var(--gem)" opacity=".9"/><path d="M3 9h18M9 4l3 16M15 4l-3 16" stroke="var(--surface)" stroke-width="1" fill="none" opacity=".7"/>`;
const gemGlyph = `<svg class="glyph" viewBox="0 0 24 24" aria-hidden="true">${gemBody}</svg>`;
const itemName = (id: string) => items.find((i) => i.id === id)?.name ?? id;

function stepName(g: GameData, p: { entityId: number; instance: number; toLevel: number }) {
  const e = g.entity(p.entityId);
  const many = g.countAt(p.entityId, g.maxTownHall) > 1 || p.instance > 0;
  return `${e?.name ?? `#${p.entityId}`}${many ? ` #${p.instance + 1}` : ""} → lv ${p.toLevel}`;
}
function workerName(plan: Plan, index: number | null) {
  if (index === null) return "No worker";
  const w = plan.workers[index]!;
  if (w.lane !== "builder") return LANE_NAME[w.lane];
  return w.closesAt !== undefined ? "Extra builder" : `Builder ${w.index + 1}`;
}

function glyph(item: MagicItem): string {
  return `<svg class="glyph" viewBox="0 0 24 24" aria-hidden="true">${glyphBody(item)}</svg>`;
}

/** The inside of an item's 24×24 icon, to draw it in a page or inside a chart. */
function glyphBody(item: MagicItem): string {
  const tone =
    item.kind === "potion"
      ? item.lanes?.[0] === "lab"
        ? "var(--elixir)"
        : item.lanes?.[0] === "petHouse"
          ? "var(--pet)"
          : "var(--gold)"
      : item.id.includes("everything")
        ? "var(--ink)"
        : item.categories?.some((c) => c === "hero" || c === "pet")
          ? "var(--pet)"
          : item.categories?.some((c) => c === "troop" || c === "spell" || c === "siege")
            ? "var(--elixir)"
            : "var(--gold)";
  const body =
    item.kind === "potion"
      ? `<path d="M9 3h6v4l4 7a5 5 0 0 1-4.5 7h-5A5 5 0 0 1 5 14l4-7z" fill="${tone}" opacity=".9"/><path d="M8 3h8" stroke="var(--ink)" stroke-width="1.5"/>`
      : item.kind === "book"
        ? `<rect x="5" y="3" width="14" height="18" rx="2" fill="${tone}" opacity=".9"/><path d="M8 3v18" stroke="var(--surface)" stroke-width="1.5"/>`
        : `<rect x="4" y="4" width="13" height="6" rx="1.5" fill="${tone}" opacity=".9"/><rect x="9.5" y="9" width="3" height="12" rx="1" fill="var(--ink)" opacity=".75"/>`;
  return body;
}

const $ = (id: string) => document.getElementById(id)!;

// --- Routing ---------------------------------------------------------------------------------
function current(): View {
  const h = location.hash.slice(1) as View;
  return VIEWS.includes(h) ? h : state.text ? "plan" : "start";
}
function go(view: View) {
  if (location.hash.slice(1) !== view) location.hash = view;
  else show();
}
function show() {
  const view = current();
  for (const v of VIEWS) $(`view-${v}`).classList.toggle("active", v === view);
  for (const a of document.querySelectorAll<HTMLAnchorElement>("[data-nav]")) {
    const v = a.dataset.nav as View;
    if (v === view) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
    a.classList.toggle("disabled", !state.text && (v === "plan" || v === "items"));
  }
  if (view === "start") renderStart();
  if (view === "plan") renderPlan();
  if (view === "items") renderItems();
  if (view === "compare") renderCompare();
  window.scrollTo({ top: 0 });
}

type Ok = Extract<PlanOutput, { ok: true }>;
const ok = (): Ok | null => (state.result && state.result.ok ? state.result : null);

// --- Start -----------------------------------------------------------------------------------
const ICONS = {
  builders: `<svg viewBox="0 0 44 44" aria-hidden="true"><rect x="2" y="2" width="40" height="40" rx="12" fill="var(--gold)" stroke="var(--outline)" stroke-width="2"/><path d="M12 15h14l3 4h-17z" fill="#2a1d3f"/><rect x="18" y="19" width="5" height="15" rx="2" fill="#2a1d3f"/></svg>`,
  lab: `<svg viewBox="0 0 44 44" aria-hidden="true"><rect x="2" y="2" width="40" height="40" rx="12" fill="var(--elixir)" stroke="var(--outline)" stroke-width="2"/><path d="M18 10h8M19 10v8l-7 12a3 3 0 0 0 3 4h14a3 3 0 0 0 3-4l-7-12v-8" fill="none" stroke="#fff" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/><path d="M15 27h14l2 4H13z" fill="#fff"/></svg>`,
  helpers: `<svg viewBox="0 0 44 44" aria-hidden="true"><rect x="2" y="2" width="40" height="40" rx="12" fill="var(--pet)" stroke="var(--outline)" stroke-width="2"/><circle cx="22" cy="24" r="10" fill="none" stroke="#fff" stroke-width="3"/><path d="M22 24v-5M22 24l4 3M19 10h6" stroke="#fff" stroke-width="3" stroke-linecap="round"/></svg>`,
  gems: `<svg viewBox="0 0 44 44" aria-hidden="true"><rect x="2" y="2" width="40" height="40" rx="12" fill="var(--gem)" stroke="var(--outline)" stroke-width="2"/><path d="M15 12h14l6 8-13 14L9 20z" fill="#fff"/><path d="M9 20h26M18 12l4 22 4-22" fill="none" stroke="var(--gem)" stroke-width="1.6"/></svg>`,
  events: `<svg viewBox="0 0 44 44" aria-hidden="true"><rect x="2" y="2" width="40" height="40" rx="12" fill="var(--surface)" stroke="var(--outline)" stroke-width="2"/><rect x="10" y="12" width="24" height="21" rx="4" fill="none" stroke="var(--ink)" stroke-width="3"/><path d="M10 19h24M16 9v6M28 9v6" stroke="var(--ink)" stroke-width="3" stroke-linecap="round"/><rect x="15" y="23" width="6" height="5" rx="1" fill="var(--elixir)"/></svg>`,
  sleep: `<svg viewBox="0 0 44 44" aria-hidden="true"><rect x="2" y="2" width="40" height="40" rx="12" fill="#2a1d3f" stroke="var(--outline)" stroke-width="2"/><path d="M27 31a11 11 0 0 1-9-17 11 11 0 1 0 13 14 11 11 0 0 1-4 3z" fill="#f4b321"/></svg>`,
};

const FEATURES: [keyof typeof ICONS, string, string][] = [
  [
    "builders",
    "Every builder kept busy",
    "Each upgrade left is booked onto a builder, in the order that finishes soonest.",
  ],
  [
    "lab",
    "Research and pets alongside",
    "The Laboratory and Pet House run at the same time, pausing only while their own building upgrades.",
  ],
  [
    "helpers",
    "Helpers and the Gold Pass",
    "Your Builder's Apprentice and Lab Assistant come from the export. The Gold Pass boost grows over the season.",
  ],
  [
    "gems",
    "Items and gems where they count",
    "Potions, books, hammers and gems go to the upgrades that bring your max date forward.",
  ],
  [
    "events",
    "Events on the calendar",
    "Hammer Jam discounts and hero-free war weeks are part of the plan.",
  ],
  [
    "sleep",
    "Nothing starts while you sleep",
    "Set your offline hours and time zone, and upgrades start when you are back.",
  ],
];

/** A small plan board for the start page: the demo village, planned for real. */
let preview: Ok | null = null;
let previewAsked = false;
function askPreview() {
  if (previewAsked) return;
  previewAsked = true;
  const text = demoExport(gd, Math.floor(Date.now() / 1000 / HOUR) * HOUR);
  const own = { ...structuredClone(DEFAULTS), timeZone: localZone };
  void comparer.plan({ text, settings: own }, false).then((out) => {
    if (!out.ok) return;
    preview = out;
    const el = document.getElementById("board");
    if (el) el.outerHTML = boardHtml();
  });
}

function boardHtml(): string {
  const r = preview;
  // Narrow screens get a narrower drawing, so its labels stay readable.
  const W = Math.round(Math.max(300, Math.min(560, (window.innerWidth || 560) - 76)));
  const labelW = 70;
  const rowH = 15;
  const gap = 7;
  const top = 18;
  if (!r) {
    const rows = [
      "Builder 1",
      "Builder 2",
      "Builder 3",
      "Builder 4",
      "Builder 5",
      "Laboratory",
      "Pet House",
    ];
    const h = top + rows.length * (rowH + gap);
    return `<figure class="board" id="board" aria-busy="true">
      <div class="board-top"><div class="board-days"><b>…</b><span>days to max</span></div><p class="board-who">Example village<br/>Planning it now</p></div>
      <svg viewBox="0 0 ${W} ${h}" role="img" aria-label="Planning the example village">${rows
        .map(
          (name, i) =>
            `<text class="lane-name" x="0" y="${top + i * (rowH + gap) + 11}">${name}</text><rect class="lane-bg" x="${labelW}" y="${top + i * (rowH + gap)}" width="${W - labelW}" height="${rowH}" rx="5"/>`,
        )
        .join("")}</svg>
      <figcaption>A made-up village, planned on the real game data.</figcaption>
    </figure>`;
  }
  const plan = r.plan;
  const maxed = plan.halls.at(-1)?.maxedAt ?? plan.finish;
  const lanes = plan.workers.map((_, i) => i).filter((i) => plan.steps.some((p) => p.worker === i));
  const h = top + lanes.length * (rowH + gap);
  const t0 = plan.start;
  const x = (t: number) => labelW + ((t - t0) / (maxed - t0)) * (W - labelW);
  const parts: string[] = [];
  const monthFmt = fmt({ month: "short" });
  const d = new Date(t0 * 1000);
  for (let m = 1; m < 40; m += 1) {
    const at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + m, 1) / 1000;
    if (at >= maxed) break;
    const step = Math.max(1, Math.round((maxed - t0) / (30 * DAY) / 6));
    if (m % step) continue;
    parts.push(
      `<text class="tick" x="${x(at) + 2}" y="10">${esc(monthFmt.format(new Date(at * 1000)))}</text>`,
    );
  }
  const bars: string[] = [];
  lanes.forEach((w, k) => {
    const y = top + k * (rowH + gap);
    parts.push(
      `<text class="lane-name" x="0" y="${y + 11}">${esc(workerName(plan, w))}</text><rect class="lane-bg" x="${labelW}" y="${y}" width="${W - labelW}" height="${rowH}" rx="5"/>`,
    );
    for (const p of plan.steps) {
      if (p.worker !== w || p.end <= p.start) continue;
      const cls = p.lane === "builder" ? "b" : p.lane === "lab" ? "l" : "p";
      bars.push(
        `<rect class="${cls}" x="${x(p.start).toFixed(1)}" y="${y}" width="${Math.max(0.8, x(p.end) - x(p.start) - 0.6).toFixed(1)}" height="${rowH}" rx="3"/>`,
      );
    }
  });
  return `<figure class="board" id="board">
    <div class="board-top">
      <div class="board-days"><b>${daysText(maxed - t0)}</b><span>${daysUnit(maxed - t0)} to max</span></div>
      <p class="board-who">Example village<br/>Town Hall ${r.village.townHall}, ${r.village.builders} builders</p>
    </div>
    <svg viewBox="0 0 ${W} ${h}" role="img" aria-label="Example plan: every builder, the Laboratory and the Pet House busy until ${esc(day(maxed))}">${parts.join("")}<g class="bars">${bars.join("")}</g></svg>
    <figcaption>A made-up village, planned on the real game data: gold is builders, pink the Laboratory, teal the Pet House. Maxed ${esc(day(maxed))}.</figcaption>
  </figure>`;
}

function renderStart() {
  const list = store.villages();
  askPreview();
  $("view-start").innerHTML = `
    <div class="narrow landing">
      <section class="landing-hero">
        <div class="hero-copy">
          <h2 class="hero-title">How many days until your village is maxed?</h2>
          <p class="hero-lede">Paste your Clash of Clans export. Max Planner books every upgrade left onto your builders, Laboratory and Pet House, and gives you the day each Town Hall is done.</p>
          <div class="row wrap">
            <button class="button primary big" type="button" data-action="focus-paste">Paste my export</button>
            <button class="button big" type="button" data-action="demo">Try the demo village</button>
          </div>
          <p class="muted small">Runs in your browser. Your export never leaves it.</p>
        </div>
        ${boardHtml()}
      </section>
      ${
        list.length
          ? `<section class="card">
              <h2>Your villages</h2>
              <ul class="saved">${list
                .map(
                  (v) => `<li>
                  <span><span class="name">${esc(v.tag)}, Town Hall ${v.townHall}</span><span class="muted small block">Exported ${esc(day(v.exportedAt))}</span></span>
                  <button class="button" type="button" data-action="open" data-item="${esc(v.id)}">Open</button>
                  <button class="link" type="button" data-action="remove" data-item="${esc(v.id)}" aria-label="Remove ${esc(v.tag)} exported ${esc(day(v.exportedAt))}">Remove</button>
                </li>`,
                )
                .join("")}</ul>
            </section>`
          : ""
      }
      <section class="card paste-card" id="paste">
        <div class="paste-steps">
          <h2>Plan your village</h2>
          <ol class="steps">
            <li><span>In Clash of Clans, open <strong>Settings</strong>.</span></li>
            <li><span>Tap <strong>More Settings</strong>, then <strong>Data Export</strong>, then <strong>Copy</strong>.</span></li>
            <li><span>Paste it here and tap <strong>Plan my village</strong>.</span></li>
          </ol>
        </div>
        <div class="paste-box">
          <label class="field" for="paste-text">Your village export
            <textarea id="paste-text" rows="7" spellcheck="false" placeholder='{"tag":"#…","timestamp":…,"buildings":[…]}'></textarea>
          </label>
          ${state.pasteError ? `<p class="error small">${esc(state.pasteError)}</p>` : ""}
          <div class="row wrap"><button class="button primary" type="button" data-action="paste-plan">Plan my village</button></div>
          <p class="muted small">Each export you plan is kept in this browser, so you can export again later and compare.</p>
        </div>
      </section>
      <section class="card">
        <h2>What the plan accounts for</h2>
        <ul class="features">${FEATURES.map(([icon, title, text]) => `<li>${ICONS[icon]}<div><strong>${title}</strong><p>${text}</p></div></li>`).join("")}</ul>
      </section>
    </div>`;
}

// --- Plan ------------------------------------------------------------------------------------

function renderPlan() {
  if (!state.text) {
    $("headline").innerHTML =
      `<div class="empty"><p>No village yet.</p><a class="button primary" href="#start">Paste an export</a></div>`;
    for (const id of ["village", "controls", "halls", "timeline", "details", "upcoming", "report"])
      $(id).innerHTML = "";
    return;
  }
  renderHeadline();
  renderRail();
  const r = ok();
  if (!r) {
    for (const id of ["halls", "timeline", "details", "upcoming", "report"]) $(id).innerHTML = "";
    return;
  }
  renderHalls(r);
  renderTimeline(r);
  renderDetails(r);
  renderUpcoming(r);
  renderReport(r);
}

function ring(fraction: number, num: string, unit: string): string {
  const C = 2 * Math.PI * 70;
  const done = Math.max(0, Math.min(1, fraction)) * C;
  return `<svg class="ring" viewBox="0 0 168 168" aria-hidden="true">
    <circle class="track" cx="84" cy="84" r="70"/>
    ${done > 0 ? `<circle class="done" cx="84" cy="84" r="70" stroke-dasharray="${done.toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 84 84)"/>` : ""}
    <text class="num" x="84" y="92">${esc(num)}</text>
    <text class="unit" x="84" y="116">${esc(unit)}</text>
  </svg>`;
}

const dateLong = (t: number) =>
  fmt({ weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(
    new Date(t * 1000),
  );
const clock = (t: number) => fmt({ hour: "2-digit", minute: "2-digit" }).format(new Date(t * 1000));

function renderHeadline() {
  const el = $("headline");
  if (!state.text) return;
  const r = state.result;
  if (!r) {
    el.innerHTML = `<div class="headline">${ring(0, "…", "days left")}<div class="head-copy"><p class="eyebrow">Planning your village</p><h2 class="busy">Working out every upgrade</h2></div></div>`;
    return;
  }
  if (!r.ok) {
    el.innerHTML = `<div class="error"><h2>That export could not be planned</h2><p>${esc(r.message)}</p><p><a href="#start">Paste another export</a></p></div>`;
    return;
  }
  const plan = r.plan;
  const maxed = plan.halls.at(-1)?.maxedAt ?? plan.finish;
  const left = maxed - plan.start;
  const pct = Math.round(r.progress.fraction * 1000) / 10;
  const upgrades = plan.steps.filter((s) => s.reason !== "running").length;
  const tiles = [
    `<div class="stat"><span>Upgrades left</span><b>${num.format(upgrades)}</b>${r.totals.walls.upgrades ? `<span>and ${num.format(r.totals.walls.upgrades)} wall levels</span>` : ""}</div>`,
    `<div class="stat" title="Without helpers, the Gold Pass or items, no plan could finish in under ${span(r.lowerBound.seconds)}."><span>Sets the date</span><b>${esc(BOTTLENECK_SHORT[r.lowerBound.bottleneck] ?? "Builders")}</b></div>`,
    itemsTile(r),
    gemsTile(r),
  ];
  el.innerHTML = `
    <div class="headline">
      ${ring(r.progress.fraction, daysText(left), `${daysUnit(left)} left`)}
      <div class="head-copy">
        <p class="eyebrow">Town Hall ${r.target} maxed on ${state.planning ? `<span class="busy">updating</span>` : ""}</p>
        <h2>${esc(dateLong(maxed))}</h2>
        <p class="muted"><strong>${pct}%</strong> of the way there. The last upgrade ends at ${esc(clock(maxed))}.</p>
      </div>
    </div>
    <div class="stats">${tiles.join("")}</div>
    <p class="muted small">From your export of ${esc(when(r.village.exportedAt))}. Planned in ${r.ms} ms with ${r.runs} scheduler runs${r.stoppedEarly ? ", stopped at the time limit" : ""}.</p>`;
}

function renderRail() {
  const r = ok();
  const village = r?.village;
  const isDemo = state.source === "demo";
  $("village").innerHTML = `
    <div class="village-top">
      <div>
        <p class="eyebrow">${isDemo ? "Demo village, made up" : "Your village"}</p>
        <h2>${village ? `Town Hall ${village.townHall}` : "…"}</h2>
      </div>
      ${village ? `<span class="chip">${village.builders} builders</span>` : ""}
    </div>
    ${village && !isDemo ? `<p class="muted small">${esc(r!.report.warnings.find((w) => w.code === "stale_export") ? "This export is over a week old: export again for an up-to-date plan." : `Exported ${when(village.exportedAt)}`)}</p>` : ""}
    ${isDemo ? `<p class="muted small">A made-up Town Hall 14 base with the real game's numbers.</p>` : ""}
    <a class="button" href="#start">Plan another export</a>`;

  const halls: number[] = [];
  if (village) for (let h = village.townHall; h <= gd.maxTownHall; h++) halls.push(h);
  const zones = timeZones();
  $("controls").innerHTML = `
    <fieldset class="field">
      <legend>Target Town Hall</legend>
      <div class="seg" role="group">
        ${halls.map((h) => `<button type="button" data-action="target" data-value="${h}" aria-pressed="${h === settings.target}">TH${h}</button>`).join("") || `<span class="muted small">Planning…</span>`}
      </div>
    </fieldset>
    <fieldset class="field">
      <legend>Strategy</legend>
      <div class="seg" role="group">
        ${STRATEGIES.map((s) => `<button type="button" data-action="strategy" data-value="${s}" aria-pressed="${s === settings.strategy}">${s === "offense" ? "Offense first" : s === "defense" ? "Defense first" : "Balanced"}</button>`).join("")}
      </div>
      <p class="muted small">The fastest plan always wins; strategy orders what can move without costing time.</p>
    </fieldset>
    <label class="toggle" for="helpers"><input type="checkbox" id="helpers" data-bind="helpers" ${settings.helpers ? "checked" : ""}/> <span>Use my Builder's Apprentice and Lab Assistant</span></label>
    <label class="toggle" for="goldpass"><input type="checkbox" id="goldpass" data-bind="goldpass" ${settings.goldPass ? "checked" : ""}/> <span>I buy the Gold Pass</span></label>
    <fieldset class="field">
      <legend>When you are offline</legend>
      <label class="toggle" for="offline-on"><input type="checkbox" id="offline-on" data-bind="offline-on" ${settings.offline.on ? "checked" : ""}/> <span>No upgrades start while I sleep</span></label>
      <div class="row">
        <label class="field" for="offline-from">From <input id="offline-from" type="time" value="${settings.offline.from}" data-bind="offline-from" ${settings.offline.on ? "" : "disabled"}/></label>
        <label class="field" for="offline-to">To <input id="offline-to" type="time" value="${settings.offline.to}" data-bind="offline-to" ${settings.offline.on ? "" : "disabled"}/></label>
      </div>
      <label class="field" for="tz">Time zone
        <select id="tz" data-bind="tz">${zones.map((z) => `<option ${z === settings.timeZone ? "selected" : ""}>${esc(z)}</option>`).join("")}</select>
      </label>
    </fieldset>`;
}

function timeZones(): string[] {
  const list =
    (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.(
      "timeZone",
    ) ?? [];
  return [...new Set([settings.timeZone, localZone, "UTC", ...list])];
}

function renderHalls(r: Ok) {
  const plan = r.plan;
  $("halls").innerHTML = plan.halls
    .map(
      (h) => `<li class="hall">
        <span class="hall-badge">TH${h.townHall}</span>
        <span><span class="muted small">Reached</span> ${h.reachedAt === null ? "—" : h.reachedAt === plan.start ? "now" : esc(day(h.reachedAt))}</span>
        <span><span class="muted small">Maxed</span> <strong>${h.maxedAt === null ? "—" : esc(day(h.maxedAt))}</strong></span>
      </li>`,
    )
    .join("");
}

function niceTick(range: number, target = 8): number {
  const steps = [
    HOUR,
    3 * HOUR,
    6 * HOUR,
    12 * HOUR,
    DAY,
    2 * DAY,
    7 * DAY,
    14 * DAY,
    30 * DAY,
    61 * DAY,
    91 * DAY,
    182 * DAY,
    365 * DAY,
  ];
  return steps.find((s) => range / s <= target) ?? 730 * DAY;
}

function renderTimeline(r: Ok) {
  const plan = r.plan;
  const host = $("timeline");
  const labelW = 104;
  const rowH = 26;
  const gap = 6;
  // Rows from the top: dates, then item and gem uses if there are any, then the workers.
  const dateH = 22;
  const marks = [
    ...plan.itemUses.map((u) => {
      const item = items.find((i) => i.id === u.item);
      return {
        at: u.at,
        body: item ? glyphBody(item) : "",
        title: `${itemName(u.item)}: ${when(u.at)}, saves ${span(u.savedSeconds)}`,
      };
    }),
    ...plan.gemUses.map((g) => {
      const step = plan.steps.find((s) => s.id === g.stepId);
      return {
        at: g.at,
        body: gemBody,
        title: `${num.format(g.gems)} gems${step ? ` on ${stepName(gd, step)}` : ""}: ${when(g.at)}, saves ${span(g.savedSeconds)}`,
      };
    }),
  ];
  const markH = marks.length ? 30 : 0;
  const top = dateH + markH + 6;
  const lanes = plan.workers
    .map((_, i) => i)
    .filter((i) => plan.steps.some((p) => p.worker === i || p.holds === i));
  const height = top + lanes.length * (rowH + gap) + 4;
  const width = Math.max(560, (host.clientWidth || 720) - 34) * state.zoom;
  const t0 = plan.start;
  const t1 = Math.max(plan.finish, t0 + 6 * HOUR);
  const x = (t: number) => labelW + ((t - t0) / (t1 - t0)) * (width - labelW - 8);
  const rowY = new Map(lanes.map((i, k) => [i, top + k * (rowH + gap)]));
  const parts: string[] = [];
  const lanesTop = top - 3;
  const lanesH = height - lanesTop - 2;
  // Event windows and offline nights shade the workers' rows behind the bars.
  const shown = { sale: false, block: false, night: false };
  for (const w of r.windows) {
    if (w.end <= t0 || w.start >= t1) continue;
    const a = x(Math.max(w.start, t0));
    const b = x(Math.min(w.end, t1));
    const kind = w.effect.kind === "discount" ? "sale" : "block";
    shown[kind] = true;
    parts.push(
      `<rect class="event ${kind}" x="${a}" y="${lanesTop}" width="${Math.max(1, b - a)}" height="${lanesH}"><title>${esc(w.name)}</title></rect>`,
    );
  }
  // Nights only once each is wider than a pixel.
  if ((t1 - t0) / (width - labelW) < 6 * HOUR) {
    for (const [a, b] of r.offline) {
      if (b <= t0 || a >= t1) continue;
      shown.night = true;
      parts.push(
        `<rect class="night" x="${x(Math.max(a, t0))}" y="${lanesTop}" width="${Math.max(0.5, x(Math.min(b, t1)) - x(Math.max(a, t0)))}" height="${lanesH}"/>`,
      );
    }
  }
  const tick = niceTick(t1 - t0);
  const tickFmt =
    tick >= DAY
      ? fmt(
          tick >= 30 * DAY
            ? { month: "short", year: "numeric" }
            : { day: "numeric", month: "short" },
        )
      : fmt({ hour: "2-digit", minute: "2-digit" });
  for (let t = Math.ceil(t0 / tick) * tick; t <= t1; t += tick) {
    // A label too near the right edge would be cut off; its line still shows.
    const room = width - x(t) > 64;
    parts.push(
      `<line class="grid" x1="${x(t)}" x2="${x(t)}" y1="${dateH - 4}" y2="${height - 2}"/>${room ? `<text class="tick" x="${x(t) + 4}" y="14">${esc(tickFmt.format(new Date(t * 1000)))}</text>` : ""}`,
    );
  }
  if (marks.length) {
    const cy = dateH + markH / 2;
    const both = plan.itemUses.length && plan.gemUses.length;
    parts.push(
      `<text class="row-label" x="0" y="${cy + 4}">${both ? "Items, gems" : plan.gemUses.length ? "Gems used" : "Items used"}</text>`,
    );
    // Each use is drawn as its item's icon. Icons that would overlap are nudged right so
    // each stays readable; the tooltip gives the exact time.
    const size = 18;
    let lastX = -Infinity;
    for (const m of [...marks].sort((a, b) => a.at - b.at)) {
      const mx = Math.max(x(m.at) - size / 2, lastX + size + 3);
      lastX = mx;
      parts.push(
        `<g class="mark"><title>${esc(m.title)}</title><rect class="mark-bg" x="${mx - 1}" y="${cy - size / 2 - 1}" width="${size + 2}" height="${size + 2}" rx="5"/><svg x="${mx}" y="${cy - size / 2}" width="${size}" height="${size}" viewBox="0 0 24 24">${m.body}</svg></g>`,
      );
    }
  }
  for (const i of lanes) {
    const y = rowY.get(i)!;
    parts.push(
      `<text class="lane-label" x="0" y="${y + rowH / 2 + 4}">${esc(workerName(plan, i))}</text>`,
    );
    parts.push(
      `<rect class="lane-bg" x="${labelW}" y="${y}" width="${width - labelW - 8}" height="${rowH}" rx="4"/>`,
    );
    for (const p of plan.steps) {
      if (p.holds === i) {
        parts.push(
          `<rect class="held" x="${x(p.start)}" y="${y}" width="${Math.max(1, x(p.end) - x(p.start))}" height="${rowH}" rx="4"><title>${esc(`Waiting while ${stepName(gd, p)} upgrades`)}</title></rect>`,
        );
      }
      if (p.worker !== i) continue;
      const wPx = Math.max(1.5, x(p.end) - x(p.start));
      const cls = [
        "block",
        p.lane,
        p.hall ? "hall" : "",
        p.reason === "running" ? "running" : "",
        state.selected === p.id ? "selected" : "",
      ].join(" ");
      const label =
        wPx > 80
          ? `<text class="block-label ${p.lane}" x="${x(p.start) + 5}" y="${y + rowH / 2 + 4}">${esc(stepName(gd, p))}</text>`
          : "";
      const finishedBy = p.item
        ? `, finished with ${itemName(p.item)}`
        : p.gems
          ? `, finished with ${num.format(p.gems)} gems`
          : "";
      parts.push(
        `<g class="hit" data-action="select" data-step="${esc(p.id)}" tabindex="0" role="button" aria-label="${esc(stepName(gd, p))}"><rect class="${cls}" x="${x(p.start)}" y="${y}" width="${wPx}" height="${rowH}" rx="4"><title>${esc(`${stepName(gd, p)}: ${when(p.start)} to ${when(p.end)}${finishedBy}`)}</title></rect>${label}</g>`,
      );
    }
  }
  const legend = [
    `<span><i class="key builder"></i>Builders</span>`,
    `<span><i class="key lab"></i>Laboratory</span>`,
    `<span><i class="key petHouse"></i>Pet House</span>`,
    shown.night ? `<span><i class="key night"></i>Offline</span>` : "",
    shown.sale ? `<span><i class="key sale"></i>Event discount</span>` : "",
    shown.block ? `<span><i class="key hold"></i>No hero upgrades</span>` : "",
    plan.itemUses.length
      ? `<span><svg class="key-icon" viewBox="0 0 24 24" aria-hidden="true">${glyphBody(items.find((i) => i.id === plan.itemUses[0]!.item) ?? items[0]!)}</svg>Item used</span>`
      : "",
    plan.gemUses.length
      ? `<span><svg class="key-icon" viewBox="0 0 24 24" aria-hidden="true">${gemBody}</svg>Gems used</span>`
      : "",
  ];
  host.innerHTML = `
    <div class="timeline-bar">
      <h3>Timeline</h3>
      <div class="legend">${legend.join("")}</div>
      <div class="seg small" role="group" aria-label="Zoom">
        ${[1, 2, 4, 8, 16].map((z) => `<button type="button" data-action="zoom" data-value="${z}" aria-pressed="${z === state.zoom}">${z}×</button>`).join("")}
      </div>
    </div>
    <div class="scroller"><svg class="chart" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Upgrade timeline">${parts.join("")}</svg></div>
    <p class="muted small">Tap an upgrade for details.${shown.night ? "" : " Zoom in to see each night offline."}</p>`;
}

function renderDetails(r: Ok) {
  const plan = r.plan;
  const p =
    plan.steps.find((s) => s.id === state.selected) ??
    plan.steps.find((s) => s.reason !== "running" && s.reason !== "instant" && s.worker !== null);
  if (!p) {
    $("details").innerHTML = "";
    return;
  }
  const item = p.item ? items.find((i) => i.id === p.item) : undefined;
  $("details").innerHTML = `
    <div class="detail-head">
      <h3>${esc(stepName(gd, p))}</h3>
      <span class="chip ${p.lane}">${esc(workerName(plan, p.worker))}</span>
    </div>
    <dl class="facts">
      <div><dt>Starts</dt><dd>${esc(when(p.start))}</dd></div>
      <div><dt>Ends</dt><dd>${esc(when(p.end))}</dd></div>
      <div><dt>Takes</dt><dd>${span(p.seconds)}${p.seconds !== p.baseSeconds ? ` <span class="muted">(base ${span(p.baseSeconds)})</span>` : ""}</dd></div>
      <div><dt>Costs</dt><dd>${num.format(p.cost)} ${p.resource === "darkElixir" ? "dark elixir" : p.resource}</dd></div>
      <div><dt>${p.gems ? "Finished with" : "Gems to finish"}</dt><dd>${p.gems ? `${num.format(p.gems)} gems` : p.seconds > 0 ? `${num.format(gemCost(p.seconds))} gems <span class="muted">at the start</span>` : "—"}</dd></div>
    </dl>
    <p class="why"><strong>Why now:</strong> ${esc(REASON[p.reason])}.${p.timePcts.length ? ` Discounts: ${p.timePcts.map((x) => `${x}%`).join(" and ")}.` : ""}${item ? ` Finished early with ${esc(item.name)}.` : ""}</p>`;
}

function renderUpcoming(r: Ok) {
  const plan = r.plan;
  const list = plan.steps.filter(
    (p) =>
      p.reason !== "running" &&
      p.worker !== null &&
      (state.laneFilter === "all" || p.lane === state.laneFilter),
  );
  const shown = state.showAll ? list : list.slice(0, 15);
  $("upcoming").innerHTML = `
    <div class="section-head">
      <h3>Upgrade order</h3>
      <label class="inline small" for="lane-filter">Show
        <select id="lane-filter" class="compact" data-bind="lane-filter">
          ${(["all", "builder", "lab", "petHouse"] as const).map((l) => `<option value="${l}" ${l === state.laneFilter ? "selected" : ""}>${l === "all" ? "Everything" : l === "builder" ? "Builders" : LANE_NAME[l]}</option>`).join("")}
        </select>
      </label>
    </div>
    <ol class="order">
      ${shown
        .map(
          (
            p,
          ) => `<li><button type="button" class="order-row ${state.selected === p.id ? "selected" : ""}" data-action="select" data-step="${esc(p.id)}">
        <i class="key ${p.lane}"></i>
        <span class="order-name">${esc(stepName(gd, p))}${p.item ? ` <span class="muted small">(${esc(itemName(p.item))})</span>` : ""}${p.gems ? ` <span class="muted small">(${num.format(p.gems)} gems)</span>` : ""}</span>
        <span class="muted small">${esc(workerName(plan, p.worker))}</span>
        <span class="order-when">${esc(when(p.start))}</span>
        <span class="muted small order-took">${span(p.seconds)}</span>
      </button></li>`,
        )
        .join("")}
    </ol>
    ${list.length > 15 ? `<button class="link" type="button" data-action="show-all">${state.showAll ? "Show the first 15" : `Show all ${list.length}`}</button>` : ""}`;
}

function renderReport(r: Ok) {
  const rep = r.report;
  $("report").innerHTML = `
    <details>
      <summary>Import report: ${rep.totals.instances} buildings and levels read, ${rep.totals.upgrading} upgrading, ${rep.warnings.length} note${rep.warnings.length === 1 ? "" : "s"}</summary>
      <ul class="small">
        ${rep.unknownIds.length ? `<li class="warn">${rep.unknownIds.length} ids the game data does not know, left out of the plan. The game may have updated since 16 November 2026.</li>` : ""}
        ${rep.warnings.map((w) => `<li>${esc(w.message)}</li>`).join("")}
        ${r.notes.map((n) => `<li class="muted">${esc(n)}</li>`).join("")}
        ${r.unplannable ? `<li class="warn">${r.unplannable} upgrades could not be planned.</li>` : ""}
      </ul>
      <p class="muted small">Plan ${r.hash.slice(0, 12)} · game data ${esc(gd.version)}</p>
    </details>`;
}

// --- Boosters ----------------------------------------------------------------------------------
function renderItems() {
  if (!state.text) {
    $("passes").innerHTML =
      `<div class="empty"><p>Plan a village first, then set your boosters here.</p><a class="button primary" href="#start">Paste an export</a></div>`;
    $("gems").innerHTML = "";
    $("boosters").innerHTML = "";
    $("events").innerHTML = "";
    return;
  }
  const r = ok();
  const helperLevel = (id: number) => r?.village.helpers.find((h) => h.dataId === id)?.level ?? 0;
  const apprentice = helperLevel(93000000);
  const assistant = helperLevel(93000001);
  $("passes").innerHTML = `
    <div class="section-head"><h3>Helpers and Gold Pass</h3>${r ? `<span class="chip ${r.savedSeconds > 0 ? "good" : ""}">Town Hall ${r.target} maxed ${esc(day(r.plan.halls.at(-1)?.maxedAt ?? r.plan.finish))}</span>` : ""}</div>
    <div class="grid-2">
      <div>
        <label class="toggle" for="helpers-2"><input type="checkbox" id="helpers-2" data-bind="helpers" ${settings.helpers ? "checked" : ""}/> <span>Use my helpers</span></label>
        <p class="muted small">${apprentice || assistant ? `From your export: Builder's Apprentice level ${apprentice || "none"}, Lab Assistant level ${assistant || "none"}. Each adds its level in hours of work once a day.` : "Your export shows no Builder's Apprentice or Lab Assistant."}</p>
      </div>
      <div>
        <label class="toggle" for="goldpass-2"><input type="checkbox" id="goldpass-2" data-bind="goldpass" ${settings.goldPass ? "checked" : ""}/> <span>I buy the Gold Pass</span></label>
        <label class="field" for="gp-pct">Boost the game shows now, if you know it
          <span class="inline"><input id="gp-pct" type="number" min="0" max="100" step="1" placeholder="auto" value="${settings.goldPassPct ?? ""}" data-bind="gp-pct" ${settings.goldPass ? "" : "disabled"}/> %</span>
        </label>
        <p class="muted small">Otherwise it grows from 10% to 20% over each season.</p>
      </div>
    </div>`;
  renderGems(r);
  renderBoosters(r);
  renderEvents(r);
  renderBoostBar();
}

/** Stays in view on the booster page: the max date now, what boosts save, and the way back. */
function renderBoostBar() {
  const el = document.getElementById("boost-bar");
  if (!el) return;
  const r = ok();
  if (!state.text || !r) {
    el.innerHTML =
      state.text && state.planning
        ? `<div><p><b class="busy">Updating your plan</b></p></div>`
        : "";
    return;
  }
  const maxed = r.plan.halls.at(-1)?.maxedAt ?? r.plan.finish;
  const saved = r.withoutItemsMaxedAt - maxed;
  const what = r.hasItems && r.hasGems ? "items and gems" : r.hasGems ? "gems" : "items";
  const line = state.planning
    ? `<span class="busy">Updating with your changes</span>`
    : saved > 0
      ? `<span class="saved-by">${span(saved)} sooner with your ${what}</span>`
      : r.hasItems || r.hasGems
        ? `<span class="same">Your ${what} don't move the date yet</span>`
        : `<span class="same">Add items or gems above to bring it forward</span>`;
  el.innerHTML = `<div>
    <p><span>Town Hall ${r.target} maxed</span><b>${esc(dateLong(maxed))}</b>${line}</p>
    <a class="button primary" href="#plan">See the updated plan</a>
  </div>`;
}

function renderGems(r: Ok | null) {
  const g = settings.gems;
  const plan = r?.plan;
  const uses = (plan?.gemUses ?? []).map((u) => {
    const step = plan!.steps.find((s) => s.id === u.stepId);
    return `<li>${gemGlyph}<span>${num.format(u.gems)} gems${step ? ` on ${esc(stepName(gd, step))}` : ""}</span><span class="muted small">${esc(day(u.at))}, skips ${span(u.savedSeconds)}</span></li>`;
  });
  const chip = !r
    ? ""
    : !r.hasGems
      ? `<span class="chip">None set</span>`
      : r.gemsSaved > 0
        ? `<span class="chip good">${span(r.gemsSaved)} sooner</span>`
        : `<span class="chip">No time saved</span>`;
  const field = (id: string, label: string, value: number, after = "", step = 1) =>
    `<label class="field" for="${id}">${label}${after ? `<span class="inline">` : ""}<input id="${id}" type="number" min="0" step="${step}" inputmode="decimal" value="${value}" data-bind="${id}"/>${after ? ` ${after}</span>` : ""}</label>`;
  $("gems").innerHTML = `
    <div class="section-head"><h3>Gems</h3>${chip}</div>
    <p class="muted small">Gems finish upgrades on the path that sets your max date, longest first: a gem buys more time on a long timer. Finishing costs about 20 gems for an hour left, 260 for a day and 1,000 for a week.</p>
    <div class="gem-fields">
      ${field("gems-stock", "Gems in hand", g.stock)}
      ${field("gems-month", "Gems you earn a month", g.perMonth)}
      ${field("gems-reserve", "Always keep", g.reserve, "gems")}
      ${field("gems-days", "Only on upgrades with at least", g.minDays, "days left", 0.5)}
    </div>
    ${r?.gemsHelp && r.gemMinDays > g.minDays ? `<p class="small">Keeping gems for timers of ${r.gemMinDays} days or more brought the date furthest forward here, so the plan does that.</p>` : ""}
    <p class="muted small">Books and potions from the Trader often buy more time for the same gems. If you buy those, add them under Magic items instead.</p>
    ${
      r?.hasGems
        ? `<h4>Planned gem spending</h4>${
            uses.length
              ? `<ul class="uses">${uses.slice(0, 12).join("")}</ul>${uses.length > 12 ? `<p class="muted small">and ${uses.length - 12} more</p>` : ""}<p class="small gem-total"><strong>${num.format(plan!.gemsSpent)}</strong> gems spent in all.</p>`
              : `<p class="muted small">No upgrade on the path that sets your max date is long enough, or cheap enough for these gems.</p>`
          }`
        : ""
    }
    ${r ? `<p class="muted small gem-total">Finishing every upgrade left right now, one by one, would cost <strong>${num.format(r.gemsToFinishAll)}</strong> gems.</p>` : ""}`;
}

function stepper(kind: "stock" | "month", id: string, value: number, label: string) {
  return `<div class="stepper" role="group" aria-label="${label}">
    <span class="muted small">${label}</span>
    <button type="button" data-action="${kind}-" data-item="${id}" aria-label="One less" ${value <= 0 ? "disabled" : ""}>−</button>
    <output>${value}</output>
    <button type="button" data-action="${kind}+" data-item="${id}" aria-label="One more">+</button>
  </div>`;
}

function renderBoosters(r: Ok | null) {
  const plan = r?.plan;
  const groups: [MagicItem["kind"], string][] = [
    ["potion", "Potions"],
    ["book", "Books"],
    ["hammer", "Hammers"],
  ];
  const card = (i: MagicItem) => `
    <div class="item">
      ${glyph(i)}
      <div class="item-text"><strong>${esc(i.name)}</strong><span class="muted small">Hold up to ${i.holdLimit}</span></div>
      <div class="steppers">
        ${stepper("stock", i.id, settings.stock[i.id] ?? 0, "In hand")}
        ${stepper("month", i.id, settings.perMonth[i.id] ?? 0, "Per month")}
      </div>
    </div>`;
  const uses = (plan?.itemUses ?? []).slice(0, 10).map((u) => {
    const step = u.stepId ? plan!.steps.find((s) => s.id === u.stepId) : undefined;
    const item = items.find((i) => i.id === u.item)!;
    return `<li>${glyph(item)}<span>${esc(item.name)}${step ? ` on ${esc(stepName(gd, step))}` : ""}</span><span class="muted small">${esc(day(u.at))}, saves ${span(u.savedSeconds)}</span></li>`;
  });
  const wasted = (plan?.wasted ?? []).reduce((n, w) => n + w.count, 0);
  $("boosters").innerHTML = `
    <div class="section-head"><h3>Magic items</h3>${r ? `<span class="chip ${r.savedSeconds > 0 ? "good" : ""}">${r.savedSeconds > 0 ? `${span(r.savedSeconds)} sooner` : r.hasItems ? "No time saved" : "None set"}</span>` : ""}</div>
    <p class="muted small">Set what you have and what you expect each month from the passes, Clan Games and events. The plan uses them at the best moments and shows the time saved.</p>
    ${groups
      .map(
        ([k, title]) =>
          `<h4>${title}</h4><div class="items">${items
            .filter((i) => i.kind === k)
            .map(card)
            .join("")}</div>`,
      )
      .join("")}
    <details class="rules">
      <summary>When items are used</summary>
      <div class="row wrap">
        <label class="field" for="book-days">Books on upgrades with at least <span class="inline"><input id="book-days" type="number" min="0" max="30" step="0.5" value="${settings.rules.bookMinDays}" data-bind="book-days"/> days left</span></label>
        <label class="field" for="hammer-days">Hammers on upgrades of at least <span class="inline"><input id="hammer-days" type="number" min="0" max="30" step="0.5" value="${settings.rules.hammerMinDays}" data-bind="hammer-days"/> days</span></label>
      </div>
      <label class="toggle" for="save-books"><input type="checkbox" id="save-books" data-bind="save-books" ${settings.rules.saveBooksForFullPrice ? "checked" : ""}/> <span>Keep books while an event discount runs</span></label>
      <label class="toggle" for="potions-auto"><input type="checkbox" id="potions-auto" data-bind="potions-auto" ${settings.rules.potions === "auto" ? "checked" : ""}/> <span>Use potions when every worker of a lane is busy for long enough</span></label>
    </details>
    <h4>Planned uses</h4>
    ${uses.length ? `<ul class="uses">${uses.join("")}</ul>${(plan?.itemUses.length ?? 0) > uses.length ? `<p class="muted small">and ${plan!.itemUses.length - uses.length} more</p>` : ""}` : r?.hasItems ? `<p class="muted small">Your items do not bring the max date forward in this plan, so it keeps them.${r.lowerBound.bottleneck === "lab" ? " The Laboratory sets your max date: research potions and the Books of Fighting, Spells or Everything move it, builder items do not." : " Try other rules below, or keep them for walls."}</p>` : `<p class="muted small">None yet: add items above.</p>`}
    ${wasted ? `<p class="warn small">${wasted} item${wasted === 1 ? "" : "s"} would arrive past the holding limit and be lost: use one before then.</p>` : ""}`;
}

function renderEvents(r: Ok | null) {
  const from = r?.village.exportedAt ?? Date.now() / 1000;
  const on = (e: GameEvent) =>
    settings.enabled ? settings.enabled.includes(e.id) : e.status === "confirmed";
  const rows = gameEvents.map((e) => {
    const past = !!e.end && Date.parse(e.end) / 1000 <= from;
    const homeEffect = e.effects.some(
      (f) => f.kind === "noHeroUpgrades" || (f.kind === "discount" && f.villages.includes("home")),
    );
    const effect = e.effects
      .map((f) =>
        f.kind === "discount"
          ? `${f.timePct}% off time, ${f.costPct}% off cost (${f.villages.join(", ")} village)`
          : "No hero upgrades start, so heroes stay ready",
      )
      .join("; ");
    const dates =
      e.start && e.end
        ? `${day(Date.parse(e.start) / 1000)} to ${day(Date.parse(e.end) / 1000)}`
        : e.recurrence
          ? `Every month from the ${e.recurrence.startDay}${e.recurrence.startDay === 1 ? "st" : "th"}, ${e.recurrence.lengthDays} days`
          : "";
    const status = past ? "past" : e.status;
    return `<li class="event-row ${past ? "is-past" : ""}">
      <label class="toggle" for="ev-${esc(e.id)}"><input type="checkbox" id="ev-${esc(e.id)}" data-action="event" data-item="${esc(e.id)}" ${on(e) && !past && homeEffect ? "checked" : ""} ${past || !homeEffect ? "disabled" : ""}/>
      <span><strong>${esc(e.name)}</strong><span class="muted small block">${esc(dates)} · ${esc(effect)}</span></span></label>
      <span class="chip ${status === "confirmed" ? "good" : status === "projected" ? "warn" : ""}">${status === "projected" ? "Estimate" : status === "past" ? "Over" : "Confirmed"}</span>
    </li>`;
  });
  $("events").innerHTML =
    `<div class="section-head"><h3>Events</h3></div><ul class="events">${rows.join("")}</ul>
    <p class="muted small">Estimates are off until you switch them on. Builder Base events do not change the home village plan.</p>`;
}

// --- Compare ---------------------------------------------------------------------------------
function renderCompare() {
  const list = store.villages();
  const pick = (side: "a" | "b") => `
    <label class="field" for="cmp-${side}">${side === "a" ? "Earlier export" : "Later export"}
      <select id="cmp-${side}" data-bind="cmp-${side}">
        <option value="">Choose…</option>
        ${list.map((v) => `<option value="${esc(v.id)}" ${state.compare[side] === v.id ? "selected" : ""}>${esc(v.tag)} · TH${v.townHall} · ${esc(day(v.exportedAt))}</option>`).join("")}
        <option value="paste" ${state.compare[side] === "paste" ? "selected" : ""}>Paste an export…</option>
      </select>
    </label>`;
  const needsPaste = state.compare.a === "paste" || state.compare.b === "paste";
  const textOf = (side: "a" | "b") =>
    state.compare[side] === "paste"
      ? state.compare.pasted
      : list.find((v) => v.id === state.compare[side])?.text;
  const ta = textOf("a");
  const tb = textOf("b");
  let body = `<p class="muted">Export your village now and again in a week, or compare with a friend's export: see every level gained and how the days to max moved.</p>`;
  if (ta && tb) {
    const pa = parseExport(ta, gd, {});
    const pb = parseExport(tb, gd, {});
    if (!pa.ok || !pb.ok) {
      body = `<p class="error">${esc((!pa.ok ? pa.error.message : !pb.ok ? pb.error.message : "") || "An export could not be read.")}</p>`;
    } else {
      body = comparison(pa.village, pb.village);
    }
  }
  $("compare").innerHTML = `
    <section class="card">
      <h2>Compare two exports</h2>
      <div class="grid-2">${pick("a")}${pick("b")}</div>
      ${needsPaste ? `<label class="field" for="cmp-paste">Pasted export<textarea id="cmp-paste" rows="4" spellcheck="false" data-bind="cmp-paste">${esc(state.compare.pasted)}</textarea></label>` : ""}
      ${list.length < 2 && !needsPaste ? `<p class="muted small">Exports you plan are kept on this device and show up here.</p>` : ""}
    </section>
    <section class="card">${body}</section>`;
}

function comparison(a: Village, b: Village): string {
  const c = compareVillages(a, b, gd);
  const apart = Math.abs(b.exportedAt - a.exportedAt);
  const days = (o?: PlanOutput) =>
    o && o.ok
      ? `${daysText((o.plan.halls.at(-1)?.maxedAt ?? o.plan.finish) - o.plan.start)} ${daysUnit((o.plan.halls.at(-1)?.maxedAt ?? o.plan.finish) - o.plan.start)}`
      : "…";
  const groups = new Map<string, typeof c.changes>();
  for (const ch of c.changes) groups.set(ch.category, [...(groups.get(ch.category) ?? []), ch]);
  const label: Record<string, string> = {
    defense: "Defenses",
    army: "Army buildings",
    resource: "Resources",
    storage: "Storages",
    trap: "Traps",
    hero: "Heroes",
    troop: "Troops",
    spell: "Spells",
    siege: "Siege machines",
    pet: "Pets",
    other: "Other",
    wall: "Walls",
  };
  requestCompareDays(a, b);
  return `
    <div class="grid-2">
      ${[a, b].map((v, i) => `<div class="card"><p class="eyebrow">${i === 0 ? "Earlier" : "Later"}</p><h3>Town Hall ${v.townHall}</h3><p class="muted small">Exported ${esc(when(v.exportedAt))}</p><p>Maxed in <strong class="cmp-days">${days(i === 0 ? state.compare.out?.a : state.compare.out?.b)}</strong> from then</p></div>`).join("")}
    </div>
    <p><strong>${c.levelsGained >= 0 ? "+" : ""}${c.levelsGained}</strong> levels across ${c.changes.length} buildings, troops, spells, heroes and pets, ${span(apart)} apart.${c.walls.levelsGained ? ` Walls: ${c.walls.levelsGained >= 0 ? "+" : ""}${c.walls.levelsGained} levels.` : ""}</p>
    ${[...groups].map(([cat, list]) => `<h4>${esc(label[cat] ?? cat)}</h4><ul class="diff">${list.map((ch) => `<li><span>${esc(ch.name)}</span><span class="lv">${esc(ch.a.join(", ") || "none")} → ${esc(ch.b.join(", ") || "none")}</span><span class="${ch.levelsGained >= 0 ? "plus" : "minus"}">${ch.levelsGained >= 0 ? "+" : ""}${ch.levelsGained}</span></li>`).join("")}</ul>`).join("") || `<p class="muted">No level changed between these two exports.</p>`}`;
}

let compareKey = "";
function requestCompareDays(a: Village, b: Village) {
  const key = `${a.exportedAt}|${b.exportedAt}|${JSON.stringify(settings)}`;
  if (key === compareKey) return;
  compareKey = key;
  state.compare.out = {};
  const list = store.villages();
  const text = (side: "a" | "b") =>
    state.compare[side] === "paste"
      ? state.compare.pasted
      : (list.find((v) => v.id === state.compare[side])?.text ?? "");
  const own = { ...structuredClone(settings), target: null };
  void (async () => {
    const outA = await comparer.plan({ text: text("a"), settings: own }, false);
    if (key !== compareKey) return;
    state.compare.out = { a: outA };
    if (current() === "compare") renderCompare();
    const outB = await comparer.plan({ text: text("b"), settings: own }, false);
    if (key !== compareKey) return;
    state.compare.out = { a: outA, b: outB };
    if (current() === "compare") renderCompare();
  })();
}

// --- Events ----------------------------------------------------------------------------------
document.addEventListener("click", (ev) => {
  const el = (ev.target as Element).closest<HTMLElement>("[data-action]");
  if (!el) return;
  const a = el.dataset.action!;
  const item = el.dataset.item ?? "";
  const value = el.dataset.value ?? "";
  const bump = (map: Record<string, number>, by: number, cap?: number) => {
    map[item] = Math.max(0, Math.min(cap ?? 99, (map[item] ?? 0) + by));
  };
  const hold = items.find((i) => i.id === item)?.holdLimit;
  switch (a) {
    case "demo":
      openDemo();
      return;
    case "focus-paste": {
      const box = document.getElementById("paste-text") as HTMLTextAreaElement | null;
      document.getElementById("paste")?.scrollIntoView({ behavior: "smooth", block: "start" });
      box?.focus({ preventScroll: true });
      return;
    }
    case "paste-plan": {
      const text = (document.getElementById("paste-text") as HTMLTextAreaElement).value.trim();
      if (!text) {
        state.pasteError = "Paste your export first: Settings, More Settings, Data Export, Copy.";
        renderStart();
        return;
      }
      state.pasteError = openText(text);
      if (state.pasteError) renderStart();
      return;
    }
    case "open": {
      const v = store.villages().find((x) => x.id === item);
      if (v) openSaved(v);
      return;
    }
    case "remove":
      store.removeVillage(item);
      if (state.savedId === item) {
        state.text = null;
        state.result = null;
        state.source = null;
      }
      renderStart();
      show();
      return;
    case "select":
      state.selected = el.dataset.step ?? null;
      {
        const r = ok();
        if (r) {
          renderTimeline(r);
          renderDetails(r);
          renderUpcoming(r);
        }
      }
      $("details").scrollIntoView({ behavior: "smooth", block: "nearest" });
      return;
    case "zoom":
      state.zoom = Number(value);
      {
        const r = ok();
        if (r) renderTimeline(r);
      }
      return;
    case "show-all":
      state.showAll = !state.showAll;
      {
        const r = ok();
        if (r) renderUpcoming(r);
      }
      return;
    case "target":
      settings.target = Number(value);
      break;
    case "strategy":
      settings.strategy = value as Strategy;
      break;
    case "stock+":
      bump(settings.stock, 1, hold);
      break;
    case "stock-":
      bump(settings.stock, -1);
      break;
    case "month+":
      bump(settings.perMonth, 1, 30);
      break;
    case "month-":
      bump(settings.perMonth, -1);
      break;
    default:
      return;
  }
  persist();
  renderRail();
  renderItems();
  replan();
});

document.addEventListener("keydown", (ev) => {
  const el = (ev.target as Element).closest<HTMLElement>("[data-action='select']");
  if (el && (ev.key === "Enter" || ev.key === " ")) {
    ev.preventDefault();
    el.click();
  }
});

const GEM_FIELD = {
  "gems-stock": "stock",
  "gems-month": "perMonth",
  "gems-reserve": "reserve",
  "gems-days": "minDays",
} as const;

document.addEventListener("change", (ev) => {
  const el = ev.target as HTMLInputElement;
  if (el.dataset.action === "event") {
    const id = el.dataset.item!;
    const now =
      settings.enabled ?? gameEvents.filter((e) => e.status === "confirmed").map((e) => e.id);
    settings.enabled = el.checked ? [...new Set([...now, id])] : now.filter((x) => x !== id);
    persist();
    replan();
    return;
  }
  switch (el.dataset.bind) {
    case "goldpass":
      settings.goldPass = el.checked;
      break;
    case "helpers":
      settings.helpers = el.checked;
      break;
    case "gp-pct": {
      const n = el.value === "" ? null : Math.round(Number(el.value));
      settings.goldPassPct =
        n === null || !Number.isFinite(n) ? null : Math.max(0, Math.min(100, n));
      break;
    }
    case "offline-on":
      settings.offline.on = el.checked;
      break;
    case "offline-from":
      settings.offline.from = el.value || settings.offline.from;
      break;
    case "offline-to":
      settings.offline.to = el.value || settings.offline.to;
      break;
    case "tz":
      settings.timeZone = el.value;
      break;
    case "book-days":
      settings.rules = { ...settings.rules, bookMinDays: Math.max(0, Number(el.value) || 0) };
      break;
    case "hammer-days":
      settings.rules = { ...settings.rules, hammerMinDays: Math.max(0, Number(el.value) || 0) };
      break;
    case "save-books":
      settings.rules = { ...settings.rules, saveBooksForFullPrice: el.checked };
      break;
    case "gems-stock":
    case "gems-month":
    case "gems-reserve":
    case "gems-days": {
      const key = GEM_FIELD[el.dataset.bind];
      const n = Number(el.value);
      const whole = key === "minDays" ? Math.round(n * 2) / 2 : Math.round(n);
      const clean = Number.isFinite(whole) ? Math.max(0, whole) : 0;
      settings.gems = { ...settings.gems, [key]: Math.min(clean, key === "minDays" ? 60 : 1e7) };
      break;
    }
    case "potions-auto":
      settings.rules = { ...settings.rules, potions: el.checked ? "auto" : "off" };
      break;
    case "lane-filter": {
      state.laneFilter = el.value as typeof state.laneFilter;
      const r = ok();
      if (r) renderUpcoming(r);
      return;
    }
    case "cmp-a":
      state.compare.a = el.value;
      renderCompare();
      return;
    case "cmp-b":
      state.compare.b = el.value;
      renderCompare();
      return;
    case "cmp-paste":
      state.compare.pasted = el.value;
      renderCompare();
      return;
    default:
      return;
  }
  persist();
  renderRail();
  renderItems();
  replan();
});

window.addEventListener("hashchange", show);
let resizeTimer = 0;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    const r = ok();
    if (r && current() === "plan") renderTimeline(r);
  }, 150);
});

// --- Start up ---------------------------------------------------------------------------------
const last = store.current();
const lastVillage = store.villages().find((v) => v.id === last);
if (lastVillage) {
  state.text = lastVillage.text;
  state.source = "saved";
  state.savedId = lastVillage.id;
  replan(0);
}
show();
// A link to #plan with nothing saved opens the demo, so the page is never empty.
if (!state.text && (current() === "plan" || current() === "items")) openDemo();
void DEMO_TAG;

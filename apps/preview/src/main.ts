// The preview page: paste an export (or use the demo village), pick a target hall,
// strategy, offline hours, Gold Pass, items and events, and see the plan.
import {
  createGameData,
  validateEvents,
  validateGameData,
  validateMagicItems,
  validateSeasons,
  type GameData,
  type GameDataFile,
  type GameEvent,
  type Lane,
  type MagicItem,
} from "@max-planner/gamedata";
import {
  DEFAULT_ITEM_RULES,
  OnlineCalendar,
  STRATEGIES,
  arrivals,
  expandEvents,
  formatDuration,
  goldPassDiscount,
  parseExport,
  remainingWork,
  searchWithItems,
  type EventWindow,
  type ImportReport,
  type ItemRules,
  type ItemSavings,
  type PlacedStep,
  type Plan,
  type RemainingWork,
  type Strategy,
  type Village,
} from "@max-planner/core";
import itemsFile from "@max-planner/gamedata/files/magic-items.json" with { type: "json" };
import eventsFile from "@max-planner/gamedata/files/events.json" with { type: "json" };
import seasonsFile from "@max-planner/gamedata/files/seasons.json" with { type: "json" };
import sampleFile from "../../../fixtures/gamedata/sample.json" with { type: "json" };
import sampleExport from "../../../fixtures/exports/synthetic-th2.json" with { type: "json" };
import { demoExport, demoGameData } from "./demo.ts";

const HOUR = 3600;
const DAY = 86_400;

// --- Data ------------------------------------------------------------------------------------
function must<T>(r: { ok: true; value: T } | { ok: false; errors: unknown }): T {
  if (!r.ok) throw new Error(`Bad data file: ${JSON.stringify(r.errors)}`);
  return r.value;
}
const items: MagicItem[] = must(validateMagicItems(itemsFile)).items;
const gameEvents: GameEvent[] = must(validateEvents(eventsFile)).events;
const seasons = must(validateSeasons(seasonsFile, new Set(items.map((i) => i.id))));

type DataSet = "demo" | "sample";
const DATA: Record<DataSet, { label: string; gd: GameData; exportText: (at: number) => string }> = {
  demo: {
    label: "Demo village, Town Hall 4 of 5",
    gd: createGameData(must(validateGameData(demoGameData()))),
    exportText: (at) => demoExport(at),
  },
  sample: {
    label: "Test fixture, Town Hall 2 of 3",
    gd: createGameData(must(validateGameData(sampleFile as GameDataFile))),
    exportText: () => JSON.stringify(sampleExport),
  },
};

// --- State -----------------------------------------------------------------------------------
const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const state = {
  dataSet: "demo" as DataSet,
  pasted: null as string | null,
  pasteOpen: false,
  target: null as number | null,
  strategy: "balanced" as Strategy,
  goldPass: true,
  offline: { on: true, from: "23:00", to: "07:00" },
  timeZone: localZone,
  stock: {
    "builder-potion": 2,
    "research-potion": 1,
    "book-of-building": 1,
    "hammer-of-heroes": 1,
  } as Record<string, number>,
  perMonth: {} as Record<string, number>,
  enabled: null as string[] | null,
  rules: { ...DEFAULT_ITEM_RULES } as ItemRules,
  zoom: 1,
  selected: null as string | null,
  showAll: false,
};
/** The demo starts at the current hour, so its dates read as from today. */
const demoAt = Math.floor(Date.now() / 1000 / HOUR) * HOUR;

// --- Planning --------------------------------------------------------------------------------
type Computed =
  | {
      ok: true;
      gd: GameData;
      village: Village;
      report: ImportReport;
      work: RemainingWork;
      result: ItemSavings;
      windows: EventWindow[];
      calendar: OnlineCalendar | undefined;
      ms: number;
    }
  | { ok: false; message: string };

function hashSeed(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

function compute(): Computed {
  const started = performance.now();
  const { gd } = DATA[state.dataSet];
  const text = state.pasted ?? DATA[state.dataSet].exportText(demoAt);
  // Only a pasted export is checked for age: the demo is dated now, the fixture is old.
  const parsed = parseExport(text, gd, state.pasted ? { now: Math.floor(Date.now() / 1000) } : {});
  if (!parsed.ok) {
    const hint =
      parsed.error.code === "no_town_hall" && state.pasted
        ? " This preview only knows the made-up demo ids, so a real export cannot match yet."
        : "";
    return { ok: false, message: parsed.error.message + hint };
  }
  const { village, report } = parsed;
  const target = Math.min(
    gd.maxTownHall,
    Math.max(village.townHall, state.target ?? village.townHall),
  );
  state.target = target;
  const work = remainingWork(village, gd, { targetTownHall: target });
  const from = village.exportedAt;
  const horizon = from + 5 * 365 * DAY;
  let calendar: OnlineCalendar | undefined;
  try {
    calendar = state.offline.on
      ? new OnlineCalendar(
          {
            timeZone: state.timeZone,
            offline: [
              { days: [0, 1, 2, 3, 4, 5, 6], from: state.offline.from, to: state.offline.to },
            ],
          },
          from,
        )
      : undefined;
  } catch (e) {
    return { ok: false, message: `Offline hours: ${(e as Error).message}` };
  }
  const windows = expandEvents(gameEvents, from, horizon, state.enabled ?? undefined);
  const result = searchWithItems(work, village, gd, {
    strategy: state.strategy,
    seed: hashSeed(text),
    variants: 16,
    ...(calendar ? { calendar } : {}),
    discounts: state.goldPass
      ? [
          goldPassDiscount(
            { pace: seasons.goldPassBoostPace, seasonStartDay: seasons.seasonStartDay },
            from,
          ),
        ]
      : [],
    events: windows,
    boosters: {
      items,
      arrivals: arrivals(
        { stock: state.stock, perMonth: state.perMonth },
        seasons.seasonStartDay,
        from,
        horizon,
      ),
      rules: state.rules,
    },
  });
  return {
    ok: true,
    gd,
    village,
    report,
    work,
    result,
    windows,
    calendar,
    ms: Math.round(performance.now() - started),
  };
}

// --- Formatting ------------------------------------------------------------------------------
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const num = new Intl.NumberFormat();
const dateFmt = () =>
  new Intl.DateTimeFormat(undefined, {
    timeZone: state.timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
const dayFmt = () =>
  new Intl.DateTimeFormat(undefined, { timeZone: state.timeZone, day: "numeric", month: "short" });
const when = (t: number) => dateFmt().format(new Date(t * 1000));
const span = (seconds: number) => (seconds <= 0 ? "0m" : formatDuration(seconds));
const days = (seconds: number) => {
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
  running: "Already running in the export",
  critical: "On the critical path: delaying it delays the finish",
  value: "Best value per hour for your strategy, with time to spare",
  "only-ready": "The only upgrade that could start",
  instant: "Takes no time, so it happens as soon as it can",
  hammer: "Finished by a hammer the moment a worker was free",
};

function stepName(gd: GameData, p: { entityId: number; instance: number; toLevel: number }) {
  const e = gd.entity(p.entityId);
  const count = gd.countAt(p.entityId, gd.maxTownHall);
  const name = e?.name ?? `#${p.entityId}`;
  return `${name}${count > 1 ? ` #${p.instance + 1}` : ""} → lv ${p.toLevel}`;
}
function workerName(plan: Plan, index: number | null) {
  if (index === null) return "No worker";
  const w = plan.workers[index]!;
  if (w.lane !== "builder") return LANE_NAME[w.lane];
  return w.closesAt !== undefined ? "Extra builder" : `Builder ${w.index + 1}`;
}

// --- Item glyphs (drawn here, not game art) ----------------------------------------------------
function glyph(item: MagicItem): string {
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
  return `<svg class="glyph" viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
}

// --- Rendering -------------------------------------------------------------------------------
const $ = (id: string) => document.getElementById(id)!;
let last: Computed | undefined;

function render() {
  const c = (last = compute());
  renderControls(c);
  if (!c.ok) {
    $("headline").innerHTML =
      `<div class="problem"><h2>That export could not be planned</h2><p>${esc(c.message)}</p></div>`;
    for (const id of ["halls", "timeline", "details", "boosters", "events", "upcoming", "report"])
      $(id).innerHTML = "";
    return;
  }
  renderHeadline(c);
  renderHalls(c);
  renderTimeline(c);
  renderDetails(c);
  renderBoosters(c);
  renderEvents(c);
  renderUpcoming(c);
  renderReport(c);
}

function renderControls(c: Computed) {
  const village = c.ok ? c.village : undefined;
  const gd = DATA[state.dataSet].gd;
  const halls: number[] = [];
  if (village) for (let r = village.townHall; r <= gd.maxTownHall; r++) halls.push(r);
  $("village").innerHTML = `
    <div class="village-top">
      <div>
        <p class="eyebrow">${state.pasted ? "Your export" : esc(DATA[state.dataSet].label)}</p>
        <h2>${village ? `Town Hall ${village.townHall}` : "No village"}</h2>
      </div>
      ${village ? `<span class="chip">${village.builders} builders</span>` : ""}
    </div>
    ${village ? `<p class="muted small">Exported ${esc(when(village.exportedAt))}</p>` : ""}
    <div class="row">
      <label class="field grow" for="dataset">Data
        <select id="dataset" data-bind="dataset">
          ${(Object.keys(DATA) as DataSet[]).map((k) => `<option value="${k}" ${k === state.dataSet ? "selected" : ""}>${esc(DATA[k].label)}</option>`).join("")}
        </select>
      </label>
    </div>
    <button class="button" type="button" data-action="paste-toggle">${state.pasteOpen ? "Close" : "Paste an export"}</button>
    ${state.pasted ? `<button class="link" type="button" data-action="paste-clear">Back to the ${state.dataSet === "demo" ? "demo" : "fixture"} village</button>` : ""}
    <div class="paste ${state.pasteOpen ? "" : "hidden"}">
      <label class="field" for="paste-text">Village export (JSON)
        <textarea id="paste-text" rows="6" spellcheck="false" placeholder='{"tag":"#…","timestamp":…,"buildings":[…]}'>${esc(state.pasted ?? "")}</textarea>
      </label>
      <button class="button primary" type="button" data-action="paste-plan">Plan this export</button>
      <p class="muted small">Planning happens in your browser; nothing is uploaded.</p>
    </div>`;

  $("controls").innerHTML = `
    <fieldset class="field">
      <legend>Target Town Hall</legend>
      <div class="seg" role="group">
        ${halls.map((r) => `<button type="button" data-action="target" data-value="${r}" aria-pressed="${r === state.target}">TH${r}</button>`).join("") || `<span class="muted small">Plan an export first</span>`}
      </div>
    </fieldset>
    <fieldset class="field">
      <legend>Strategy</legend>
      <div class="seg" role="group">
        ${STRATEGIES.map((s) => `<button type="button" data-action="strategy" data-value="${s}" aria-pressed="${s === state.strategy}">${s === "offense" ? "Offense first" : s === "defense" ? "Defense first" : "Balanced"}</button>`).join("")}
      </div>
      <p class="muted small">The fastest plan always wins; strategy orders what can move without costing time.</p>
    </fieldset>
    <label class="toggle" for="goldpass"><input type="checkbox" id="goldpass" data-bind="goldpass" ${state.goldPass ? "checked" : ""}/> <span>Gold Pass boost</span><span class="muted small">10% to 20% off over each season</span></label>
    <fieldset class="field">
      <legend>When you are offline</legend>
      <label class="toggle" for="offline-on"><input type="checkbox" id="offline-on" data-bind="offline-on" ${state.offline.on ? "checked" : ""}/> <span>No upgrades start overnight</span></label>
      <div class="row">
        <label class="field" for="offline-from">From <input id="offline-from" type="time" value="${state.offline.from}" data-bind="offline-from" ${state.offline.on ? "" : "disabled"}/></label>
        <label class="field" for="offline-to">To <input id="offline-to" type="time" value="${state.offline.to}" data-bind="offline-to" ${state.offline.on ? "" : "disabled"}/></label>
      </div>
      <p class="muted small">Times in ${esc(state.timeZone)}</p>
    </fieldset>`;
}

function renderHeadline(c: Extract<Computed, { ok: true }>) {
  const { result, work, village } = c;
  const plan = result.withItems.plan;
  const maxed = plan.halls.at(-1)?.maxedAt ?? plan.finish;
  const left = maxed - plan.start;
  const without =
    (result.withoutItems.plan.halls.at(-1)?.maxedAt ?? result.withoutItems.plan.finish) -
    plan.start;
  const saved = without - left;
  const bound = work.lowerBound;
  const steps = work.steps.filter((s) => !s.inProgress).length;
  $("headline").innerHTML = `
    <p class="eyebrow">Town Hall ${work.targetTownHall} maxed in</p>
    <div class="big"><span class="big-num">${days(left)}</span><span class="big-unit">${daysUnit(left)}</span></div>
    <p class="when">${esc(when(maxed))}</p>
    <div class="chips">
      <span class="chip ${saved > 0 ? "good" : ""}">${saved > 0 ? `Items save ${span(saved)}` : "Items save nothing here"}</span>
      <span class="chip">${steps} upgrades left${work.totals.walls.upgrades ? `, plus ${num.format(work.totals.walls.upgrades)} wall levels` : ""}</span>
      <span class="chip" title="The fastest any plan could be without discounts or items">Bound ${span(bound.seconds)}, set by ${bound.bottleneck === "chain" ? "the longest chain" : bound.bottleneck === "petHouse" ? "the Pet House" : bound.bottleneck === "lab" ? "the Laboratory" : "builder time"}</span>
    </div>
    <p class="muted small">Planned from the export at ${esc(when(village.exportedAt))} in ${c.ms} ms: ${result.withItems.runs} scheduler runs${result.withItems.stoppedEarly ? ", stopped at the time budget" : ""}.</p>`;
}

function renderHalls(c: Extract<Computed, { ok: true }>) {
  const plan = c.result.withItems.plan;
  $("halls").innerHTML = plan.halls
    .map(
      (h) => `<li class="hall">
        <span class="hall-badge">TH${h.townHall}</span>
        <span><span class="muted small">Reached</span> ${h.reachedAt === null ? "—" : h.reachedAt === plan.start ? "now" : esc(dayFmt().format(new Date(h.reachedAt * 1000)))}</span>
        <span><span class="muted small">Maxed</span> <strong>${h.maxedAt === null ? "—" : esc(dayFmt().format(new Date(h.maxedAt * 1000)))}</strong></span>
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
    60 * DAY,
    90 * DAY,
  ];
  return steps.find((s) => range / s <= target) ?? 180 * DAY;
}

function renderTimeline(c: Extract<Computed, { ok: true }>) {
  const plan = c.result.withItems.plan;
  const gd = c.gd;
  const host = $("timeline");
  const labelW = 104;
  const rowH = 26;
  const gap = 6;
  const top = 34;
  const lanes = plan.workers
    .map((_, i) => ({ i }))
    .filter(({ i }) => plan.steps.some((p) => p.worker === i || p.holds === i));
  const height = top + lanes.length * (rowH + gap) + 10;
  const width = Math.max(560, (host.clientWidth || 720) - 2) * state.zoom;
  const t0 = plan.start;
  const t1 = Math.max(plan.finish, t0 + 6 * HOUR);
  const x = (t: number) => labelW + ((t - t0) / (t1 - t0)) * (width - labelW - 8);
  const rowY = new Map(lanes.map(({ i }, k) => [i, top + k * (rowH + gap)]));
  const parts: string[] = [];

  // Offline nights and event windows behind everything.
  for (const [a, b] of c.calendar?.windows(t0, t1) ?? []) {
    parts.push(
      `<rect class="night" x="${x(a)}" y="${top - 4}" width="${Math.max(0.5, x(b) - x(a))}" height="${height - top}"/>`,
    );
  }
  for (const w of c.windows) {
    if (w.end <= t0 || w.start >= t1) continue;
    const a = x(Math.max(w.start, t0));
    const b = x(Math.min(w.end, t1));
    parts.push(
      `<rect class="event ${w.effect.kind === "discount" ? "sale" : "block"}" x="${a}" y="2" width="${Math.max(1, b - a)}" height="12" rx="2"><title>${esc(w.name)}</title></rect>`,
    );
  }
  // Time axis.
  const tick = niceTick(t1 - t0);
  const fmt =
    tick >= DAY
      ? dayFmt()
      : new Intl.DateTimeFormat(undefined, {
          timeZone: state.timeZone,
          hour: "2-digit",
          minute: "2-digit",
        });
  for (let t = Math.ceil(t0 / tick) * tick; t <= t1; t += tick) {
    parts.push(
      `<line class="grid" x1="${x(t)}" x2="${x(t)}" y1="${top - 6}" y2="${height - 6}"/><text class="tick" x="${x(t) + 3}" y="${top - 10}">${esc(fmt.format(new Date(t * 1000)))}</text>`,
    );
  }
  // Rows and steps.
  for (const { i } of lanes) {
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
          `<rect class="held" x="${x(p.start)}" y="${y + 3}" width="${Math.max(1, x(p.end) - x(p.start))}" height="${rowH - 6}" rx="3"><title>${esc(`Waiting while ${stepName(gd, p)} upgrades`)}</title></rect>`,
        );
      }
      if (p.worker !== i) continue;
      const wPx = Math.max(1.5, x(p.end) - x(p.start));
      const cls = [
        "block",
        p.lane,
        p.hall ? "hall" : "",
        p.reason === "running" ? "running" : "",
        p.item ? "booked" : "",
        state.selected === p.id ? "selected" : "",
      ].join(" ");
      const label =
        wPx > 70
          ? `<text class="block-label" x="${x(p.start) + 5}" y="${y + rowH / 2 + 4}">${esc(stepName(gd, p))}</text>`
          : "";
      parts.push(
        `<g class="hit" data-action="select" data-step="${esc(p.id)}" tabindex="0" role="button" aria-label="${esc(stepName(gd, p))}"><rect class="${cls}" x="${x(p.start)}" y="${y}" width="${wPx}" height="${rowH}" rx="4"><title>${esc(`${stepName(gd, p)}: ${when(p.start)} to ${when(p.end)}`)}</title></rect>${label}</g>`,
      );
    }
  }
  // Item uses as markers on the axis.
  for (const u of plan.itemUses) {
    const ux = x(u.at);
    parts.push(
      `<path class="use ${u.kind}" d="M${ux} 18 l5 6 -5 6 -5 -6z"><title>${esc(`${items.find((m) => m.id === u.item)?.name ?? u.item}: ${when(u.at)}, saves ${span(u.savedSeconds)}`)}</title></path>`,
    );
  }
  host.innerHTML = `
    <div class="timeline-bar">
      <h3>Timeline</h3>
      <div class="legend">
        <span><i class="key builder"></i>Builders</span><span><i class="key lab"></i>Laboratory</span><span><i class="key petHouse"></i>Pet House</span>
        <span><i class="key night"></i>Offline</span><span><i class="key use"></i>Item used</span>
      </div>
      <div class="seg small" role="group" aria-label="Zoom">
        ${[1, 2, 4, 8].map((z) => `<button type="button" data-action="zoom" data-value="${z}" aria-pressed="${z === state.zoom}">${z}×</button>`).join("")}
      </div>
    </div>
    <div class="scroller"><svg class="chart" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Upgrade timeline">${parts.join("")}</svg></div>
    <p class="muted small">Tap an upgrade for details. ${lanes.length < plan.workers.length ? "Workers with nothing to do are hidden." : ""}</p>`;
}

function renderDetails(c: Extract<Computed, { ok: true }>) {
  const plan = c.result.withItems.plan;
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
      <h3>${esc(stepName(c.gd, p))}</h3>
      <span class="chip ${p.lane}">${esc(workerName(plan, p.worker))}</span>
    </div>
    <dl class="facts">
      <div><dt>Starts</dt><dd>${esc(when(p.start))}</dd></div>
      <div><dt>Ends</dt><dd>${esc(when(p.end))}</dd></div>
      <div><dt>Takes</dt><dd>${span(p.seconds)}${p.seconds !== p.baseSeconds ? ` <span class="muted">(base ${span(p.baseSeconds)})</span>` : ""}</dd></div>
      <div><dt>Costs</dt><dd>${num.format(p.cost)} ${p.resource === "darkElixir" ? "dark elixir" : p.resource}</dd></div>
    </dl>
    <p class="why"><strong>Why now:</strong> ${esc(REASON[p.reason])}.${p.timePcts.length ? ` Discounts applied: ${p.timePcts.map((x) => `${x}%`).join(" and ")}.` : ""}${item ? ` Finished early with ${esc(item.name)}.` : ""}</p>`;
}

function renderBoosters(c: Extract<Computed, { ok: true }>) {
  const plan = c.result.withItems.plan;
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
        ${stepper("stock", i.id, state.stock[i.id] ?? 0, "In hand")}
        ${stepper("month", i.id, state.perMonth[i.id] ?? 0, "Per month")}
      </div>
    </div>`;
  const uses = plan.itemUses
    .slice(0, 8)
    .map(
      (u) =>
        `<li>${glyph(items.find((i) => i.id === u.item)!)}<span>${esc(items.find((i) => i.id === u.item)?.name ?? u.item)}${u.stepId ? ` on ${esc(stepName(c.gd, plan.steps.find((s) => s.id === u.stepId)!))}` : ""}</span><span class="muted small">${esc(dayFmt().format(new Date(u.at * 1000)))}, saves ${span(u.savedSeconds)}</span></li>`,
    );
  const wasted = plan.wasted.reduce((n, w) => n + w.count, 0);
  $("boosters").innerHTML = `
    <div class="section-head"><h3>Magic items</h3><span class="chip ${c.result.savedSeconds > 0 ? "good" : ""}">${c.result.savedSeconds > 0 ? `${span(c.result.savedSeconds)} sooner` : "No time saved yet"}</span></div>
    <p class="muted small">The example stock is made up: set what you have and what you expect each month from the passes and Clan Games.</p>
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
        <label class="field" for="book-days">Books on upgrades with at least <span class="inline"><input id="book-days" type="number" min="0" max="30" step="0.5" value="${state.rules.bookMinDays}" data-bind="book-days"/> days left</span></label>
        <label class="field" for="hammer-days">Hammers on upgrades of at least <span class="inline"><input id="hammer-days" type="number" min="0" max="30" step="0.5" value="${state.rules.hammerMinDays}" data-bind="hammer-days"/> days</span></label>
      </div>
      <label class="toggle" for="save-books"><input type="checkbox" id="save-books" data-bind="save-books" ${state.rules.saveBooksForFullPrice ? "checked" : ""}/> <span>Keep books while an event discount runs</span></label>
      <label class="toggle" for="potions-auto"><input type="checkbox" id="potions-auto" data-bind="potions-auto" ${state.rules.potions === "auto" ? "checked" : ""}/> <span>Use potions when every worker of a lane is busy for long enough</span></label>
    </details>
    <h4>Planned uses</h4>
    ${uses.length ? `<ul class="uses">${uses.join("")}</ul>${plan.itemUses.length > uses.length ? `<p class="muted small">and ${plan.itemUses.length - uses.length} more</p>` : ""}` : `<p class="muted small">None: no upgrade meets the rules above with the items in hand.</p>`}
    ${wasted ? `<p class="warn small">${wasted} item${wasted === 1 ? "" : "s"} would arrive past the holding limit and be lost.</p>` : ""}`;
}

function stepper(kind: "stock" | "month", id: string, value: number, label: string) {
  return `<div class="stepper" role="group" aria-label="${label}">
    <span class="muted small">${label}</span>
    <button type="button" data-action="${kind}-" data-item="${id}" aria-label="One less" ${value <= 0 ? "disabled" : ""}>−</button>
    <output>${value}</output>
    <button type="button" data-action="${kind}+" data-item="${id}" aria-label="One more">+</button>
  </div>`;
}

function renderEvents(c: Extract<Computed, { ok: true }>) {
  const from = c.village.exportedAt;
  const on = (e: GameEvent) =>
    state.enabled ? state.enabled.includes(e.id) : e.status === "confirmed";
  const rows = gameEvents.map((e) => {
    const past = !!e.end && Date.parse(e.end) / 1000 <= from;
    const homeEffect = e.effects.some(
      (f) => f.kind === "noHeroUpgrades" || (f.kind === "discount" && f.villages.includes("home")),
    );
    const effect = e.effects
      .map((f) =>
        f.kind === "discount"
          ? `${f.timePct}% off time, ${f.costPct}% off cost (${f.villages.join(", ")} village)`
          : "No hero upgrades start",
      )
      .join("; ");
    const dates =
      e.start && e.end
        ? `${dayFmt().format(new Date(Date.parse(e.start)))} to ${dayFmt().format(new Date(Date.parse(e.end)))}`
        : e.recurrence
          ? `Every month from the ${e.recurrence.startDay}${e.recurrence.startDay === 1 ? "st" : "th"}, ${e.recurrence.lengthDays} days`
          : "";
    const status = past ? "past" : e.status;
    return `<li class="event-row ${past ? "is-past" : ""}">
      <label class="toggle" for="ev-${esc(e.id)}"><input type="checkbox" id="ev-${esc(e.id)}" data-action="event" data-item="${esc(e.id)}" ${on(e) ? "checked" : ""} ${past || !homeEffect ? "disabled" : ""}/>
      <span><strong>${esc(e.name)}</strong><span class="muted small block">${esc(dates)} · ${esc(effect)}</span></span></label>
      <span class="chip ${status === "confirmed" ? "good" : status === "projected" ? "warn" : ""}">${status === "projected" ? "Estimate" : status === "past" ? "Over" : "Confirmed"}</span>
    </li>`;
  });
  $("events").innerHTML =
    `<div class="section-head"><h3>Events</h3></div><ul class="events">${rows.join("")}</ul>
    <p class="muted small">Estimates are off until you switch them on. Builder Base events do not change the home village plan.</p>`;
}

function renderUpcoming(c: Extract<Computed, { ok: true }>) {
  const plan = c.result.withItems.plan;
  const list = plan.steps.filter((p) => p.reason !== "running" && p.worker !== null);
  const shown = state.showAll ? list : list.slice(0, 12);
  $("upcoming").innerHTML = `
    <div class="section-head"><h3>Upgrade order</h3><span class="muted small">${list.length} upgrades</span></div>
    <ol class="order">
      ${shown
        .map(
          (
            p,
          ) => `<li><button type="button" class="order-row ${state.selected === p.id ? "selected" : ""}" data-action="select" data-step="${esc(p.id)}">
        <i class="key ${p.lane}"></i>
        <span class="order-name">${esc(stepName(c.gd, p))}</span>
        <span class="muted small">${esc(workerName(plan, p.worker))}</span>
        <span class="order-when">${esc(when(p.start))}</span>
        <span class="muted small order-took">${span(p.seconds)}</span>
      </button></li>`,
        )
        .join("")}
    </ol>
    ${list.length > 12 ? `<button class="link" type="button" data-action="show-all">${state.showAll ? "Show the first 12" : `Show all ${list.length}`}</button>` : ""}`;
}

function renderReport(c: Extract<Computed, { ok: true }>) {
  const r = c.report;
  $("report").innerHTML = `
    <details>
      <summary>Import report: ${r.totals.instances} buildings and levels read, ${r.totals.upgrading} upgrading, ${r.warnings.length} warning${r.warnings.length === 1 ? "" : "s"}</summary>
      <ul class="small">
        ${r.sections.map((s) => `<li>${esc(s.key)}: ${s.rows} rows, ${s.use === "unknown" ? "not recognised" : s.use === "ignore" ? "not used for the plan" : "planned"}</li>`).join("")}
        ${r.unknownIds.length ? `<li>${r.unknownIds.length} unknown ids, left out of the plan</li>` : ""}
        ${r.warnings.map((w) => `<li class="warn">${esc(w.message)}</li>`).join("")}
        ${c.work.notes.map((n) => `<li class="muted">${esc(n)}</li>`).join("")}
      </ul>
      <p class="muted small">Plan hash ${c.result.withItems.hash.slice(0, 12)} · game data ${esc(c.gd.version)}</p>
    </details>`;
}

// --- Events ----------------------------------------------------------------------------------
let pending = 0;
const rerender = () => {
  cancelAnimationFrame(pending);
  pending = requestAnimationFrame(render);
};

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
    case "target":
      state.target = Number(value);
      break;
    case "strategy":
      state.strategy = value as Strategy;
      break;
    case "zoom":
      state.zoom = Number(value);
      break;
    case "stock+":
      bump(state.stock, 1, hold);
      break;
    case "stock-":
      bump(state.stock, -1);
      break;
    case "month+":
      bump(state.perMonth, 1, 30);
      break;
    case "month-":
      bump(state.perMonth, -1);
      break;
    case "select":
      state.selected = el.dataset.step ?? null;
      break;
    case "show-all":
      state.showAll = !state.showAll;
      break;
    case "paste-toggle":
      state.pasteOpen = !state.pasteOpen;
      break;
    case "paste-clear":
      state.pasted = null;
      state.target = null;
      break;
    case "paste-plan": {
      const text = (document.getElementById("paste-text") as HTMLTextAreaElement).value.trim();
      state.pasted = text || null;
      state.target = null;
      state.selected = null;
      break;
    }
    case "event":
      return; // handled on change
    default:
      return;
  }
  rerender();
});

document.addEventListener("keydown", (ev) => {
  const el = (ev.target as Element).closest<HTMLElement>("[data-action='select']");
  if (el && (ev.key === "Enter" || ev.key === " ")) {
    ev.preventDefault();
    state.selected = el.dataset.step ?? null;
    rerender();
  }
});

document.addEventListener("change", (ev) => {
  const el = ev.target as HTMLInputElement;
  const bind = el.dataset.bind;
  if (el.dataset.action === "event") {
    const id = el.dataset.item!;
    const current =
      state.enabled ?? gameEvents.filter((e) => e.status === "confirmed").map((e) => e.id);
    state.enabled = el.checked ? [...new Set([...current, id])] : current.filter((x) => x !== id);
    rerender();
    return;
  }
  switch (bind) {
    case "dataset":
      state.dataSet = el.value as DataSet;
      state.target = null;
      state.selected = null;
      state.pasted = null;
      break;
    case "goldpass":
      state.goldPass = el.checked;
      break;
    case "offline-on":
      state.offline.on = el.checked;
      break;
    case "offline-from":
      state.offline.from = el.value || state.offline.from;
      break;
    case "offline-to":
      state.offline.to = el.value || state.offline.to;
      break;
    case "book-days":
      state.rules = { ...state.rules, bookMinDays: Math.max(0, Number(el.value) || 0) };
      break;
    case "hammer-days":
      state.rules = { ...state.rules, hammerMinDays: Math.max(0, Number(el.value) || 0) };
      break;
    case "save-books":
      state.rules = { ...state.rules, saveBooksForFullPrice: el.checked };
      break;
    case "potions-auto":
      state.rules = { ...state.rules, potions: el.checked ? "auto" : "off" };
      break;
    default:
      return;
  }
  rerender();
});

let resizeTimer = 0;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => last?.ok && renderTimeline(last), 150);
});

render();

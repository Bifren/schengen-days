const DAY_MS = 24 * 60 * 60 * 1000;
const KEY = "schengen_days_trips_v3";

let trips = [];
let editingIndex = null;
let toastTimer;
let undoTimer;
let pendingDeleted = null;
let userTouchedExit = false;

const el = (id) => document.getElementById(id);

function parseYMD(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ""));
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const ts = Date.UTC(y, mo - 1, d);
  const dt = new Date(ts);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return { y, mo, d };
}

function toDayIndex(ymd) {
  const p = parseYMD(ymd);
  if (!p) return null;
  return Math.floor(Date.UTC(p.y, p.mo - 1, p.d) / DAY_MS);
}

function fromDayIndex(i) {
  return new Date(i * DAY_MS).toISOString().slice(0, 10);
}

function addDays(dayIndex, n) {
  return dayIndex + n;
}

function diffDaysInclusive(startIndex, endIndex) {
  if (endIndex < startIndex) return 0;
  return endIndex - startIndex + 1;
}

function fmtYMD(ymd) {
  const i = toDayIndex(ymd);
  if (i === null) return "—";
  return new Date(i * DAY_MS).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    timeZone: "UTC"
  });
}

function normalizeTrips(list) {
  const indexed = [];
  for (const t of list || []) {
    const a = toDayIndex(t.entry);
    const b = toDayIndex(t.exit);
    if (a === null || b === null) continue;
    indexed.push(a <= b ? { entry: a, exit: b } : { entry: b, exit: a });
  }

  indexed.sort((x, y) => x.entry - y.entry);
  if (!indexed.length) return [];

  const merged = [indexed[0]];
  for (let i = 1; i < indexed.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = indexed[i];
    if (curr.entry <= prev.exit + 1) {
      if (curr.exit > prev.exit) prev.exit = curr.exit;
    } else {
      merged.push(curr);
    }
  }

  return merged.map((t) => ({ entry: fromDayIndex(t.entry), exit: fromDayIndex(t.exit) }));
}

function loadTrips() {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return normalizeTrips(parsed);
  } catch {
    return [];
  }
}

function saveTrips(nextTrips) {
  localStorage.setItem(KEY, JSON.stringify(normalizeTrips(nextTrips)));
}

function computeUsedDays(asOfDayIndex, sourceTrips = trips) {
  const normalized = normalizeTrips(sourceTrips);
  const windowStart = asOfDayIndex - 179;
  const windowEnd = asOfDayIndex;
  let used = 0;

  for (const t of normalized) {
    const s = toDayIndex(t.entry);
    const e = toDayIndex(t.exit);
    if (s === null || e === null) continue;
    const overlapStart = Math.max(s, windowStart);
    const overlapEnd = Math.min(e, windowEnd);
    used += diffDaysInclusive(overlapStart, overlapEnd);
  }

  return used;
}

function computeRemaining(asOfDayIndex, sourceTrips = trips) {
  return Math.max(0, 90 - computeUsedDays(asOfDayIndex, sourceTrips));
}

function getNextPossibleEntry(asOfDayIndex, sourceTrips = trips) {
  let d = asOfDayIndex;
  for (let i = 0; i < 730; i++) {
    if (computeRemaining(d, sourceTrips) > 0) return d;
    d = addDays(d, 1);
  }
  return asOfDayIndex;
}

function getHeroRisk(remaining) {
  if (remaining === 0) return "risk-critical";
  if (remaining <= 29) return "risk-danger";
  if (remaining <= 74) return "risk-warning";
  return "risk-safe";
}

function getDraftTrips() {
  const trip = { entry: el("entryDate").value, exit: el("exitDate").value };
  const eIdx = toDayIndex(trip.entry);
  const xIdx = toDayIndex(trip.exit);
  if (eIdx === null || xIdx === null || xIdx < eIdx) return [...trips];

  const next = [...trips];
  if (editingIndex === null) next.push(trip);
  else next[editingIndex] = trip;
  return normalizeTrips(next);
}

function selectedTripInfo() {
  const entry = el("entryDate").value;
  const exit = el("exitDate").value;
  const eIdx = toDayIndex(entry);
  const xIdx = toDayIndex(exit);

  if (eIdx === null || xIdx === null) {
    return { ok: false, days: null, msg: "", invalidOrder: false, warning: "" };
  }
  if (xIdx < eIdx) {
    return { ok: false, days: null, msg: "Exit date must be on or after entry date.", invalidOrder: true, warning: "" };
  }

  const today = Math.floor(Date.now() / DAY_MS);
  const usedWithDraft = computeUsedDays(today, getDraftTrips());
  const warning = usedWithDraft > 90 ? "Warning: this trip can exceed the 90-day limit in the current 180-day window." : "";

  return { ok: true, days: diffDaysInclusive(eIdx, xIdx), msg: "", invalidOrder: false, warning };
}

function syncTripForm() {
  const info = selectedTripInfo();
  el("tripLength").textContent = info.days === null ? "—" : `${info.days} days`;
  el("tripError").textContent = info.msg;
  el("tripWarning").textContent = info.warning;
  el("tripError").classList.toggle("hide", !info.msg);
  el("tripWarning").classList.toggle("hide", !info.warning);
  el("saveTripBtn").disabled = !info.ok;
  el("swapDatesBtn").classList.toggle("hide", !info.invalidOrder);
}

function setHero() {
  const todayIndex = Math.floor(Date.now() / DAY_MS);
  const used = computeUsedDays(todayIndex);
  const remaining = Math.max(0, 90 - used);

  const hero = el("hero");
  hero.classList.remove("risk-safe", "risk-warning", "risk-danger", "risk-critical");
  hero.classList.add(getHeroRisk(remaining));

  const radius = 62;
  const circumference = 2 * Math.PI * radius;
  const progress = Math.max(0, Math.min(1, remaining / 90));
  const ring = el("heroRingProgress");
  ring.style.strokeDasharray = `${circumference.toFixed(2)} ${circumference.toFixed(2)}`;
  ring.style.strokeDashoffset = (circumference * (1 - progress)).toFixed(2);

  el("ringNumber").textContent = String(remaining);
  el("heroLabel").textContent = "Days left";

  if (used > 90) {
    const overstayDays = used - 90;
    const next = getNextPossibleEntry(todayIndex);
    el("heroSentence").textContent = `Overstay by ${overstayDays} day(s). Next possible entry: ${fmtYMD(fromDayIndex(next))}.`;
    return;
  }

  const stayDays = remaining > 0 ? remaining : 1;
  const leaveBy = addDays(todayIndex, stayDays - 1);
  el("heroSentence").textContent = `If you enter today, you must leave by ${fmtYMD(fromDayIndex(leaveBy))}.`;
}

function renderTimeline() {
  const grid = el("timelineGrid");
  const empty = el("timelineEmpty");
  const meta = el("timelineMeta");
  grid.innerHTML = "";

  if (!trips.length) {
    empty.classList.remove("hide");
    meta.classList.add("hide");
    grid.classList.add("hide");
    return;
  }

  empty.classList.add("hide");
  meta.classList.remove("hide");
  grid.classList.remove("hide");

  const today = Math.floor(Date.now() / DAY_MS);
  const start = today - 179;
  const usedSet = new Set();

  for (const t of normalizeTrips(trips)) {
    const s = toDayIndex(t.entry);
    const e = toDayIndex(t.exit);
    if (s === null || e === null) continue;
    const from = Math.max(s, start);
    const to = Math.min(e, today);
    for (let d = from; d <= to; d++) usedSet.add(d);
  }

  for (let d = start; d <= today; d++) {
    const cell = document.createElement("div");
    cell.className = "dayCell";
    if (usedSet.has(d)) cell.classList.add("used");
    if (d === today) cell.classList.add("today");
    grid.appendChild(cell);
  }

  meta.textContent = `Window: ${fmtYMD(fromDayIndex(start))} — ${fmtYMD(fromDayIndex(today))} • Used: ${computeUsedDays(today, trips)}/90 • Left: ${computeRemaining(today, trips)}`;
}

function showToast(text, canUndo = false) {
  el("toastText").textContent = text;
  el("undoBtn").classList.toggle("hide", !canUndo);
  el("toast").classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el("toast").classList.remove("show");
    el("undoBtn").classList.add("hide");
  }, canUndo ? 5200 : 1700);
}

function openModal() {
  el("tripModal").classList.add("open");
  el("tripModal").setAttribute("aria-hidden", "false");
}

function closeModal() {
  el("tripModal").classList.remove("open");
  el("tripModal").setAttribute("aria-hidden", "true");
}

function quickSet(n, btn = null) {
  let entry = el("entryDate").value;
  if (toDayIndex(entry) === null) {
    entry = fromDayIndex(Math.floor(Date.now() / DAY_MS));
    el("entryDate").value = entry;
  }
  const endIdx = addDays(toDayIndex(entry), Number(n) - 1);
  el("exitDate").value = fromDayIndex(endIdx);
  userTouchedExit = true;
  syncTripForm();
  if (btn) {
    document.querySelectorAll(".quickBtn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
  }
}

function autoSuggestExitFromEntry() {
  const entry = el("entryDate").value;
  const startIdx = toDayIndex(entry);
  if (startIdx === null) return;

  if (!userTouchedExit || toDayIndex(el("exitDate").value) === null) {
    const suggested = addDays(startIdx, 6);
    el("exitDate").value = fromDayIndex(suggested);
  }
}

function swapDates() {
  const entry = el("entryDate").value;
  const exit = el("exitDate").value;
  if (!entry || !exit) return;
  el("entryDate").value = exit;
  el("exitDate").value = entry;
  userTouchedExit = true;
  syncTripForm();
}

function saveTripFromForm() {
  const info = selectedTripInfo();
  if (!info.ok) return;

  const trip = { entry: el("entryDate").value, exit: el("exitDate").value };
  if (editingIndex === null) {
    trips.push(trip);
    showToast("Trip saved");
  } else {
    trips[editingIndex] = trip;
    showToast("Trip updated");
  }

  trips = normalizeTrips(trips);
  saveTrips(trips);
  clearEditMode();
  closeModal();
  render();
}

function setEditMode(index) {
  editingIndex = index;
  const t = trips[index];
  el("entryDate").value = t.entry;
  el("exitDate").value = t.exit;
  userTouchedExit = true;
  el("cancelEditBtn").classList.remove("hide");
  syncTripForm();
  document.querySelectorAll(".quickBtn").forEach((b) => b.classList.remove("active"));
  openModal();
}

function clearEditMode() {
  editingIndex = null;
  userTouchedExit = false;
  el("cancelEditBtn").classList.add("hide");
  syncTripForm();
  document.querySelectorAll(".quickBtn").forEach((b) => b.classList.remove("active"));
}

function deleteTrip(index) {
  pendingDeleted = { trip: trips[index], index };
  trips.splice(index, 1);
  trips = normalizeTrips(trips);
  saveTrips(trips);
  render();
  showToast("Trip deleted — Undo", true);

  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => {
    pendingDeleted = null;
    el("undoBtn").classList.add("hide");
  }, 5000);
}

function undoDelete() {
  if (!pendingDeleted) return;
  trips.splice(Math.min(pendingDeleted.index, trips.length), 0, pendingDeleted.trip);
  trips = normalizeTrips(trips);
  saveTrips(trips);
  pendingDeleted = null;
  clearTimeout(undoTimer);
  render();
  showToast("Trip restored");
}

function renderTrips() {
  const list = el("tripsList");
  list.innerHTML = "";
  el("tripsEmpty").classList.toggle("hide", trips.length > 0);

  for (let i = trips.length - 1; i >= 0; i--) {
    const t = trips[i];
    const len = diffDaysInclusive(toDayIndex(t.entry), toDayIndex(t.exit));
    const row = document.createElement("div");
    row.className = "tripRow";
    row.innerHTML = `
      <div>
        <div class="tripMain">${fmtYMD(t.entry)} → ${fmtYMD(t.exit)}</div>
        <div class="tripSub">${len} days</div>
      </div>
      <div class="rowBtns">
        <button class="secondary iconBtn" data-edit="${i}" aria-label="Edit trip">
          <svg class="icon" viewBox="0 0 24 24" fill="none"><path d="M4 20h4l10-10-4-4L4 16v4Z" stroke="currentColor" stroke-width="2"/><path d="m12 6 4 4" stroke="currentColor" stroke-width="2"/></svg>
          Edit
        </button>
        <button class="secondary iconBtn" data-del="${i}" aria-label="Delete trip">
          <svg class="icon" viewBox="0 0 24 24" fill="none"><path d="M4 7h16" stroke="currentColor" stroke-width="2"/><path d="M7 7l1 13h8l1-13" stroke="currentColor" stroke-width="2"/><path d="M9 7V4h6v3" stroke="currentColor" stroke-width="2"/></svg>
          Delete
        </button>
      </div>
    `;
    list.appendChild(row);
  }
}

function render() {
  setHero();
  renderTimeline();
  renderTrips();
  syncTripForm();
}

function runSelfChecks() {
  const errors = [];

  const len = diffDaysInclusive(toDayIndex("2026-02-10"), toDayIndex("2026-02-17"));
  if (len !== 8) errors.push("inclusive length failed: expected 8");

  const asOf = toDayIndex("2026-02-19");
  const start = asOf - 179;
  if (fromDayIndex(start) !== "2025-08-24") errors.push("window start failed: expected 2025-08-24");

  const used = computeUsedDays(asOf, [{ entry: "2026-02-10", exit: "2026-02-17" }]);
  if (used !== 8) errors.push("simple used days failed: expected 8");

  if (errors.length) errors.forEach((msg) => console.error(`[self-check] ${msg}`));
}

document.addEventListener("DOMContentLoaded", () => {
  trips = loadTrips();

  const todayIdx = Math.floor(Date.now() / DAY_MS);
  el("entryDate").value = fromDayIndex(todayIdx);
  el("exitDate").value = fromDayIndex(addDays(todayIdx, 6));

  el("entryDate").addEventListener("change", () => {
    autoSuggestExitFromEntry();
    syncTripForm();
  });

  el("exitDate").addEventListener("change", () => {
    userTouchedExit = true;
    syncTripForm();
  });

  el("openAddTripBtn").addEventListener("click", () => {
    clearEditMode();
    openModal();
  });
  el("closeTripModalBtn").addEventListener("click", closeModal);
  el("modalBackdrop").addEventListener("click", closeModal);

  el("saveTripBtn").addEventListener("click", saveTripFromForm);
  el("cancelEditBtn").addEventListener("click", clearEditMode);
  el("swapDatesBtn").addEventListener("click", swapDates);

  document.querySelectorAll("[data-quick]").forEach((btn) => {
    btn.addEventListener("click", () => quickSet(btn.dataset.quick, btn));
  });

  el("tripsList").addEventListener("click", (e) => {
    const edit = e.target.closest("[data-edit]")?.dataset.edit;
    const del = e.target.closest("[data-del]")?.dataset.del;
    if (typeof edit !== "undefined") return setEditMode(Number(edit));
    if (typeof del !== "undefined") deleteTrip(Number(del));
  });

  el("undoBtn").addEventListener("click", undoDelete);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModal();
  });

  runSelfChecks();
  render();
});

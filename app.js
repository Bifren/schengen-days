// ---------- Utilities ----------
const dayMs = 24 * 60 * 60 * 1000;

function toDay(dateStrOrDate) {
  const d = (dateStrOrDate instanceof Date)
    ? dateStrOrDate
    : new Date(dateStrOrDate + "T00:00:00");
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function fmt(d) {
  if (!d) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "2-digit" });
}

function daysInclusive(a, b) {
  const A = toDay(a).getTime();
  const B = toDay(b).getTime();
  if (B < A) return 0;
  return Math.floor((B - A) / dayMs) + 1;
}

function clampTrip(trip) {
  const a = toDay(trip.entry);
  const b = toDay(trip.exit);
  return { id: trip.id, entry: (a <= b) ? a : b, exit: (a <= b) ? b : a };
}

function window180(refDate) {
  const end = toDay(refDate);
  const start = new Date(end.getTime() - 179 * dayMs); // inclusive window of 180 days
  return { start, end };
}

function overlapDaysInclusive(aStart, aEnd, bStart, bEnd) {
  const start = (aStart > bStart) ? aStart : bStart;
  const end = (aEnd < bEnd) ? aEnd : bEnd;
  if (start > end) return 0;
  return daysInclusive(start, end);
}

// ---------- Storage ----------
const KEY = "schengen_days_trips_v2";

function loadTrips() {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? JSON.parse(raw) : [];
    return list.map(t => clampTrip(t));
  } catch { return []; }
}

function saveTrips(trips) {
  const raw = trips.map(t => ({
    id: t.id,
    entry: t.entry.toISOString().slice(0, 10),
    exit:  t.exit.toISOString().slice(0, 10)
  }));
  localStorage.setItem(KEY, JSON.stringify(raw));
}

// ---------- Core calc ----------
function daysUsedLast180(refDate, trips) {
  const w = window180(refDate);
  let sum = 0;
  for (const t of trips) sum += overlapDaysInclusive(w.start, w.end, t.entry, t.exit);
  return sum;
}

function remainingLast180(refDate, trips) {
  return Math.max(0, 90 - daysUsedLast180(refDate, trips));
}

function status(refDate, trips) {
  const used = daysUsedLast180(refDate, trips);
  if (used > 90) return "overstay";
  if (used >= 80) return "warning";
  return "safe";
}

// Planner: simulate presence day-by-day
function maxStayDays(entryDate, trips) {
  const entry = toDay(entryDate);
  let days = 0;
  for (; days < 366; days++) {
    const current = new Date(entry.getTime() + days * dayMs);
    const usedExisting = daysUsedLast180(current, trips);
    const w = window180(current);
    const extra = overlapDaysInclusive(w.start, w.end, entry, current);
    if (usedExisting + extra > 90) break;
  }
  return Math.max(0, days - 1);
}

function latestExit(entryDate, trips) {
  const maxDays = maxStayDays(entryDate, trips);
  if (maxDays <= 0) return null;
  const entry = toDay(entryDate);
  return new Date(entry.getTime() + (maxDays - 1) * dayMs);
}

function nextSafeEntryDate(startDate, trips) {
  let d = toDay(startDate);
  for (let i = 0; i < 730; i++) {
    if (remainingLast180(d, trips) > 0) return d;
    d = new Date(d.getTime() + dayMs);
  }
  return toDay(startDate);
}

// ---------- UI ----------
let trips = loadTrips();
const el = (id) => document.getElementById(id);

function setBadge(kind) {
  const b = el("statusBadge");
  b.classList.remove("b-ok","b-warn","b-bad");
  if (kind === "safe") { b.classList.add("b-ok"); b.textContent = "Safe"; }
  if (kind === "warning") { b.classList.add("b-warn"); b.textContent = "Warning"; }
  if (kind === "overstay") { b.classList.add("b-bad"); b.textContent = "Overstay"; }
}

function selectedTripDays() {
  const entry = el("entryDate").value;
  const exit = el("exitDate").value;
  if (!entry || !exit) return { ok:false, days: 0, msg: "Select both dates." };
  const a = toDay(entry), b = toDay(exit);
  if (b < a) return { ok:false, days: 0, msg: "Exit date must be on or after entry date." };
  const d = daysInclusive(a, b);
  return { ok:true, days: d, msg: "" };
}

function syncSelectedUI() {
  const info = selectedTripDays();
  el("selectedDays").textContent = String(Math.max(1, info.days || 1));
  const addBtn = el("addTripBtn");
  addBtn.disabled = !info.ok;
  el("error").textContent = info.ok ? "" : info.msg;
}

function render() {
  const now = new Date();
  const used = daysUsedLast180(now, trips);
  const rem  = remainingLast180(now, trips);

  el("used").textContent = String(used);
  el("remaining").textContent = String(rem);
  el("asOf").textContent = fmt(now);
  el("usedOf90").textContent = String(Math.min(90, used));

  // progress bar (0..100)
  const p = Math.max(0, Math.min(100, (used / 90) * 100));
  const bar = el("progressBar");
  bar.style.width = p.toFixed(1) + "%";
  // color thresholds
  if (used >= 90) bar.style.background = "var(--bad)";
  else if (used >= 80) bar.style.background = "var(--warn)";
  else bar.style.background = "var(--ok)";

  setBadge(status(now, trips));

  const nextSafe = (rem > 0) ? now : nextSafeEntryDate(now, trips);
  el("nextSafe").textContent = fmt(nextSafe);

  // Trips tab
  el("tripCount").textContent = String(trips.length);
  el("tripsEmpty").classList.toggle("hide", trips.length !== 0);
  el("tripsTableWrap").classList.toggle("hide", trips.length === 0);

  const tbody = el("tripsTbody");
  tbody.innerHTML = "";
  for (const t of trips.slice().sort((a,b) => b.entry - a.entry)) {
    const tr = document.createElement("tr");
    const d = daysInclusive(t.entry, t.exit);
    tr.innerHTML = `
      <td>${fmt(t.entry)} → ${fmt(t.exit)}</td>
      <td class="right">${d}</td>
      <td class="right"><button class="danger" data-del="${t.id}">Delete</button></td>
    `;
    tbody.appendChild(tr);
  }

  // Planner
  const planEntry = el("planEntry").value;
  if (planEntry) {
    const m = maxStayDays(planEntry, trips);
    const le = latestExit(planEntry, trips);
    const ns = nextSafeEntryDate(planEntry, trips);
    el("planMaxStay").textContent = String(m);
    el("planLatestExit").textContent = fmt(le);
    el("planNextSafe").textContent = fmt(ns);
  } else {
    el("planMaxStay").textContent = "0";
    el("planLatestExit").textContent = "—";
    el("planNextSafe").textContent = "—";
  }
}

function addTrip() {
  const info = selectedTripDays();
  if (!info.ok) { syncSelectedUI(); return; }

  const entry = el("entryDate").value;
  const exit  = el("exitDate").value;

  const t = clampTrip({ id: crypto.randomUUID(), entry, exit });
  trips.push(t);
  saveTrips(trips);

  render();
}

function deleteTrip(id) {
  trips = trips.filter(t => t.id !== id);
  saveTrips(trips);
  render();
}

// Bottom tabs
document.querySelectorAll(".tabBtn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tabBtn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    const tab = btn.dataset.tab;
    ["overview","trips","planner"].forEach(t => {
      el("tab-" + t).classList.toggle("hide", t !== tab);
    });
  });
});

// Actions
el("addTripBtn").addEventListener("click", addTrip);
el("tripsTbody").addEventListener("click", (e) => {
  const id = e.target?.dataset?.del;
  if (id) deleteTrip(id);
});
el("planEntry").addEventListener("change", render);

el("resetBtn").addEventListener("click", () => {
  if (confirm("Reset all trips on this device?")) {
    trips = [];
    saveTrips(trips);
    render();
  }
});

// Live update “Selected days” + button state
el("entryDate").addEventListener("change", () => { syncSelectedUI(); });
el("exitDate").addEventListener("change", () => { syncSelectedUI(); });

// Init defaults
(function init() {
  const today = new Date();
  const iso = today.toISOString().slice(0,10);
  el("entryDate").value = iso;
  el("exitDate").value = iso;
  el("planEntry").value = iso;
  syncSelectedUI();
  render();
})();

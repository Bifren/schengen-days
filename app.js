// ---------- Utilities ----------
const dayMs = 24 * 60 * 60 * 1000;

function toDay(dateStrOrDate) {
  const d = (dateStrOrDate instanceof Date) ? dateStrOrDate : new Date(dateStrOrDate + "T00:00:00");
  // normalize to local start of day
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
  return {
    entry: (a <= b) ? a : b,
    exit:  (a <= b) ? b : a,
    id: trip.id
  };
}

function window180(refDate) {
  const end = toDay(refDate);
  const start = new Date(end.getTime() - 179 * dayMs);
  return { start, end };
}

function overlapDaysInclusive(aStart, aEnd, bStart, bEnd) {
  const start = (aStart > bStart) ? aStart : bStart;
  const end = (aEnd < bEnd) ? aEnd : bEnd;
  if (start > end) return 0;
  return daysInclusive(start, end);
}

// ---------- Storage ----------
const KEY = "schengen_days_trips_v1";

function loadTrips() {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? JSON.parse(raw) : [];
    return list.map(t => clampTrip(t));
  } catch {
    return [];
  }
}

function saveTrips(trips) {
  const raw = trips.map(t => ({ id: t.id, entry: t.entry.toISOString().slice(0,10), exit: t.exit.toISOString().slice(0,10) }));
  localStorage.setItem(KEY, JSON.stringify(raw));
}

// ---------- Core calc ----------
function daysUsedLast180(refDate, trips) {
  const w = window180(refDate);
  let sum = 0;
  for (const t of trips) {
    sum += overlapDaysInclusive(w.start, w.end, t.entry, t.exit);
  }
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

    // used by existing trips on this current day
    const usedExisting = daysUsedLast180(current, trips);

    // plus virtual trip [entry..current]
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

function render() {
  const now = new Date();
  const used = daysUsedLast180(now, trips);
  const rem = remainingLast180(now, trips);
  el("used").textContent = String(used);
  el("remaining").textContent = String(rem);
  el("asOf").textContent = fmt(now);

  setBadge(status(now, trips));

  const nextSafe = (rem > 0) ? now : nextSafeEntryDate(now, trips);
  el("nextSafe").textContent = fmt(nextSafe);

  // trips tab
  el("tripCount").textContent = String(trips.length);
  el("tripsEmpty").classList.toggle("hide", trips.length !== 0);
  el("tripsTableWrap").classList.toggle("hide", trips.length === 0);

  const tbody = el("tripsTbody");
  tbody.innerHTML = "";
  for (const t of trips.slice().sort((a,b) => b.entry - a.entry)) {
    const tr = document.createElement("tr");
    const days = daysInclusive(t.entry, t.exit);
    tr.innerHTML = `
      <td>${fmt(t.entry)} → ${fmt(t.exit)}</td>
      <td class="right">${days}</td>
      <td class="right">
        <button class="danger" data-del="${t.id}">Delete</button>
      </td>
    `;
    tbody.appendChild(tr);
  }

  // planner
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

function addTrip(entry, exit) {
  const err = el("error");
  err.textContent = "";
  if (!entry || !exit) { err.textContent = "Please select both dates."; return; }
  const a = toDay(entry), b = toDay(exit);
  if (b < a) { err.textContent = "Exit date must be on or after entry date."; return; }
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

// Tabs
document.querySelectorAll(".tab").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    const tab = btn.dataset.tab;
    ["overview","trips","planner"].forEach(t => {
      el("tab-" + t).classList.toggle("hide", t !== tab);
    });
  });
});

// Actions
el("addTripBtn").addEventListener("click", () => addTrip(el("entryDate").value, el("exitDate").value));

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

// Init default dates
(function init() {
  const today = new Date();
  const iso = today.toISOString().slice(0,10);
  el("entryDate").value = iso;
  el("exitDate").value = iso;
  el("planEntry").value = iso;
  render();
})();

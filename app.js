// ---------- Utilities ----------
const dayMs = 24 * 60 * 60 * 1000;

function toDay(dateStrOrDate) {
  const d = (dateStrOrDate instanceof Date)
    ? dateStrOrDate
    : new Date(dateStrOrDate + "T00:00:00");
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function toISO(d) {
  return toDay(d).toISOString().slice(0, 10);
}

function fmt(d) {
  if (!d) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "2-digit" });
}

function addDays(date, n) {
  return new Date(toDay(date).getTime() + n * dayMs);
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
  return { entry: (a <= b) ? a : b, exit: (a <= b) ? b : a };
}

function normalizeTrips(trips) {
  const prepared = trips.map(clampTrip).sort((a, b) => a.entry - b.entry);
  if (prepared.length === 0) return [];

  const merged = [prepared[0]];
  for (let i = 1; i < prepared.length; i++) {
    const curr = prepared[i];
    const prev = merged[merged.length - 1];
    const prevPlusOne = addDays(prev.exit, 1);

    if (curr.entry <= prevPlusOne) {
      if (curr.exit > prev.exit) prev.exit = curr.exit;
    } else {
      merged.push(curr);
    }
  }
  return merged;
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

function vibrate(ms = 12) {
  if (navigator.vibrate) navigator.vibrate(ms);
}

// ---------- Storage ----------
const KEY = "schengen_days_trips_v3";

function loadTrips() {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? JSON.parse(raw) : [];
    return normalizeTrips(list);
  } catch {
    return [];
  }
}

function saveTrips(trips) {
  const normalized = normalizeTrips(trips);
  const raw = normalized.map(t => ({
    entry: toISO(t.entry),
    exit: toISO(t.exit)
  }));
  localStorage.setItem(KEY, JSON.stringify(raw));
}

// ---------- Core calc ----------
function daysUsedLast180(refDate, trips) {
  const normalized = normalizeTrips(trips);
  const w = window180(refDate);
  let sum = 0;
  for (const t of normalized) {
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

function maxStayDays(entryDate, trips) {
  const entry = toDay(entryDate);
  let days = 0;
  for (; days < 366; days++) {
    const current = addDays(entry, days);
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
  return addDays(entryDate, maxDays - 1);
}

function nextSafeEntryDate(startDate, trips) {
  let d = toDay(startDate);
  for (let i = 0; i < 730; i++) {
    if (remainingLast180(d, trips) > 0) return d;
    d = addDays(d, 1);
  }
  return toDay(startDate);
}

function calculationDetails(refDate, trips) {
  const w = window180(refDate);
  const normalized = normalizeTrips(trips);
  const rows = [];

  for (const t of normalized) {
    const inWindow = overlapDaysInclusive(w.start, w.end, t.entry, t.exit);
    if (inWindow > 0) {
      rows.push({ entry: t.entry, exit: t.exit, daysInWindow: inWindow });
    }
  }

  const used = rows.reduce((acc, row) => acc + row.daysInWindow, 0);
  return {
    windowStart: w.start,
    windowEnd: w.end,
    rows,
    used,
    remaining: Math.max(0, 90 - used)
  };
}

// ---------- UI ----------
let trips = loadTrips();
let toastTimer;
let editingIndex = null;
const el = (id) => document.getElementById(id);
const ringRadius = 74;
const ringCircumference = 2 * Math.PI * ringRadius;

function updateGlobeRing(used, remaining) {
  const progress = Math.max(0, Math.min(1, used / 90));
  const ring = el("globeRingProgress");
  ring.style.strokeDasharray = `${ringCircumference.toFixed(2)} ${ringCircumference.toFixed(2)}`;
  ring.style.strokeDashoffset = (ringCircumference * (1 - progress)).toFixed(2);

  el("globeRingUsed").textContent = `Used: ${used} / 90`;
  el("globeRingRemaining").textContent = `Remaining: ${remaining}`;

  const host = el("globeRing");
  host.classList.remove("state-safe", "state-warning", "state-danger");
  if (used >= 90) host.classList.add("state-danger");
  else if (used >= 61) host.classList.add("state-warning");
  else host.classList.add("state-safe");

  host.setAttribute("aria-label", `Schengen days used: ${used} out of 90, remaining ${remaining}`);
}

function showToast(text) {
  const t = el("toast");
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 1700);
}

function setBadge(kind) {
  const b = el("statusBadge");
  b.classList.remove("b-ok", "b-warn", "b-bad");
  if (kind === "safe") { b.classList.add("b-ok"); b.textContent = "Safe"; }
  if (kind === "warning") { b.classList.add("b-warn"); b.textContent = "Warning"; }
  if (kind === "overstay") { b.classList.add("b-bad"); b.textContent = "Overstay"; }
}

function selectedTripDays() {
  const entry = el("entryDate").value;
  const exit = el("exitDate").value;
  if (!entry || !exit) return { ok: false, days: 0, msg: "Select both dates." };
  const a = toDay(entry), b = toDay(exit);
  if (b < a) return { ok: false, days: 0, msg: "Exit date must be on or after entry date." };
  return { ok: true, days: daysInclusive(a, b), msg: "" };
}

function setEditMode(index) {
  editingIndex = index;
  const t = trips[index];
  el("entryDate").value = toISO(t.entry);
  el("exitDate").value = toISO(t.exit);
  el("addTripBtn").textContent = "Save changes";
  el("cancelEditBtn").classList.remove("hide");
  el("tripFormTitle").textContent = "Edit trip";
  syncSelectedUI();
}

function clearEditMode() {
  editingIndex = null;
  el("addTripBtn").textContent = "Add trip";
  el("cancelEditBtn").classList.add("hide");
  el("tripFormTitle").textContent = "Add a trip";
  syncSelectedUI();
}

function syncSelectedUI() {
  const info = selectedTripDays();
  el("selectedDays").textContent = String(Math.max(1, info.days || 1));
  el("addTripBtn").disabled = !info.ok;
  el("error").textContent = info.ok ? "" : info.msg;
}

function applyQuickPreset(kind) {
  const now = new Date();
  let entry = toDay(el("entryDate").value || now);
  let exit = toDay(el("exitDate").value || now);

  if (kind === "today") {
    entry = toDay(now);
    exit = toDay(now);
  } else if (kind === "weekend") {
    const day = now.getDay();
    const addToSaturday = (6 - day + 7) % 7;
    entry = addDays(now, addToSaturday);
    exit = addDays(entry, 1);
  } else {
    const extraDays = Number(kind);
    if (Number.isFinite(extraDays) && extraDays > 0) {
      entry = toDay(el("entryDate").value || now);
      exit = addDays(entry, extraDays - 1);
    }
  }

  el("entryDate").value = toISO(entry);
  el("exitDate").value = toISO(exit);
  syncSelectedUI();
  vibrate(8);
}

function renderDetails() {
  const refDate = el("detailsDate").value ? toDay(el("detailsDate").value) : toDay(new Date());
  const details = calculationDetails(refDate, trips);

  el("detailsWindow").textContent = `${fmt(details.windowStart)} → ${fmt(details.windowEnd)}`;
  el("detailsUsed").textContent = String(details.used);
  el("detailsRemaining").textContent = String(details.remaining);

  const tbody = el("detailsTbody");
  tbody.innerHTML = "";
  for (const row of details.rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${fmt(row.entry)} → ${fmt(row.exit)}</td>
      <td class="right">${row.daysInWindow}</td>
    `;
    tbody.appendChild(tr);
  }

  el("detailsEmpty").classList.toggle("hide", details.rows.length > 0);
  el("detailsTableWrap").classList.toggle("hide", details.rows.length === 0);
}

function openDetails() {
  el("detailsDate").value = toISO(new Date());
  renderDetails();
  el("detailsModal").classList.remove("hide");
}

function closeDetails() {
  el("detailsModal").classList.add("hide");
}

function render() {
  trips = normalizeTrips(trips);
  const now = new Date();
  const used = daysUsedLast180(now, trips);
  const rem = remainingLast180(now, trips);

  el("used").textContent = String(used);
  el("remaining").textContent = String(rem);
  el("asOf").textContent = fmt(now);
  el("usedOf90").textContent = String(Math.min(90, used));
  updateGlobeRing(used, rem);

  const p = Math.max(0, Math.min(100, (used / 90) * 100));
  const bar = el("progressBar");
  bar.style.width = p.toFixed(1) + "%";
  if (used >= 90) bar.style.background = "var(--bad)";
  else if (used >= 80) bar.style.background = "var(--warn)";
  else bar.style.background = "var(--ok)";

  setBadge(status(now, trips));
  const nextSafe = (rem > 0) ? now : nextSafeEntryDate(now, trips);
  el("nextSafe").textContent = fmt(nextSafe);

  el("tripCount").textContent = String(trips.length);
  el("tripsEmpty").classList.toggle("hide", trips.length !== 0);
  el("tripsTableWrap").classList.toggle("hide", trips.length === 0);

  const tbody = el("tripsTbody");
  tbody.innerHTML = "";
  for (let idx = trips.length - 1; idx >= 0; idx--) {
    const t = trips[idx];
    const d = daysInclusive(t.entry, t.exit);
    const tr = document.createElement("tr");
    tr.dataset.edit = String(idx);
    tr.innerHTML = `
      <td>${fmt(t.entry)} → ${fmt(t.exit)}</td>
      <td class="right">${d}</td>
      <td class="right">
        <button class="secondary" data-edit="${idx}">Edit</button>
        <button class="danger" data-del="${idx}">Delete</button>
      </td>
    `;
    tbody.appendChild(tr);
  }

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

function upsertTripFromForm() {
  const info = selectedTripDays();
  if (!info.ok) { syncSelectedUI(); return; }

  const newTrip = clampTrip({ entry: el("entryDate").value, exit: el("exitDate").value });

  if (editingIndex === null) {
    trips.push(newTrip);
    showToast(`Trip added • ${info.days} day(s)`);
  } else {
    trips[editingIndex] = newTrip;
    showToast("Trip updated");
  }

  trips = normalizeTrips(trips);
  saveTrips(trips);
  render();
  clearEditMode();
  vibrate(16);
}

function deleteTrip(index) {
  trips.splice(index, 1);
  trips = normalizeTrips(trips);
  saveTrips(trips);
  render();
  if (editingIndex !== null && editingIndex === index) clearEditMode();
  showToast("Trip deleted");
  vibrate(10);
}

function runSelfChecks() {
  const mergedOverlap = normalizeTrips([
    { entry: "2026-01-01", exit: "2026-01-05" },
    { entry: "2026-01-04", exit: "2026-01-10" }
  ]);
  console.assert(mergedOverlap.length === 1 && toISO(mergedOverlap[0].entry) === "2026-01-01" && toISO(mergedOverlap[0].exit) === "2026-01-10", "overlap merge failed");

  const mergedAdjacent = normalizeTrips([
    { entry: "2026-02-01", exit: "2026-02-05" },
    { entry: "2026-02-06", exit: "2026-02-10" }
  ]);
  console.assert(mergedAdjacent.length === 1 && toISO(mergedAdjacent[0].exit) === "2026-02-10", "adjacent merge failed");

  const futureTrip = [{ entry: addDays(new Date(), 20), exit: addDays(new Date(), 30) }];
  console.assert(daysUsedLast180(new Date(), futureTrip) === 0, "future-only trip should not affect today");

  console.assert(daysInclusive("2026-03-01", "2026-03-01") === 1, "inclusive counting failed");
}

// Bottom tabs
document.querySelectorAll(".tabBtn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tabBtn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    const tab = btn.dataset.tab;
    ["overview", "trips", "planner"].forEach(t => {
      el("tab-" + t).classList.toggle("hide", t !== tab);
    });
  });
});

document.querySelectorAll(".quickBtn").forEach(btn => {
  btn.addEventListener("click", () => applyQuickPreset(btn.dataset.preset));
});

el("addTripBtn").addEventListener("click", upsertTripFromForm);
el("cancelEditBtn").addEventListener("click", clearEditMode);

el("tripsTbody").addEventListener("click", (e) => {
  const editIndex = e.target?.dataset?.edit;
  const delIndex = e.target?.dataset?.del;

  if (typeof editIndex !== "undefined") {
    setEditMode(Number(editIndex));
    return;
  }

  if (typeof delIndex !== "undefined") {
    deleteTrip(Number(delIndex));
  }
});

el("planEntry").addEventListener("change", render);
el("detailsBtn").addEventListener("click", openDetails);
el("detailsCloseBtn").addEventListener("click", closeDetails);
el("detailsDate").addEventListener("change", renderDetails);
el("detailsModal").addEventListener("click", (e) => {
  if (e.target.id === "detailsModal") closeDetails();
});

el("resetBtn").addEventListener("click", () => {
  if (confirm("Reset all trips on this device?")) {
    trips = [];
    saveTrips(trips);
    render();
    clearEditMode();
    showToast("All trips reset");
  }
});

el("entryDate").addEventListener("change", syncSelectedUI);
el("exitDate").addEventListener("change", syncSelectedUI);

(function init() {
  const iso = toISO(new Date());
  el("entryDate").value = iso;
  el("exitDate").value = iso;
  el("planEntry").value = iso;
  el("detailsDate").value = iso;
  runSelfChecks();
  syncSelectedUI();
  render();
})();

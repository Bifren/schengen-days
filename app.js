/*
Manual test checklist:
1) Status is consistent across badge, hero ring, and progress bar (safe <60, warning 60..89, overstay >=90).
2) Details modal: closed on load, opens from Details, closes by Close, backdrop click, and Escape.
3) Modal a11y: focus trapped while open, focus restored to Details button, background inert + no scroll.
4) Next safe messaging: enter-now / next-safe date / overstay message.
5) Trip form: invalid/incomplete shows selected "—", swap button appears when exit < entry.
6) Delete undo works for 5s.
7) Export/Import JSON works and keeps localStorage key schengen_days_trips_v3.
*/

const dayMs = 24 * 60 * 60 * 1000;
const KEY = "schengen_days_trips_v3";
const ringRadius = 74;
const ringCircumference = 2 * Math.PI * ringRadius;

let trips = [];
let editingIndex = null;
let toastTimer;
let undoTimer;
let pendingDeletedTrip = null;
let lastFocusedEl = null;

const el = (id) => document.getElementById(id);

function toDay(dateStrOrDate) {
  const d = (dateStrOrDate instanceof Date) ? dateStrOrDate : new Date(dateStrOrDate + "T00:00:00");
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

function normalizeTrips(list) {
  const prepared = list.map(clampTrip).sort((a, b) => a.entry - b.entry);
  if (!prepared.length) return [];
  const merged = [prepared[0]];
  for (let i = 1; i < prepared.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = prepared[i];
    if (curr.entry <= addDays(prev.exit, 1)) {
      if (curr.exit > prev.exit) prev.exit = curr.exit;
    } else {
      merged.push(curr);
    }
  }
  return merged;
}

function loadTrips() {
  try {
    const raw = localStorage.getItem(KEY);
    return normalizeTrips(raw ? JSON.parse(raw) : []);
  } catch {
    return [];
  }
}

function saveTrips(nextTrips) {
  const normalized = normalizeTrips(nextTrips);
  const raw = normalized.map(t => ({ entry: toISO(t.entry), exit: toISO(t.exit) }));
  localStorage.setItem(KEY, JSON.stringify(raw));
}

function window180(refDate) {
  const end = toDay(refDate);
  return { start: addDays(end, -179), end };
}

function overlapDaysInclusive(aStart, aEnd, bStart, bEnd) {
  const start = aStart > bStart ? aStart : bStart;
  const end = aEnd < bEnd ? aEnd : bEnd;
  return start > end ? 0 : daysInclusive(start, end);
}

function daysUsedLast180(refDate, t = trips) {
  const w = window180(refDate);
  return normalizeTrips(t).reduce((sum, tr) => sum + overlapDaysInclusive(w.start, w.end, tr.entry, tr.exit), 0);
}

function remainingLast180(refDate, t = trips) {
  return Math.max(0, 90 - daysUsedLast180(refDate, t));
}

function getStatus(usedDays) {
  if (usedDays >= 90) return "overstay";
  if (usedDays >= 60) return "warning";
  return "safe";
}

function maxStayDays(entryDate, t = trips) {
  const entry = toDay(entryDate);
  let days = 0;
  for (; days < 366; days++) {
    const current = addDays(entry, days);
    const usedExisting = daysUsedLast180(current, t);
    const w = window180(current);
    const extra = overlapDaysInclusive(w.start, w.end, entry, current);
    if (usedExisting + extra > 90) break;
  }
  return Math.max(0, days - 1);
}

function latestExit(entryDate, t = trips) {
  const maxDays = maxStayDays(entryDate, t);
  return maxDays <= 0 ? null : addDays(entryDate, maxDays - 1);
}

function nextSafeEntryDate(startDate, t = trips) {
  let d = toDay(startDate);
  for (let i = 0; i < 730; i++) {
    if (remainingLast180(d, t) > 0) return d;
    d = addDays(d, 1);
  }
  return toDay(startDate);
}

function calculationDetails(refDate, t = trips) {
  const w = window180(refDate);
  const rows = normalizeTrips(t)
    .map(tr => ({ ...tr, daysInWindow: overlapDaysInclusive(w.start, w.end, tr.entry, tr.exit) }))
    .filter(row => row.daysInWindow > 0);
  const used = rows.reduce((acc, row) => acc + row.daysInWindow, 0);
  return { windowStart: w.start, windowEnd: w.end, rows, used, remaining: Math.max(0, 90 - used) };
}

function setStatusStyles(used) {
  const status = getStatus(used);

  const badge = el("statusBadge");
  badge.classList.remove("b-ok", "b-warn", "b-bad");
  if (status === "safe") { badge.classList.add("b-ok"); badge.textContent = "Safe"; }
  if (status === "warning") { badge.classList.add("b-warn"); badge.textContent = "Warning"; }
  if (status === "overstay") { badge.classList.add("b-bad"); badge.textContent = "Overstay"; }

  const hero = el("globeRing");
  hero.classList.remove("status-safe", "status-warning", "status-overstay");
  hero.classList.add(`status-${status}`);

  const bar = el("progressBar");
  bar.classList.remove("status-safe", "status-warning", "status-overstay");
  bar.classList.add(`status-${status}`);
}

function updateGlobeRing(used, remaining) {
  const progress = Math.max(0, Math.min(1, used / 90));
  const ring = el("globeRingProgress");
  ring.style.strokeDasharray = `${ringCircumference.toFixed(2)} ${ringCircumference.toFixed(2)}`;
  ring.style.strokeDashoffset = (ringCircumference * (1 - progress)).toFixed(2);
  el("globeRingUsed").textContent = `Used: ${used} / 90`;
  el("globeRingRemaining").textContent = `Remaining: ${remaining}`;
  el("globeRing").setAttribute("aria-label", `Schengen days used: ${used} out of 90, remaining ${remaining}`);
}

function showToast(text, showUndo = false) {
  el("toastText").textContent = text;
  el("toastUndoBtn").classList.toggle("hide", !showUndo);
  el("toast").classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el("toast").classList.remove("show");
    el("toastUndoBtn").classList.add("hide");
  }, showUndo ? 5200 : 1700);
}

function selectedTripDays() {
  const entry = el("entryDate").value;
  const exit = el("exitDate").value;
  if (!entry || !exit) return { ok: false, days: null, msg: "Select both dates.", invalidOrder: false };
  const a = toDay(entry), b = toDay(exit);
  if (b < a) return { ok: false, days: null, msg: "Exit date must be on or after entry date.", invalidOrder: true };
  return { ok: true, days: daysInclusive(a, b), msg: "", invalidOrder: false };
}

function syncSelectedUI() {
  const info = selectedTripDays();
  el("selectedDays").textContent = info.days === null ? "—" : String(info.days);
  el("addTripBtn").disabled = !info.ok;
  el("error").textContent = info.ok ? "" : info.msg;
  el("swapDatesBtn").classList.toggle("hide", !info.invalidOrder);
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
    if (Number.isFinite(extraDays) && extraDays > 0) exit = addDays(entry, extraDays - 1);
  }

  el("entryDate").value = toISO(entry);
  el("exitDate").value = toISO(exit);
  syncSelectedUI();
}

function swapDates() {
  const entry = el("entryDate").value;
  const exit = el("exitDate").value;
  if (!entry || !exit) return;
  el("entryDate").value = exit;
  el("exitDate").value = entry;
  syncSelectedUI();
}

function openModal() {
  const modal = el("detailsModal");
  lastFocusedEl = document.activeElement;
  modal.classList.add("open");
  document.body.classList.add("no-scroll");
  el("appWrap").setAttribute("inert", "");
  el("detailsCloseBtn").focus();
}

function closeModal() {
  const modal = el("detailsModal");
  modal.classList.remove("open");
  document.body.classList.remove("no-scroll");
  el("appWrap").removeAttribute("inert");
  (lastFocusedEl || el("detailsBtn")).focus?.();
}

function trapModalFocus(e) {
  if (e.key !== "Tab") return;
  const modal = el("detailsModal");
  if (!modal.classList.contains("open")) return;
  const focusable = [...modal.querySelectorAll('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')]
    .filter(node => !node.disabled && node.offsetParent !== null);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

function openDetails() {
  el("detailsDate").value = toISO(new Date());
  renderDetails();
  openModal();
}

function closeDetails() { closeModal(); }

function renderDetails() {
  const refDate = el("detailsDate").value ? toDay(el("detailsDate").value) : toDay(new Date());
  const details = calculationDetails(refDate);
  el("detailsWindow").textContent = `${fmt(details.windowStart)} → ${fmt(details.windowEnd)}`;
  el("detailsUsed").textContent = String(details.used);
  el("detailsRemaining").textContent = String(details.remaining);

  const tbody = el("detailsTbody");
  tbody.innerHTML = "";
  for (const row of details.rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${fmt(row.entry)} → ${fmt(row.exit)}</td><td class="right">${row.daysInWindow}</td>`;
    tbody.appendChild(tr);
  }
  el("detailsEmpty").classList.toggle("hide", details.rows.length > 0);
  el("detailsTableWrap").classList.toggle("hide", details.rows.length === 0);
}

function updateNextSafe(used, rem, now) {
  const msg = el("nextSafeMessage");
  const block = el("nextSafeBlock");
  const statusLine = el("nextSafeStatusLine");

  if (used > 90) {
    const overBy = used - 90;
    const date = nextSafeEntryDate(now, trips);
    msg.textContent = `Overstay by ${overBy} day(s).`;
    block.classList.remove("hide");
    statusLine.textContent = "Earliest compliant date:";
    statusLine.className = "nextSafeDanger";
    el("nextSafe").textContent = fmt(date);
    return;
  }

  if (rem > 0) {
    msg.textContent = "You can enter now.";
    block.classList.add("hide");
    return;
  }

  const nextDate = nextSafeEntryDate(now, trips);
  msg.textContent = "No days left right now.";
  block.classList.remove("hide");
  statusLine.textContent = "Next safe entry date:";
  statusLine.className = "nextSafeWarning";
  el("nextSafe").textContent = fmt(nextDate);
}

function render() {
  trips = normalizeTrips(trips);
  const now = new Date();
  const used = daysUsedLast180(now);
  const rem = remainingLast180(now);

  el("used").textContent = String(used);
  el("remaining").textContent = String(rem);
  el("asOf").textContent = fmt(now);
  el("usedOf90").textContent = String(Math.min(90, used));

  updateGlobeRing(used, rem);
  setStatusStyles(used);
  updateNextSafe(used, rem, now);

  const p = Math.max(0, Math.min(100, (used / 90) * 100));
  el("progressBar").style.width = p.toFixed(1) + "%";

  el("tripCount").textContent = String(trips.length);
  el("tripsEmpty").classList.toggle("hide", trips.length !== 0);
  el("tripsTableWrap").classList.toggle("hide", trips.length === 0);

  const tbody = el("tripsTbody");
  tbody.innerHTML = "";
  for (let idx = trips.length - 1; idx >= 0; idx--) {
    const t = trips[idx];
    const d = daysInclusive(t.entry, t.exit);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${fmt(t.entry)} → ${fmt(t.exit)}</td>
      <td class="right">${d}</td>
      <td class="right">
        <button class="secondary" data-edit="${idx}" aria-label="Edit trip ${fmt(t.entry)} to ${fmt(t.exit)}">Edit</button>
        <button class="danger" data-del="${idx}" aria-label="Delete trip ${fmt(t.entry)} to ${fmt(t.exit)}">Delete</button>
      </td>
    `;
    tbody.appendChild(tr);
  }

  const planEntry = el("planEntry").value;
  if (planEntry) {
    el("planMaxStay").textContent = String(maxStayDays(planEntry));
    el("planLatestExit").textContent = fmt(latestExit(planEntry));
    el("planNextSafe").textContent = fmt(nextSafeEntryDate(planEntry));
  } else {
    el("planMaxStay").textContent = "0";
    el("planLatestExit").textContent = "—";
    el("planNextSafe").textContent = "—";
  }
}

function upsertTripFromForm() {
  const info = selectedTripDays();
  if (!info.ok) return syncSelectedUI();
  const trip = clampTrip({ entry: el("entryDate").value, exit: el("exitDate").value });

  if (editingIndex === null) {
    trips.push(trip);
    showToast(`Trip added • ${info.days} day(s)`);
  } else {
    trips[editingIndex] = trip;
    showToast("Trip updated");
  }

  saveTrips(trips);
  render();
  clearEditMode();
}

function deleteTrip(index) {
  pendingDeletedTrip = { trip: trips[index], index };
  trips.splice(index, 1);
  saveTrips(trips);
  render();
  showToast("Trip deleted", true);

  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => {
    pendingDeletedTrip = null;
    el("toastUndoBtn").classList.add("hide");
  }, 5000);
}

function undoDelete() {
  if (!pendingDeletedTrip) return;
  trips.splice(Math.min(pendingDeletedTrip.index, trips.length), 0, pendingDeletedTrip.trip);
  pendingDeletedTrip = null;
  clearTimeout(undoTimer);
  saveTrips(trips);
  render();
  showToast("Trip restored");
}

function exportTrips() {
  const payload = normalizeTrips(trips).map(t => ({ entry: toISO(t.entry), exit: toISO(t.exit) }));
  const text = JSON.stringify(payload, null, 2);
  if (navigator.share) {
    navigator.share({ title: "Schengen trips", text }).catch(() => {});
    return;
  }
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "schengen-trips.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function importTripsFromFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(String(reader.result));
      if (!Array.isArray(parsed)) throw new Error("JSON must be an array.");
      parsed.forEach(item => {
        if (!item || typeof item.entry !== "string" || typeof item.exit !== "string") throw new Error("Invalid trip schema.");
      });
      if (trips.length && !confirm("Overwrite existing trips with imported JSON?")) return;
      trips = normalizeTrips(parsed);
      saveTrips(trips);
      render();
      clearEditMode();
      showToast("Trips imported");
    } catch (err) {
      alert(`Import failed: ${err.message}`);
    }
  };
  reader.readAsText(file);
}

function runSelfChecks() {
  const mergedOverlap = normalizeTrips([{ entry: "2026-01-01", exit: "2026-01-05" }, { entry: "2026-01-04", exit: "2026-01-10" }]);
  console.assert(mergedOverlap.length === 1 && toISO(mergedOverlap[0].exit) === "2026-01-10", "overlap merge failed");
  const mergedAdjacent = normalizeTrips([{ entry: "2026-02-01", exit: "2026-02-05" }, { entry: "2026-02-06", exit: "2026-02-10" }]);
  console.assert(mergedAdjacent.length === 1 && toISO(mergedAdjacent[0].exit) === "2026-02-10", "adjacent merge failed");
  const futureTrip = [{ entry: addDays(new Date(), 20), exit: addDays(new Date(), 30) }];
  console.assert(daysUsedLast180(new Date(), futureTrip) === 0, "future-only trip should not affect today");
  console.assert(daysInclusive("2026-03-01", "2026-03-01") === 1, "inclusive counting failed");
}

document.addEventListener("DOMContentLoaded", () => {
  trips = loadTrips();

  document.querySelectorAll(".tabBtn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tabBtn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const tab = btn.dataset.tab;
      ["overview", "trips", "planner"].forEach(t => el("tab-" + t).classList.toggle("hide", t !== tab));
    });
  });

  document.querySelectorAll(".quickBtn").forEach(btn => btn.addEventListener("click", () => applyQuickPreset(btn.dataset.preset)));

  el("addTripBtn").addEventListener("click", upsertTripFromForm);
  el("cancelEditBtn").addEventListener("click", clearEditMode);
  el("swapDatesBtn").addEventListener("click", swapDates);
  el("planEntry").addEventListener("change", render);

  el("detailsBtn").addEventListener("click", openDetails);
  el("detailsCloseBtn").addEventListener("click", closeDetails);
  el("detailsDate").addEventListener("change", renderDetails);
  el("detailsModal").addEventListener("click", (e) => { if (e.target.id === "detailsModal") closeDetails(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDetails();
    trapModalFocus(e);
  });

  el("tripsTbody").addEventListener("click", (e) => {
    const editIndex = e.target?.dataset?.edit;
    const delIndex = e.target?.dataset?.del;
    if (typeof editIndex !== "undefined") return setEditMode(Number(editIndex));
    if (typeof delIndex !== "undefined") deleteTrip(Number(delIndex));
  });

  el("resetBtn").addEventListener("click", () => {
    if (!confirm("Reset all trips on this device?")) return;
    trips = [];
    saveTrips(trips);
    clearEditMode();
    render();
    showToast("All trips reset");
  });

  el("entryDate").addEventListener("change", syncSelectedUI);
  el("exitDate").addEventListener("change", syncSelectedUI);

  el("toastUndoBtn").addEventListener("click", undoDelete);

  el("exportTripsBtn").addEventListener("click", exportTrips);
  el("importTripsBtn").addEventListener("click", () => el("importTripsInput").click());
  el("importTripsInput").addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (file) importTripsFromFile(file);
    e.target.value = "";
  });

  const iso = toISO(new Date());
  el("entryDate").value = iso;
  el("exitDate").value = iso;
  el("planEntry").value = iso;
  el("detailsDate").value = iso;

  closeModal();
  runSelfChecks();
  syncSelectedUI();
  render();
});

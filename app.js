/*
Manual test checklist:
1) Add trip with valid dates -> saved, hero updates remaining days.
2) Invalid range (exit < entry) -> error appears, Save disabled, Swap dates shown.
3) Edit/Delete actions work on trip cards.
4) Delete shows "Trip deleted — Undo" and undo restores within 5 seconds.
5) Reload page keeps trips via localStorage key schengen_days_trips_v3.
*/

const dayMs = 24 * 60 * 60 * 1000;
const KEY = "schengen_days_trips_v3";

let trips = [];
let editingIndex = null;
let toastTimer;
let undoTimer;
let pendingDeleted = null;

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
  if (prepared.length === 0) return [];
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
  const start = addDays(end, -179);
  return { start, end };
}

function overlapDaysInclusive(aStart, aEnd, bStart, bEnd) {
  const start = aStart > bStart ? aStart : bStart;
  const end = aEnd < bEnd ? aEnd : bEnd;
  return start > end ? 0 : daysInclusive(start, end);
}

function daysUsedLast180(refDate, t = trips) {
  const w = window180(refDate);
  return normalizeTrips(t).reduce((sum, trip) => sum + overlapDaysInclusive(w.start, w.end, trip.entry, trip.exit), 0);
}

function remainingLast180(refDate, t = trips) {
  return Math.max(0, 90 - daysUsedLast180(refDate, t));
}

function nextSafeEntryDate(startDate, t = trips) {
  let d = toDay(startDate);
  for (let i = 0; i < 730; i++) {
    if (remainingLast180(d, t) > 0) return d;
    d = addDays(d, 1);
  }
  return toDay(startDate);
}

function getHeroStatus(remaining, used) {
  if (used > 90 || remaining === 0) return "critical";
  if (remaining <= 29) return "danger";
  if (remaining <= 59) return "warning";
  return "safe";
}

function selectedTripInfo() {
  const entry = el("entryDate").value;
  const exit = el("exitDate").value;
  if (!entry || !exit) return { ok: false, days: null, msg: "", invalidOrder: false };
  const a = toDay(entry);
  const b = toDay(exit);
  if (b < a) return { ok: false, days: null, msg: "Exit date must be on or after entry date.", invalidOrder: true };
  return { ok: true, days: daysInclusive(a, b), msg: "", invalidOrder: false };
}

function syncTripForm() {
  const info = selectedTripInfo();
  el("tripLength").textContent = info.days === null ? "—" : `${info.days} days`;
  el("tripError").textContent = info.msg;
  el("saveTripBtn").disabled = !info.ok;
  el("swapDatesBtn").classList.toggle("hide", !info.invalidOrder);
}

function setHero() {
  const now = new Date();
  const used = daysUsedLast180(now);
  const remaining = remainingLast180(now);
  const status = getHeroStatus(remaining, used);
  const hero = el("hero");
  hero.classList.remove("safe", "warning", "danger", "critical");
  hero.classList.add(status);

  if (used > 90) {
    const overstayDays = used - 90;
    el("heroPrimary").textContent = `Overstay: ${overstayDays} day(s)`;
    el("heroSecondary").textContent = `Next possible entry: ${fmt(nextSafeEntryDate(now))}`;
    return;
  }

  if (remaining === 0) {
    el("heroPrimary").textContent = "You have 0 days left";
    el("heroSecondary").textContent = `Next possible entry: ${fmt(nextSafeEntryDate(now))}`;
    return;
  }

  el("heroPrimary").textContent = `You can stay: ${remaining} days`;
  el("heroSecondary").textContent = "in the next 180 days";
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

function quickSet(days) {
  let entry = el("entryDate").value;
  if (!entry) {
    entry = toISO(new Date());
    el("entryDate").value = entry;
  }
  el("exitDate").value = toISO(addDays(entry, Number(days) - 1));
  syncTripForm();
}

function swapDates() {
  const entry = el("entryDate").value;
  const exit = el("exitDate").value;
  if (!entry || !exit) return;
  el("entryDate").value = exit;
  el("exitDate").value = entry;
  syncTripForm();
}

function saveTripFromForm() {
  const info = selectedTripInfo();
  if (!info.ok) return;

  const trip = clampTrip({ entry: el("entryDate").value, exit: el("exitDate").value });
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
  render();
}

function setEditMode(index) {
  editingIndex = index;
  const trip = trips[index];
  el("entryDate").value = toISO(trip.entry);
  el("exitDate").value = toISO(trip.exit);
  el("saveTripBtn").textContent = "Save trip";
  el("cancelEditBtn").classList.remove("hide");
  syncTripForm();
}

function clearEditMode() {
  editingIndex = null;
  el("cancelEditBtn").classList.add("hide");
  syncTripForm();
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

  for (let idx = trips.length - 1; idx >= 0; idx--) {
    const t = trips[idx];
    const days = daysInclusive(t.entry, t.exit);
    const row = document.createElement("div");
    row.className = "tripRow";
    row.innerHTML = `
      <div>
        <div class="tripMain">${fmt(t.entry)} → ${fmt(t.exit)}</div>
        <div class="tripSub">${days} days</div>
      </div>
      <div class="row">
        <button class="secondary iconBtn" data-edit="${idx}" aria-label="Edit trip">
          <svg class="icon" viewBox="0 0 24 24" fill="none"><path d="M4 20h4l10-10-4-4L4 16v4Z" stroke="currentColor" stroke-width="2"/><path d="m12 6 4 4" stroke="currentColor" stroke-width="2"/></svg>
          Edit
        </button>
        <button class="danger iconBtn" data-del="${idx}" aria-label="Delete trip">
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
  renderTrips();
  syncTripForm();
}

document.addEventListener("DOMContentLoaded", () => {
  trips = loadTrips();

  const today = toISO(new Date());
  el("entryDate").value = today;
  el("exitDate").value = today;

  el("entryDate").addEventListener("change", syncTripForm);
  el("exitDate").addEventListener("change", syncTripForm);

  el("saveTripBtn").addEventListener("click", saveTripFromForm);
  el("cancelEditBtn").addEventListener("click", clearEditMode);
  el("swapDatesBtn").addEventListener("click", swapDates);

  document.querySelectorAll("[data-quick]").forEach(btn => {
    btn.addEventListener("click", () => quickSet(btn.dataset.quick));
  });

  el("tripsList").addEventListener("click", (e) => {
    const edit = e.target.closest("[data-edit]")?.dataset.edit;
    const del = e.target.closest("[data-del]")?.dataset.del;
    if (typeof edit !== "undefined") return setEditMode(Number(edit));
    if (typeof del !== "undefined") deleteTrip(Number(del));
  });

  el("undoBtn").addEventListener("click", undoDelete);

  render();
});

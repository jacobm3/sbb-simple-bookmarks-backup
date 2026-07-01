// scheduler.js
// Arms a single chrome.alarms alarm from the current settings. Called on install,
// on startup, and whenever settings change. Alarms don't survive extension updates,
// so re-arming on those events is essential.

import { getSettings } from "./settings.js";

export const ALARM_NAME = "bookmark-backup";

// Compute the epoch-ms timestamp of the next occurrence of "HH:MM" local time,
// strictly in the future relative to `from` (default now).
export function nextDailyTime(hhmm, from = new Date()) {
  const [h, m] = hhmm.split(":").map((x) => parseInt(x, 10));
  const next = new Date(from);
  next.setHours(h, m, 0, 0);
  // If that time already passed (or is exactly now) today, use tomorrow.
  if (next.getTime() <= from.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime();
}

// (Re)arm the alarm to match settings. Clears any existing alarm first.
export async function rearmAlarm() {
  const settings = await getSettings();
  await chrome.alarms.clear(ALARM_NAME);

  // Master toggle off -> leave it cleared (no scheduled backups).
  if (!settings.enabled) return;

  if (settings.scheduleMode === "interval") {
    // Every N hours. Guard against a bad value.
    const hours =
      Number.isInteger(settings.intervalHours) && settings.intervalHours >= 1
        ? settings.intervalHours
        : 24;
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: hours * 60 });
  } else {
    // Daily at a fixed time. Fire at the next occurrence, then every 1440 min.
    const when = nextDailyTime(settings.dailyTime);
    chrome.alarms.create(ALARM_NAME, { when, periodInMinutes: 1440 });
  }
}

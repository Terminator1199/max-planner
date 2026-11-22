import assert from "node:assert/strict";
import { test } from "node:test";
import { OnlineCalendar } from "./online.ts";

const at = (iso: string) => Date.parse(iso) / 1000;
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

test("a nightly window in India: 22:00 to 06:00 IST", () => {
  const from = at("2026-11-20T14:30:00Z"); // 20:00 IST, a Friday
  const cal = new OnlineCalendar(
    { timeZone: "Asia/Kolkata", offline: [{ days: EVERY_DAY, from: "22:00", to: "06:00" }] },
    from,
  );
  assert.equal(cal.isOnline(from), true);
  assert.equal(cal.isOnline(at("2026-11-20T16:29:59Z")), true); // 21:59:59
  assert.equal(cal.isOnline(at("2026-11-20T16:30:00Z")), false); // 22:00
  assert.equal(cal.nextOnline(at("2026-11-20T16:30:00Z")), at("2026-11-21T00:30:00Z")); // 06:00
  assert.equal(cal.nextOnline(at("2026-11-20T12:00:00Z")), at("2026-11-20T12:00:00Z"));
  // Many days on, the windows are still generated.
  assert.equal(cal.isOnline(at("2027-03-01T18:00:00Z")), false); // 23:30 IST
  assert.deepEqual(cal.windows(from, at("2026-11-21T14:30:00Z")), [
    [at("2026-11-20T16:30:00Z"), at("2026-11-21T00:30:00Z")],
  ]);
});

test("a window on one weekday only", () => {
  const from = at("2026-11-20T00:00:00Z");
  const cal = new OnlineCalendar(
    { timeZone: "UTC", offline: [{ days: [6], from: "13:00", to: "18:00" }] }, // Saturday
    from,
  );
  assert.equal(cal.isOnline(at("2026-11-20T14:00:00Z")), true); // Friday
  assert.equal(cal.isOnline(at("2026-11-21T14:00:00Z")), false); // Saturday
  assert.equal(cal.nextOnline(at("2026-11-21T14:00:00Z")), at("2026-11-21T18:00:00Z"));
});

test("back-to-back windows merge, so the next online time skips both", () => {
  const cal = new OnlineCalendar(
    {
      timeZone: "UTC",
      offline: [
        { days: EVERY_DAY, from: "09:00", to: "12:00" },
        { days: EVERY_DAY, from: "12:00", to: "17:00" },
      ],
    },
    at("2026-11-20T00:00:00Z"),
  );
  assert.equal(cal.nextOnline(at("2026-11-20T10:00:00Z")), at("2026-11-20T17:00:00Z"));
});

test("daylight saving: the spring-forward night is an hour shorter in New York", () => {
  const cal = new OnlineCalendar(
    { timeZone: "America/New_York", offline: [{ days: EVERY_DAY, from: "01:00", to: "03:00" }] },
    at("2026-03-06T00:00:00Z"),
  );
  // 7 March, EST: 01:00 to 03:00 local is 06:00 to 08:00 UTC.
  assert.equal(cal.nextOnline(at("2026-03-07T06:30:00Z")), at("2026-03-07T08:00:00Z"));
  // 8 March: clocks jump from 02:00 EST to 03:00 EDT, so 03:00 local is 07:00 UTC.
  assert.equal(cal.isOnline(at("2026-03-08T06:30:00Z")), false);
  assert.equal(cal.nextOnline(at("2026-03-08T06:30:00Z")), at("2026-03-08T07:00:00Z"));
});

test("bad settings are refused with a clear error", () => {
  const from = 0;
  const bad =
    (offline: { days: number[]; from: string; to: string }[], timeZone = "UTC") =>
    () =>
      new OnlineCalendar({ timeZone, offline }, from);
  assert.throws(bad([{ days: [1], from: "25:00", to: "06:00" }]), /HH:MM/);
  assert.throws(bad([{ days: [7], from: "22:00", to: "06:00" }]), /days run from 0/);
  assert.throws(bad([{ days: [1], from: "06:00", to: "06:00" }]), /same time/);
  assert.throws(
    bad([
      { days: EVERY_DAY, from: "00:00", to: "23:59" },
      { days: EVERY_DAY, from: "23:59", to: "00:00" },
    ]),
    /whole week/,
  );
  assert.throws(bad([], "Mars/Olympus_Mons"), RangeError);
});

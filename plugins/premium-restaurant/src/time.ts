/** Time-zone helpers without libraries (the sandbox has Intl only). */

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function dtf(tz: string): Intl.DateTimeFormat {
	let f = dtfCache.get(tz);
	if (!f) {
		f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short" });
		dtfCache.set(tz, f);
	}
	return f;
}
const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Wall-clock parts of an instant in a zone. */
export function zoned(date: Date, tz: string): { y: number; m: number; d: number; hh: number; mm: number; dow: number; ymd: string } {
	const parts = Object.fromEntries(dtf(tz).formatToParts(date).map((p) => [p.type, p.value]));
	const y = Number(parts.year);
	const m = Number(parts.month);
	const d = Number(parts.day);
	return { y, m, d, hh: Number(parts.hour), mm: Number(parts.minute), dow: DOW[parts.weekday!] ?? 0, ymd: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` };
}

/** The instant for a wall-clock time ("2026-09-01", "09:30") in a zone. */
export function zonedToUtc(ymd: string, hhmm: string, tz: string): Date {
	const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
	const [hh, mm] = hhmm.split(":").map(Number) as [number, number];
	// Start from the UTC guess, then correct by the zone offset at that instant (twice for DST edges).
	let guess = Date.UTC(y, m - 1, d, hh, mm);
	for (let i = 0; i < 2; i++) {
		const z = zoned(new Date(guess), tz);
		const asUtc = Date.UTC(z.y, z.m - 1, z.d, z.hh, z.mm);
		guess += Date.UTC(y, m - 1, d, hh, mm) - asUtc;
	}
	return new Date(guess);
}

export function isValidTimeZone(tz: string): boolean {
	try {
		dtf(tz);
		return true;
	} catch {
		return false;
	}
}

export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

export function formatWhen(iso: string, tz: string): string {
	try {
		return new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
	} catch {
		return iso;
	}
}

export const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number) => aStart < bEnd && bStart < aEnd;

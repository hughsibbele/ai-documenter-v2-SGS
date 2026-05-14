// Active-term filter for Canvas sync + dashboard rendering.
//
// EHS term names follow patterns like:
//   "2025/2026 - High School - Full Yr/1st Sem"
//   "2025/2026 - High School - 2nd Semester"
//   "2025/2026a - High School - 1st Semester"
//
// We define "active" as: term_name starts with the current academic year's
// "YYYY/YYYY" prefix. The cutover is August: before August, we're still in
// the previous academic year; August onward, we've crossed into the new one.
//
// This means today (May 2026) the active prefix is "2025/2026". On
// 2026-08-01, it flips to "2026/2027".

export function activeAcademicYearPrefix(now: Date = new Date()): string {
  const month = now.getMonth(); // 0-indexed
  const year = now.getFullYear();
  if (month >= 7) {
    // August or later → start of the next academic year
    return `${year}/${year + 1}`;
  }
  return `${year - 1}/${year}`;
}

export function isActiveTerm(
  termName: string | null,
  now: Date = new Date(),
): boolean {
  if (!termName) return false;
  return termName.startsWith(activeAcademicYearPrefix(now));
}

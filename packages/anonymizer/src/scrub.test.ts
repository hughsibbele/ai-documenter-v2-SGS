import { describe, it, expect } from "vitest";
import { compileRoster, scrubFreeText, scrubPayload, scrubStructured } from "./scrub";
import { deAnonymize } from "./deanonymize";
import type { Roster, RosterEntry } from "./types";

const ROSTER: Roster = [
  {
    canvas_user_id: "1",
    email: "mary.smith@episcopalhighschool.org",
    display_name: "Mary Smith",
    anon_token: "Student_aaaaaa",
  },
  {
    canvas_user_id: "2",
    email: "tomas.obrien@episcopalhighschool.org",
    display_name: "Tomás O'Brien",
    anon_token: "Student_bbbbbb",
  },
  {
    canvas_user_id: "3",
    email: "anya.smith-jones@episcopalhighschool.org",
    display_name: "Anya Smith-Jones",
    anon_token: "Student_cccccc",
  },
  {
    canvas_user_id: "4",
    email: "j.dangelo@episcopalhighschool.org",
    display_name: "Jules D'Angelo",
    anon_token: "Student_dddddd",
  },
  {
    canvas_user_id: "5",
    email: "rumi@episcopalhighschool.org",
    display_name: "Rumi",
    anon_token: "Student_eeeeee",
  },
  {
    canvas_user_id: "6",
    email: "mary.j.s@episcopalhighschool.org",
    display_name: "Mary Jane Smith",
    anon_token: "Student_ffffff",
  },
];

describe("scrubFreeText", () => {
  const compiled = compileRoster(ROSTER);

  it("redacts a full name", () => {
    const out = scrubFreeText("Mary Smith wrote a thoughtful essay.", compiled);
    expect(out).toBe("Student_aaaaaa wrote a thoughtful essay.");
  });

  it("prefers the longer match — Mary Jane Smith wins over Mary", () => {
    const out = scrubFreeText("Mary Jane Smith presented her work.", compiled);
    expect(out).toBe("Student_ffffff presented her work.");
    expect(out).not.toContain("Student_aaaaaa");
  });

  it("redacts first name on its own", () => {
    const out = scrubFreeText("I think Mary did great.", compiled);
    expect(out).toContain("Student_");
    expect(out).not.toContain("Mary did");
  });

  it("redacts last name on its own", () => {
    const out = scrubFreeText("Smith argued the opposite.", compiled);
    expect(out).toContain("Student_");
    expect(out).not.toContain("Smith argued");
  });

  it("handles possessives with straight apostrophe", () => {
    const out = scrubFreeText("Mary's argument was sharp.", compiled);
    expect(out).toContain("Student_aaaaaa");
    expect(out).not.toContain("Mary's");
  });

  it("handles possessives with curly apostrophe", () => {
    const out = scrubFreeText("Mary’s argument was sharp.", compiled);
    expect(out).toContain("Student_aaaaaa");
    expect(out).not.toContain("Mary’s");
  });

  it("handles names with apostrophes (O'Brien)", () => {
    const out = scrubFreeText("Tomás O'Brien made a point.", compiled);
    expect(out).toContain("Student_bbbbbb");
    expect(out).not.toContain("O'Brien");
  });

  it("handles hyphenated last names (Smith-Jones)", () => {
    const out = scrubFreeText("Anya Smith-Jones disagreed.", compiled);
    expect(out).toContain("Student_cccccc");
    expect(out).not.toContain("Smith-Jones");
  });

  it("handles single-name students", () => {
    const out = scrubFreeText("Rumi spoke last.", compiled);
    expect(out).toContain("Student_eeeeee");
    expect(out).not.toContain("Rumi spoke");
  });

  it("does not redact partial-word matches", () => {
    const out = scrubFreeText("Markdown is a format Marky uses.", compiled);
    // "Mary" doesn't appear; "Marky" should not be replaced.
    expect(out).toBe("Markdown is a format Marky uses.");
  });

  it("does not redact substrings inside other words", () => {
    const out = scrubFreeText("The blacksmith's tools.", compiled);
    expect(out).toBe("The blacksmith's tools.");
  });

  it("is case-insensitive", () => {
    const out = scrubFreeText("MARY presented; mary debated.", compiled);
    expect(out).toContain("Student_aaaaaa");
    expect(out.toLowerCase()).not.toContain("mary");
  });

  it("redacts multiple students in one paragraph", () => {
    const text = "Mary Smith and Anya Smith-Jones both wrote about Rumi.";
    const out = scrubFreeText(text, compiled);
    expect(out).toContain("Student_aaaaaa");
    expect(out).toContain("Student_cccccc");
    expect(out).toContain("Student_eeeeee");
  });

  it("handles names with hyphens — pieces individually too", () => {
    // "Smith-Jones" split: standalone "Jones" should be redacted as Anya
    // (since "Smith" alone collides with Mary Smith — last-name-only).
    const out = scrubFreeText("Jones interrupted the discussion.", compiled);
    expect(out).toContain("Student_cccccc");
  });
});

describe("scrubPayload (recursive)", () => {
  const compiled = compileRoster(ROSTER);

  it("scrubs nested object string values", () => {
    const payload = {
      title: "Essay by Mary Smith",
      meta: { reviewer: "Tomás O'Brien", count: 3 },
      tags: ["First draft", "Reviewed by Anya Smith-Jones"],
    };
    const out = scrubPayload(payload, compiled);
    expect(JSON.stringify(out)).toContain("Student_aaaaaa");
    expect(JSON.stringify(out)).toContain("Student_bbbbbb");
    expect(JSON.stringify(out)).toContain("Student_cccccc");
    expect(JSON.stringify(out)).not.toMatch(/Mary Smith|O'Brien|Smith-Jones/);
    expect(out.meta.count).toBe(3);
  });
});

describe("scrubStructured", () => {
  const byCanvasId = new Map<string, RosterEntry>();
  const byEmail = new Map<string, RosterEntry>();
  for (const e of ROSTER) {
    byCanvasId.set(e.canvas_user_id, e);
    byEmail.set(e.email.toLowerCase(), e);
  }

  it("replaces PII keys when canvas_user_id resolves", () => {
    const submission = {
      canvas_user_id: "1",
      display_name: "Mary Smith",
      email: "mary.smith@episcopalhighschool.org",
      body: "ignored here",
    };
    const out = scrubStructured(submission, byEmail, byCanvasId);
    expect(out.display_name).toBe("Student_aaaaaa");
    expect(out.email).toBe("Student_aaaaaa");
    expect(out.canvas_user_id).toBe("Student_aaaaaa");
    expect(out.body).toBe("ignored here");
  });

  it("falls back to email lookup when canvas_user_id is absent", () => {
    const submission = {
      email: "Tomas.OBrien@EpiscopalHighSchool.org".toLowerCase(),
      display_name: "Tomás O'Brien",
    };
    const out = scrubStructured(submission, byEmail, byCanvasId);
    expect(out.display_name).toBe("Student_bbbbbb");
    expect(out.email).toBe("Student_bbbbbb");
  });

  it("recurses into nested arrays and objects", () => {
    const payload = {
      submissions: [
        { canvas_user_id: "1", display_name: "Mary Smith" },
        { canvas_user_id: "2", display_name: "Tomás O'Brien" },
      ],
    };
    const out = scrubStructured(payload, byEmail, byCanvasId);
    expect(out.submissions[0]!.display_name).toBe("Student_aaaaaa");
    expect(out.submissions[1]!.display_name).toBe("Student_bbbbbb");
  });
});

describe("deAnonymize (render-time)", () => {
  it("replaces tokens with display_names", () => {
    const text = "Student_aaaaaa wrote about Student_eeeeee.";
    const out = deAnonymize(text, ROSTER);
    expect(out).toBe("Mary Smith wrote about Rumi.");
  });

  it("leaves unknown tokens unchanged", () => {
    const text = "Student_zzzzzz is not in the roster.";
    expect(deAnonymize(text, ROSTER)).toBe(text);
  });
});

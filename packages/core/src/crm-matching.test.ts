import { describe, expect, it } from "vitest";
import type { Participant } from "./schemas.js";
import { InMemoryCrmLookup, matchParticipants } from "./crm-matching.js";

const person = (name: string, email: string | null): Participant => ({ name, email, external: true });
const lookup = new InMemoryCrmLookup(
  [
    { id: "person-1", name: "Avery Reed", email: "avery@acme.example", companyId: "company-1" },
    { id: "person-2", name: "Morgan Lee", email: "morgan@other.example" },
    { id: "person-3", name: "Morgan Lee", email: "morgan@third.example" },
  ],
  [{ id: "company-1", name: "Acme", domain: "acme.example" }],
);

describe("preview-only CRM participant matching", () => {
  it("does not override a contradictory email with a matching name", async () => {
    const unique = new InMemoryCrmLookup([{ id: "morgan", name: "Morgan Lee", email: "morgan@old.example" }]);
    expect((await matchParticipants([person("Morgan Lee", "morgan@new.example")], unique))[0]).toMatchObject({
      status: "unmatched", reason: "no-match", personId: null, companyId: null,
    });
    expect((await matchParticipants([person("Morgan Lee", null)], unique))[0]).toMatchObject({
      status: "matched", reason: "person-name", confidence: "low", personId: "morgan",
    });
  });
  it("prefers exact email over domain and name", async () => {
    expect((await matchParticipants([person("Avery Reed", "AVERY@ACME.EXAMPLE")], lookup))[0]).toMatchObject({
      status: "matched", confidence: "high", reason: "exact-email", personId: "person-1", companyId: "company-1",
    });
  });
  it("matches a non-personal email domain to a company", async () => {
    expect((await matchParticipants([person("Unknown", "someone@acme.example")], lookup))[0]).toMatchObject({
      status: "matched", confidence: "medium", reason: "company-domain", personId: null, companyId: "company-1",
    });
  });
  it("marks ambiguous names without choosing a record", async () => {
    expect((await matchParticipants([person("Morgan Lee", null)], lookup))[0]).toMatchObject({
      status: "ambiguous", confidence: "none", reason: "ambiguous-name", personId: null, companyId: null,
    });
  });
  it("never infers a company from a personal email domain", async () => {
    const personal = new InMemoryCrmLookup([], [{ id: "company-gmail", name: "Example", domain: "gmail.com" }]);
    expect((await matchParticipants([person("Unknown", "unknown@gmail.com")], personal))[0]).toMatchObject({
      status: "unmatched", reason: "no-match", companyId: null,
    });
  });
  it("shows unmatched participants clearly", async () => {
    expect((await matchParticipants([person("No Match", null)], lookup))[0]).toMatchObject({
      status: "unmatched", confidence: "none", reason: "no-match",
    });
  });
});

import type { Participant, ParticipantMatch } from "./schemas.js";

export interface CrmPerson { id: string; name: string; email: string | null; companyId?: string | null }
export interface CrmCompany { id: string; name: string; domain: string | null }
export interface CrmLookup {
  people(): readonly CrmPerson[];
  companies(): readonly CrmCompany[];
}

/** Fixture-only lookup. No network or CRM writes are possible through this implementation. */
export class InMemoryCrmLookup implements CrmLookup {
  constructor(
    private readonly peopleFixture: readonly CrmPerson[] = [],
    private readonly companiesFixture: readonly CrmCompany[] = [],
  ) {}
  people(): readonly CrmPerson[] { return this.peopleFixture; }
  companies(): readonly CrmCompany[] { return this.companiesFixture; }
}

const personalDomains = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com",
  "yahoo.com", "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com",
]);
const normal = (value: string) => value.trim().toLocaleLowerCase("en");
const emailDomain = (email: string) => normal(email).split("@")[1] ?? null;

export function matchParticipants(participants: readonly Participant[], lookup: CrmLookup): ParticipantMatch[] {
  const people = lookup.people();
  const companies = lookup.companies();
  return participants.map((participant, participantIndex) => {
    const base = { participantIndex, participantName: participant.name, participantEmail: participant.email };
    const matched = (reason: ParticipantMatch["reason"], confidence: ParticipantMatch["confidence"],
      personId: string | null, companyId: string | null): ParticipantMatch =>
      ({ ...base, status: "matched", confidence, reason, personId, companyId });
    const ambiguous = (reason: ParticipantMatch["reason"]): ParticipantMatch =>
      ({ ...base, status: "ambiguous", confidence: "none", reason, personId: null, companyId: null });
    const email = participant.email ? normal(participant.email) : null;
    if (email) {
      const exact = people.filter((person) => person.email && normal(person.email) === email);
      if (exact.length > 1) return ambiguous("ambiguous-email");
      if (exact.length === 1) return matched("exact-email", "high", exact[0]!.id, exact[0]!.companyId ?? null);
      const domain = emailDomain(email);
      if (domain && !personalDomains.has(domain)) {
        const sameDomain = companies.filter((company) => company.domain && normal(company.domain) === domain);
        if (sameDomain.length > 1) return ambiguous("ambiguous-domain");
        if (sameDomain.length === 1) return matched("company-domain", "medium", null, sameDomain[0]!.id);
      }
    }
    const name = normal(participant.name);
    const namedPeople = people.filter((person) => normal(person.name) === name);
    if (namedPeople.length > 1) return ambiguous("ambiguous-name");
    if (namedPeople.length === 1) return matched("person-name", "low", namedPeople[0]!.id, namedPeople[0]!.companyId ?? null);
    const namedCompanies = companies.filter((company) => normal(company.name) === name);
    if (namedCompanies.length > 1) return ambiguous("ambiguous-name");
    if (namedCompanies.length === 1) return matched("company-name", "low", null, namedCompanies[0]!.id);
    return { ...base, status: "unmatched", confidence: "none", reason: "no-match", personId: null, companyId: null };
  });
}

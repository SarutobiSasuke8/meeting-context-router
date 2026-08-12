import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  createRoutingProposals,
  emptyRouterState,
  routerStateSchema,
  type CanonicalMeeting,
  type ProposalStatus,
  type RouterState,
  type RoutingProposal,
} from "@meeting-context-router/core";

export class StoreConflictError extends Error {}
export class StoreNotFoundError extends Error {}

export class JsonRouterStore {
  private state: RouterState = emptyRouterState();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async init(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    try {
      this.state = routerStateSchema.parse(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.persist(this.state);
    }
  }

  listMeetings(): CanonicalMeeting[] {
    return structuredClone(this.state.meetings);
  }

  listProposals(status?: ProposalStatus): RoutingProposal[] {
    return structuredClone(status ? this.state.proposals.filter((proposal) => proposal.status === status) : this.state.proposals);
  }

  getProposal(id: string): RoutingProposal {
    const proposal = this.state.proposals.find((candidate) => candidate.id === id);
    if (!proposal) throw new StoreNotFoundError("Proposal not found");
    return structuredClone(proposal);
  }

  async ingest(meeting: CanonicalMeeting): Promise<{ meeting: CanonicalMeeting; proposals: RoutingProposal[]; duplicate: boolean }> {
    return this.mutate((state) => {
      const existing = state.meetings.find((candidate) =>
        candidate.provenance.source === meeting.provenance.source && candidate.provenance.sourceMeetingId === meeting.provenance.sourceMeetingId,
      );
      if (existing) {
        if (existing.provenance.sourceHash !== meeting.provenance.sourceHash) {
          throw new StoreConflictError("Source meeting ID already exists with different content");
        }
        return { meeting: existing, proposals: state.proposals.filter((proposal) => proposal.meetingId === existing.id), duplicate: true };
      }
      const proposals = createRoutingProposals(meeting);
      state.meetings.push(meeting);
      state.proposals.push(...proposals);
      return { meeting, proposals, duplicate: false };
    });
  }

  async reviewProposal(id: string, decision: "approved" | "rejected"): Promise<RoutingProposal> {
    return this.mutate((state) => {
      const proposal = state.proposals.find((candidate) => candidate.id === id);
      if (!proposal) throw new StoreNotFoundError("Proposal not found");
      if (proposal.status !== "pending") throw new StoreConflictError(`Proposal cannot be reviewed from ${proposal.status}`);
      proposal.status = decision;
      proposal.reviewedAt = new Date().toISOString();
      proposal.lastError = null;
      return proposal;
    });
  }

  async recordDelivery(id: string, status: "delivered" | "blocked" | "failed", error: string | null): Promise<RoutingProposal> {
    return this.mutate((state) => {
      const proposal = state.proposals.find((candidate) => candidate.id === id);
      if (!proposal) throw new StoreNotFoundError("Proposal not found");
      if (!["approved", "blocked", "failed"].includes(proposal.status)) throw new StoreConflictError(`Proposal cannot be delivered from ${proposal.status}`);
      proposal.status = status;
      proposal.lastError = error;
      proposal.deliveredAt = status === "delivered" ? new Date().toISOString() : null;
      return proposal;
    });
  }

  private async mutate<T>(operation: (state: RouterState) => T): Promise<T> {
    let resolveResult!: (value: T) => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<T>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    this.writeChain = this.writeChain.then(async () => {
      const candidate = structuredClone(this.state);
      try {
        const value = operation(candidate);
        routerStateSchema.parse(candidate);
        await this.persist(candidate);
        this.state = candidate;
        resolveResult(structuredClone(value));
      } catch (error) {
        rejectResult(error);
      }
    });
    return result;
  }

  private async persist(state: RouterState): Promise<void> {
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.path);
  }
}

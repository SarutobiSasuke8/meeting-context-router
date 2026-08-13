import { randomUUID } from "node:crypto";
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

// A lease this old could only belong to a request that is no longer running: the CRM
// adapter bounds its own fetch well inside this window, so a stuck lease past it is either
// a crashed process (see the startup reconciliation in init()) or a genuinely hung call.
const DELIVERY_LEASE_TTL_MS = 2 * 60 * 1_000;
const DELIVERABLE_STATUSES: ProposalStatus[] = ["approved", "blocked", "failed"];

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
    // Any proposal still "delivering" survived from a process that died mid-attempt: the
    // in-flight adapter call's outcome (did the CRM POST land? did the file get written?) is
    // unknown and must never be silently retried. Recovering it here, unconditionally, on
    // every startup keeps that recovery deterministic instead of relying on lease-expiry timing.
    const stuck = this.state.proposals.filter((proposal) => proposal.status === "delivering");
    if (stuck.length) {
      await this.mutate((state) => {
        for (const proposal of state.proposals) {
          if (proposal.status !== "delivering") continue;
          proposal.status = "unknown";
          proposal.lastError = "Recovered at startup: prior delivery attempt outcome is unknown after a process restart; reconcile before retrying.";
          proposal.leaseId = null;
          proposal.leaseExpiresAt = null;
          proposal.deliveryFinishedAt = new Date().toISOString();
        }
      });
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

  /**
   * Atomically claims the right to attempt delivery: only one caller can move a proposal from
   * approved/blocked/failed into "delivering", so two concurrent /deliver calls can never both
   * reach the destination adapter for the same proposal. The returned leaseId must be presented
   * to recordDeliveryResult so a stale/expired attempt can never clobber a newer one's outcome.
   */
  async acquireDeliveryLease(id: string, actor: string): Promise<{ proposal: RoutingProposal; leaseId: string }> {
    const now = new Date();
    return this.mutate((state) => {
      const proposal = state.proposals.find((candidate) => candidate.id === id);
      if (!proposal) throw new StoreNotFoundError("Proposal not found");
      if (proposal.status === "delivering") {
        const expired = !proposal.leaseExpiresAt || new Date(proposal.leaseExpiresAt) < now;
        if (expired) {
          proposal.status = "unknown";
          proposal.lastError = "Delivery lease expired before an outcome was recorded; reconcile before retrying.";
          proposal.leaseId = null;
          proposal.leaseExpiresAt = null;
          proposal.deliveryFinishedAt = now.toISOString();
          throw new StoreConflictError("Proposal delivery lease expired and has been moved to unknown; reconcile before retrying");
        }
        throw new StoreConflictError("Proposal delivery is already in progress");
      }
      if (!DELIVERABLE_STATUSES.includes(proposal.status)) throw new StoreConflictError(`Proposal cannot be delivered from ${proposal.status}`);
      const leaseId = randomUUID();
      proposal.status = "delivering";
      proposal.leaseId = leaseId;
      proposal.leaseExpiresAt = new Date(now.getTime() + DELIVERY_LEASE_TTL_MS).toISOString();
      proposal.deliveryStartedAt = now.toISOString();
      proposal.deliveryFinishedAt = null;
      proposal.deliveryAttempt += 1;
      proposal.deliveryActor = actor;
      proposal.lastError = null;
      return { proposal, leaseId };
    });
  }

  /** Only applies if the lease is still the one this caller was issued, guarding against a stale worker. */
  async recordDeliveryResult(
    id: string,
    leaseId: string,
    status: "delivered" | "blocked" | "failed" | "unknown",
    details: { error?: string | null; destinationRequestId?: string | null; destinationResponseStatus?: number | null },
  ): Promise<RoutingProposal> {
    return this.mutate((state) => {
      const proposal = state.proposals.find((candidate) => candidate.id === id);
      if (!proposal) throw new StoreNotFoundError("Proposal not found");
      if (proposal.status !== "delivering" || proposal.leaseId !== leaseId) {
        throw new StoreConflictError("Delivery lease is no longer active for this proposal");
      }
      proposal.status = status;
      proposal.lastError = details.error ?? null;
      proposal.destinationRequestId = details.destinationRequestId ?? null;
      proposal.destinationResponseStatus = details.destinationResponseStatus ?? null;
      proposal.deliveredAt = status === "delivered" ? new Date().toISOString() : null;
      proposal.deliveryFinishedAt = new Date().toISOString();
      proposal.leaseId = null;
      proposal.leaseExpiresAt = null;
      return proposal;
    });
  }

  /** Dead-letter resolution for proposals stuck "unknown" after a crash or expired lease. */
  async reconcileProposal(id: string, decision: "retry" | "delivered" | "failed", note: string | null): Promise<RoutingProposal> {
    return this.mutate((state) => {
      const proposal = state.proposals.find((candidate) => candidate.id === id);
      if (!proposal) throw new StoreNotFoundError("Proposal not found");
      if (proposal.status !== "unknown") throw new StoreConflictError(`Only proposals with status "unknown" can be reconciled, not ${proposal.status}`);
      if (decision === "delivered") {
        proposal.status = "delivered";
        proposal.deliveredAt = new Date().toISOString();
      } else {
        // "retry" and "failed" both land on "failed", which is a deliverable status; the
        // difference is purely the operator's note explaining why a retry is believed safe.
        proposal.status = "failed";
        proposal.deliveredAt = null;
      }
      proposal.lastError = note;
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

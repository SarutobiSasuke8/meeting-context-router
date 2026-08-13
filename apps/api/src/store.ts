import { randomUUID, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  createRoutingProposals,
  emptyRouterState,
  migrateRouterState,
  routerStateSchema,
  sha256,
  stableJson,
  type CanonicalMeeting,
  type DeliveryAttempt,
  type DeliveryOutcome,
  type ProposalStatus,
  type RouterState,
  type RoutingProposal,
} from "@meeting-context-router/core";

export class StoreConflictError extends Error {}
export class StoreNotFoundError extends Error {}

export interface MeetingSummary {
  id: string;
  title: string;
  startedAt: string;
  endedAt: string | null;
  participantCount: number;
  actionItemCount: number;
  decisionCount: number;
  transcriptSegmentCount: number;
  source: string;
  transport: string;
  sourceMeetingId: string;
  receivedAt: string;
  createdAt: string;
}

export interface DeletionCascade {
  meetingId: string;
  sourceHash: string;
  proposalIds: string[];
  deliveredArtifacts: string[];
}

export interface StoreEncryptionOptions {
  key: Buffer | null;
  previousKey: Buffer | null;
}

const ENCRYPTED_MAGIC = "MCR-ENC-1";

interface EncryptedEnvelope {
  format: typeof ENCRYPTED_MAGIC;
  algorithm: "aes-256-gcm";
  iv: string;
  tag: string;
  data: string;
}

function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const envelope: EncryptedEnvelope = {
    format: ENCRYPTED_MAGIC,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
  return `${JSON.stringify(envelope)}\n`;
}

function decrypt(envelope: EncryptedEnvelope, key: Buffer): string {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]).toString("utf8");
}

export class JsonRouterStore {
  private state: RouterState = emptyRouterState();
  private writeChain: Promise<void> = Promise.resolve();
  private readonly encryption: StoreEncryptionOptions;

  constructor(
    private readonly path: string,
    encryption: Partial<StoreEncryptionOptions> = {},
  ) {
    this.encryption = { key: encryption.key ?? null, previousKey: encryption.previousKey ?? null };
  }

  get encrypted(): boolean {
    return this.encryption.key !== null;
  }

  async init(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.persist(this.state);
      return;
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.format === ENCRYPTED_MAGIC) {
      if (!this.encryption.key && !this.encryption.previousKey) {
        throw new Error("State file is encrypted but no MEETING_ROUTER_STATE_KEY is configured");
      }
      const envelope = parsed as unknown as EncryptedEnvelope;
      let plaintext: string | null = null;
      for (const candidate of [this.encryption.key, this.encryption.previousKey]) {
        if (!candidate) continue;
        try {
          plaintext = decrypt(envelope, candidate);
          break;
        } catch {
          // Try the next key; rotation keeps the previous key valid for one cycle.
        }
      }
      if (plaintext === null) throw new Error("State file could not be decrypted with the configured keys");
      this.state = migrateRouterState(JSON.parse(plaintext));
    } else {
      this.state = migrateRouterState(parsed);
    }
    // Re-persist so migrations and key rotations take effect immediately.
    await this.persist(this.state);
  }

  listMeetingSummaries(limit: number, offset: number): { meetings: MeetingSummary[]; total: number } {
    const total = this.state.meetings.length;
    const meetings = this.state.meetings.slice(offset, offset + limit).map((meeting) => ({
      id: meeting.id,
      title: meeting.title,
      startedAt: meeting.startedAt,
      endedAt: meeting.endedAt,
      participantCount: meeting.participants.length,
      actionItemCount: meeting.actionItems.length,
      decisionCount: meeting.decisions.length,
      transcriptSegmentCount: meeting.transcript.length,
      source: meeting.provenance.source,
      transport: meeting.provenance.transport,
      sourceMeetingId: meeting.provenance.sourceMeetingId,
      receivedAt: meeting.provenance.receivedAt,
      createdAt: meeting.createdAt,
    }));
    return { meetings, total };
  }

  getMeeting(id: string): CanonicalMeeting {
    const meeting = this.state.meetings.find((candidate) => candidate.id === id);
    if (!meeting) throw new StoreNotFoundError("Meeting not found");
    return structuredClone(meeting);
  }

  /** Full export for one meeting: content, proposals, attempts, deletion evidence references. */
  exportMeeting(id: string): { meeting: CanonicalMeeting; proposals: RoutingProposal[]; deliveryAttempts: DeliveryAttempt[] } {
    const meeting = this.getMeeting(id);
    const proposals = this.state.proposals.filter((proposal) => proposal.meetingId === id);
    const proposalIds = new Set(proposals.map((proposal) => proposal.id));
    return {
      meeting,
      proposals: structuredClone(proposals),
      deliveryAttempts: structuredClone(this.state.deliveryAttempts.filter((attempt) => proposalIds.has(attempt.proposalId))),
    };
  }

  listProposals(status?: ProposalStatus): RoutingProposal[] {
    return structuredClone(status ? this.state.proposals.filter((proposal) => proposal.status === status) : this.state.proposals);
  }

  getProposal(id: string): RoutingProposal {
    const proposal = this.state.proposals.find((candidate) => candidate.id === id);
    if (!proposal) throw new StoreNotFoundError("Proposal not found");
    return structuredClone(proposal);
  }

  listDeliveryAttempts(proposalId: string): DeliveryAttempt[] {
    return structuredClone(this.state.deliveryAttempts.filter((attempt) => attempt.proposalId === proposalId));
  }

  deletionLog() {
    return structuredClone(this.state.deletionLog);
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
   * Atomically acquires the delivery lease: persists a durable attempt record
   * and moves the proposal to `delivering` BEFORE any destination side effect.
   * A second concurrent caller observes `delivering` with a live lease and
   * receives a conflict. An expired lease is resolved to `unknown` and a new
   * attempt is issued (restart recovery).
   */
  async beginDelivery(id: string, actor: string, leaseSeconds: number, now = new Date()): Promise<DeliveryAttempt> {
    return this.mutate((state) => {
      const proposal = state.proposals.find((candidate) => candidate.id === id);
      if (!proposal) throw new StoreNotFoundError("Proposal not found");
      if (proposal.status === "delivering") {
        const open = state.deliveryAttempts.find((attempt) => attempt.proposalId === id && attempt.outcome === null);
        const leaseExpired = !open || Date.parse(open.leaseExpiresAt) <= now.getTime();
        if (!leaseExpired) throw new StoreConflictError("Proposal delivery is already in progress");
        if (open) {
          open.outcome = "unknown";
          open.finishedAt = now.toISOString();
          open.error = "Delivery lease expired without a recorded result; reconciled on next attempt";
        }
      } else if (!["approved", "blocked", "failed", "unknown"].includes(proposal.status)) {
        throw new StoreConflictError(`Proposal cannot be delivered from ${proposal.status}`);
      }
      const attempt: DeliveryAttempt = {
        id: randomUUID(),
        proposalId: id,
        actor,
        startedAt: now.toISOString(),
        leaseExpiresAt: new Date(now.getTime() + leaseSeconds * 1_000).toISOString(),
        finishedAt: null,
        idempotencyKey: proposal.idempotencyKey,
        contentHash: sha256(stableJson(proposal.payload)),
        destinationStatus: null,
        destinationReceiptId: null,
        outcome: null,
        error: null,
      };
      proposal.status = "delivering";
      proposal.lastError = null;
      state.deliveryAttempts.push(attempt);
      return attempt;
    });
  }

  async finishDelivery(
    id: string,
    attemptId: string,
    outcome: DeliveryOutcome,
    details: { destinationStatus?: number | null; destinationReceiptId?: string | null; error?: string | null } = {},
  ): Promise<RoutingProposal> {
    return this.mutate((state) => {
      const proposal = state.proposals.find((candidate) => candidate.id === id);
      if (!proposal) throw new StoreNotFoundError("Proposal not found");
      const attempt = state.deliveryAttempts.find((candidate) => candidate.id === attemptId);
      if (!attempt || attempt.proposalId !== id) throw new StoreNotFoundError("Delivery attempt not found");
      if (attempt.outcome !== null) throw new StoreConflictError("Delivery attempt already has a recorded result");
      attempt.outcome = outcome;
      attempt.finishedAt = new Date().toISOString();
      attempt.destinationStatus = details.destinationStatus ?? null;
      attempt.destinationReceiptId = details.destinationReceiptId ?? null;
      attempt.error = details.error ?? null;
      proposal.status = outcome;
      proposal.lastError = details.error ?? null;
      proposal.deliveredAt = outcome === "delivered" ? attempt.finishedAt : null;
      return proposal;
    });
  }

  /** Proposals needing operator attention: unknown outcomes and expired delivering leases. */
  listDeadLetter(now = new Date()): Array<{ proposal: RoutingProposal; openAttempt: DeliveryAttempt | null }> {
    const results: Array<{ proposal: RoutingProposal; openAttempt: DeliveryAttempt | null }> = [];
    for (const proposal of this.state.proposals) {
      if (proposal.status === "unknown") {
        results.push({ proposal: structuredClone(proposal), openAttempt: null });
        continue;
      }
      if (proposal.status === "delivering") {
        const open = this.state.deliveryAttempts.find((attempt) => attempt.proposalId === proposal.id && attempt.outcome === null);
        const expired = !open || Date.parse(open.leaseExpiresAt) <= now.getTime();
        if (expired) results.push({ proposal: structuredClone(proposal), openAttempt: open ? structuredClone(open) : null });
      }
    }
    return results;
  }

  previewMeetingDeletion(id: string): DeletionCascade {
    const meeting = this.state.meetings.find((candidate) => candidate.id === id);
    if (!meeting) throw new StoreNotFoundError("Meeting not found");
    const proposals = this.state.proposals.filter((proposal) => proposal.meetingId === id);
    return {
      meetingId: id,
      sourceHash: meeting.provenance.sourceHash,
      proposalIds: proposals.map((proposal) => proposal.id),
      deliveredArtifacts: proposals
        .filter((proposal) => proposal.target === "obsidian" && proposal.status === "delivered")
        .map((proposal) => proposal.id),
    };
  }

  /**
   * Deletes one meeting with cascade: content and dependent proposals are
   * removed, delivery attempts are redacted to identifiers only, and
   * append-only deletion evidence (no content) is recorded.
   */
  async deleteMeeting(id: string, actor: string, artifactsRemoved: string[]): Promise<DeletionCascade> {
    return this.mutate((state) => {
      const meeting = state.meetings.find((candidate) => candidate.id === id);
      if (!meeting) throw new StoreNotFoundError("Meeting not found");
      const proposals = state.proposals.filter((proposal) => proposal.meetingId === id);
      const proposalIds = new Set(proposals.map((proposal) => proposal.id));
      const cascade: DeletionCascade = {
        meetingId: id,
        sourceHash: meeting.provenance.sourceHash,
        proposalIds: [...proposalIds],
        deliveredArtifacts: artifactsRemoved,
      };
      state.meetings = state.meetings.filter((candidate) => candidate.id !== id);
      state.proposals = state.proposals.filter((proposal) => !proposalIds.has(proposal.id));
      for (const attempt of state.deliveryAttempts) {
        if (proposalIds.has(attempt.proposalId) && attempt.error) attempt.error = "redacted-after-deletion";
      }
      state.deletionLog.push({
        id: randomUUID(),
        subjectType: "meeting",
        subjectId: id,
        sourceHash: meeting.provenance.sourceHash,
        proposalIds: [...proposalIds],
        artifactsRemoved,
        actor,
        deletedAt: new Date().toISOString(),
      });
      return cascade;
    });
  }

  /** Deterministic retention sweep: meetings whose createdAt is older than ttlDays. */
  expiredMeetingIds(ttlDays: number, now = new Date()): string[] {
    const cutoff = now.getTime() - ttlDays * 24 * 60 * 60 * 1_000;
    return this.state.meetings.filter((meeting) => Date.parse(meeting.createdAt) <= cutoff).map((meeting) => meeting.id);
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
    const serialized = `${JSON.stringify(state, null, 2)}\n`;
    const contents = this.encryption.key ? encrypt(serialized, this.encryption.key) : serialized;
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.path);
  }
}

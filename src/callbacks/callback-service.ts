import { randomUUID, createHmac } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';

/**
 * Callback requests.
 *
 * STAFF-FIRST BRIDGE. We ring R2NETTE first and only dial the customer once
 * a person has actually picked up. The alternative — calling the customer and
 * then hunting for staff — puts them on hold in silence, which is worse than
 * not calling at all.
 *
 * Worker safety uses a database lease, not an in-process lock: two workers on
 * two machines must never dial the same person twice.
 */

export type CallbackStatus =
  | 'REQUESTED'
  | 'QUEUED'
  | 'STAFF_RINGING'
  | 'STAFF_ACCEPTED'
  | 'CUSTOMER_RINGING'
  | 'CONNECTED'
  | 'NO_ANSWER'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

/** Statuses where a request is still live for the customer. */
export const ACTIVE_CALLBACK_STATUSES: CallbackStatus[] = [
  'REQUESTED',
  'QUEUED',
  'STAFF_RINGING',
  'STAFF_ACCEPTED',
  'CUSTOMER_RINGING',
  'CONNECTED',
];

export class CallbackError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export interface CallResult {
  callSid: string;
  status: 'queued' | 'ringing' | 'in-progress' | 'completed' | 'no-answer' | 'busy' | 'failed';
}

export interface VoiceProvider {
  readonly name: string;
  readonly configured: boolean;
  callStaff(to: string, from: string, callbackId: string): Promise<CallResult>;
  callCustomer(to: string, from: string, callbackId: string): Promise<CallResult>;
  bridgeCall(staffSid: string, customerSid: string): Promise<void>;
  getCallStatus(sid: string): Promise<CallResult>;
  cancelCall(sid: string): Promise<void>;
  /** Twilio signs webhooks; we verify before trusting any status. */
  verifyWebhook(url: string, params: Record<string, string>, signature: string): boolean;
}

export class TwilioVoiceProvider implements VoiceProvider {
  readonly name = 'twilio_voice';
  private readonly sid?: string;
  private readonly token?: string;
  private readonly from?: string;

  constructor(env: Record<string, string | undefined> = process.env) {
    this.sid = env.TWILIO_ACCOUNT_SID;
    this.token = env.TWILIO_AUTH_TOKEN;
    this.from = env.TWILIO_VOICE_NUMBER;
  }

  get configured(): boolean {
    return Boolean(this.sid && this.token && this.from);
  }

  private assert(): void {
    if (!this.configured) {
      throw new CallbackError(
        'Voice calling is not configured. Add TWILIO_VOICE_NUMBER.',
        'INTEGRATION_NOT_CONFIGURED',
      );
    }
  }

  private async create(to: string, from: string, url: string): Promise<CallResult> {
    this.assert();
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${this.sid}/Calls.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${this.sid}:${this.token}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: to, From: from, Url: url }),
    });
    if (!res.ok) throw new CallbackError('Call could not be placed.', 'VOICE_CALL_FAILED');
    const json = (await res.json()) as { sid: string; status: string };
    return { callSid: json.sid, status: json.status as CallResult['status'] };
  }

  async callStaff(to: string, from: string, callbackId: string) {
    return this.create(to, from, `${process.env.PUBLIC_URL ?? ''}/api/v1/voice/staff/${callbackId}`);
  }
  async callCustomer(to: string, from: string, callbackId: string) {
    return this.create(to, from, `${process.env.PUBLIC_URL ?? ''}/api/v1/voice/customer/${callbackId}`);
  }
  async bridgeCall(): Promise<void> {
    // Bridging happens in the TwiML returned to the staff leg.
  }
  async getCallStatus(sid: string): Promise<CallResult> {
    this.assert();
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${this.sid}/Calls/${sid}.json`,
      {
        headers: {
          Authorization: 'Basic ' + Buffer.from(`${this.sid}:${this.token}`).toString('base64'),
        },
      },
    );
    const json = (await res.json()) as { sid: string; status: string };
    return { callSid: json.sid, status: json.status as CallResult['status'] };
  }
  async cancelCall(sid: string): Promise<void> {
    this.assert();
    await fetch(`https://api.twilio.com/2010-04-01/Accounts/${this.sid}/Calls/${sid}.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${this.sid}:${this.token}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ Status: 'canceled' }),
    });
  }

  /** Twilio's documented HMAC-SHA1 signature over URL + sorted params. */
  verifyWebhook(url: string, params: Record<string, string>, signature: string): boolean {
    if (!this.token) return false;
    const data =
      url +
      Object.keys(params)
        .sort()
        .map((k) => k + params[k])
        .join('');
    const expected = createHmac('sha1', this.token).update(Buffer.from(data, 'utf8')).digest('base64');
    return expected === signature;
  }
}

export class FakeVoiceProvider implements VoiceProvider {
  readonly name = 'fake_voice';
  readonly configured = true;
  staffCalls: string[] = [];
  customerCalls: string[] = [];
  bridged: { staff: string; customer: string }[] = [];
  nextStaffStatus: CallResult['status'] = 'ringing';
  nextCustomerStatus: CallResult['status'] = 'ringing';

  async callStaff(to: string): Promise<CallResult> {
    this.staffCalls.push(to);
    return { callSid: `CAstaff${this.staffCalls.length}`, status: this.nextStaffStatus };
  }
  async callCustomer(to: string): Promise<CallResult> {
    this.customerCalls.push(to);
    return { callSid: `CAcust${this.customerCalls.length}`, status: this.nextCustomerStatus };
  }
  async bridgeCall(staffSid: string, customerSid: string): Promise<void> {
    this.bridged.push({ staff: staffSid, customer: customerSid });
  }
  async getCallStatus(sid: string): Promise<CallResult> {
    return { callSid: sid, status: 'in-progress' };
  }
  async cancelCall(): Promise<void> {}
  verifyWebhook(): boolean {
    return true;
  }
}

/* ------------------------------------------------------------------ */

export interface CallbackLimits {
  perPhonePerHour: number;
  perIpPerHour: number;
  maxAttempts: number;
}

export const DEFAULT_CALLBACK_LIMITS: CallbackLimits = {
  perPhonePerHour: 3,
  perIpPerHour: 10,
  maxAttempts: 3,
};

export class CallbackService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly voice: VoiceProvider | null,
    private readonly now: () => Date = () => new Date(),
    private readonly limits: CallbackLimits = DEFAULT_CALLBACK_LIMITS,
  ) {}

  /**
   * Create a request.
   *
   * Works with no voice provider at all: the request is persisted and shown
   * to operations. We never animate a call that isn't happening.
   */
  async request(input: {
    phoneE164: string;
    customerId?: string | null;
    reason?: string;
    source?: string;
    requestedFor?: Date | null;
    ip?: string;
  }) {
    const since = new Date(this.now().getTime() - 3600_000);

    const recent = await this.prisma.callbackRequest.count({
      where: { phoneE164: input.phoneE164, createdAt: { gt: since } },
    });
    if (recent >= this.limits.perPhonePerHour) {
      throw new CallbackError('Too many callback requests. Try again later.', 'RATE_LIMITED');
    }

    // One live request per person: a second tap should surface the existing
    // one rather than queue another call.
    const active = await this.prisma.callbackRequest.findFirst({
      where: { phoneE164: input.phoneE164, status: { in: ACTIVE_CALLBACK_STATUSES } },
    });
    if (active) {
      return { callback: active, alreadyActive: true };
    }

    const callback = await this.prisma.callbackRequest.create({
      data: {
        phoneE164: input.phoneE164,
        customerId: input.customerId ?? null,
        reason: input.reason ?? null,
        source: input.source ?? 'CONCIERGE',
        requestedFor: input.requestedFor ?? null,
        status: 'QUEUED',
      },
    });
    return { callback, alreadyActive: false };
  }

  /**
   * Claim one due request with a database lease.
   *
   * The conditional UPDATE is the whole mechanism: only one worker's write
   * matches the `claimedUntil` precondition, so only one worker dials.
   */
  async claimNext(workerId: string, leaseMs = 120_000) {
    const now = this.now();
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      UPDATE "CallbackRequest"
      SET "claimedBy" = ${workerId},
          "claimedUntil" = ${new Date(now.getTime() + leaseMs)},
          "updatedAt" = now()
      WHERE "id" = (
        SELECT "id" FROM "CallbackRequest"
        WHERE "status" = 'QUEUED'
          AND ("requestedFor" IS NULL OR "requestedFor" <= ${now})
          AND ("claimedUntil" IS NULL OR "claimedUntil" < ${now})
        ORDER BY "requestedAt" ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING "id"
    `;
    if (rows.length === 0) return null;
    return this.prisma.callbackRequest.findUnique({ where: { id: rows[0]!.id } });
  }

  /** Ring staff first. The customer is only dialled after someone answers. */
  async dialStaffFirst(callbackId: string) {
    if (!this.voice?.configured) {
      // Persisted and visible to operations — never a fake "Calling…".
      return { dialed: false as const, reason: 'VOICE_NOT_CONFIGURED' as const };
    }
    const cb = await this.prisma.callbackRequest.findUniqueOrThrow({ where: { id: callbackId } });
    if (cb.attemptCount >= this.limits.maxAttempts) {
      await this.fail(callbackId, 'MAX_ATTEMPTS');
      return { dialed: false as const, reason: 'MAX_ATTEMPTS' as const };
    }

    const phone = await this.prisma.businessPhone.findFirst({
      where: { enabled: true, supportsOutbound: true },
      orderBy: { priority: 'asc' },
    });
    if (!phone) {
      return { dialed: false as const, reason: 'NO_STAFF_LINE' as const };
    }

    const call = await this.voice.callStaff(phone.phoneE164, phone.phoneE164, callbackId);
    await this.prisma.callbackRequest.update({
      where: { id: callbackId },
      data: {
        status: 'STAFF_RINGING',
        staffCallSid: call.callSid,
        assignedBusinessPhoneId: phone.id,
        attemptCount: { increment: 1 },
        lastAttemptAt: this.now(),
      },
    });
    return { dialed: true as const, callSid: call.callSid };
  }

  /** Staff picked up. Now — and only now — we call the customer. */
  async onStaffAccepted(callbackId: string) {
    const cb = await this.prisma.callbackRequest.findUniqueOrThrow({ where: { id: callbackId } });
    if (cb.status !== 'STAFF_RINGING') return cb;
    if (!this.voice?.configured) throw new CallbackError('Voice not configured.', 'INTEGRATION_NOT_CONFIGURED');

    const phone = cb.assignedBusinessPhoneId
      ? await this.prisma.businessPhone.findUnique({ where: { id: cb.assignedBusinessPhoneId } })
      : null;

    await this.prisma.callbackRequest.update({
      where: { id: callbackId },
      data: { status: 'STAFF_ACCEPTED' },
    });
    const call = await this.voice.callCustomer(
      cb.phoneE164,
      phone?.phoneE164 ?? '',
      callbackId,
    );
    return this.prisma.callbackRequest.update({
      where: { id: callbackId },
      data: { status: 'CUSTOMER_RINGING', customerCallSid: call.callSid },
    });
  }

  /** Both legs live. CONNECTED is only ever set from a provider event. */
  async onConnected(callbackId: string) {
    const cb = await this.prisma.callbackRequest.findUniqueOrThrow({ where: { id: callbackId } });
    if (cb.staffCallSid && cb.customerCallSid && this.voice) {
      await this.voice.bridgeCall(cb.staffCallSid, cb.customerCallSid);
    }
    return this.prisma.callbackRequest.update({
      where: { id: callbackId },
      data: { status: 'CONNECTED', connectedAt: this.now(), claimedBy: null, claimedUntil: null },
    });
  }

  async onNoAnswer(callbackId: string, who: 'STAFF' | 'CUSTOMER') {
    const cb = await this.prisma.callbackRequest.findUniqueOrThrow({ where: { id: callbackId } });
    // Staff not answering is a retry; the customer not answering is not our
    // cue to keep dialling them.
    const retry = who === 'STAFF' && cb.attemptCount < this.limits.maxAttempts;
    return this.prisma.callbackRequest.update({
      where: { id: callbackId },
      data: {
        status: retry ? 'QUEUED' : 'NO_ANSWER',
        failureReason: `${who}_NO_ANSWER`,
        claimedBy: null,
        claimedUntil: null,
      },
    });
  }

  async complete(callbackId: string) {
    return this.prisma.callbackRequest.update({
      where: { id: callbackId },
      data: { status: 'COMPLETED', completedAt: this.now(), claimedBy: null, claimedUntil: null },
    });
  }

  async fail(callbackId: string, reason: string) {
    return this.prisma.callbackRequest.update({
      where: { id: callbackId },
      data: { status: 'FAILED', failureReason: reason, claimedBy: null, claimedUntil: null },
    });
  }

  async cancel(callbackId: string, customerId: string) {
    const cb = await this.prisma.callbackRequest.findUnique({ where: { id: callbackId } });
    if (!cb || cb.customerId !== customerId) {
      throw new CallbackError('Not found.', 'NOT_FOUND');
    }
    return this.prisma.callbackRequest.update({
      where: { id: callbackId },
      data: { status: 'CANCELLED' },
    });
  }

  /** Public phone directory. Never invents a number. */
  async publicPhones() {
    return this.prisma.businessPhone.findMany({
      where: { isPublic: true, enabled: true },
      orderBy: { priority: 'asc' },
      select: { id: true, label: true, displayNumber: true, phoneE164: true, purpose: true },
    });
  }
}

/** Mask a number for any customer-visible confirmation. */
export function maskCallbackPhone(e164: string): string {
  const d = e164.replace(/\D/g, '');
  if (d.length < 10) return '•••';
  return `(${d.slice(-10, -7)}) •••-${d.slice(-4)}`;
}

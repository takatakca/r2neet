import { describe, it, expect, beforeEach } from 'vitest';
import {
  findAvailableSlots,
  verifySlotStillOpen,
  localToUtc,
  type StaffMember,
  type StaffBusy,
} from '../src/scheduling/availability.js';
import { BookingService, formatBookingNumber } from '../src/booking/booking.js';
import {
  MemorySchedulingRepo,
  MemoryQuoteRepo,
  MemoryCustomerRepo,
  integrationStatus,
} from '../src/data/repositories.js';
import {
  IdentityService,
  FakeVerificationProvider,
  RateLimiter,
  normalizePhone,
  maskPhone,
  IdentityError,
  assertOwnsAddress,
  type VerifiedSession,
  type CustomerAddress,
} from '../src/identity/identity.js';
import { SERVICES } from '../src/data/catalogue.js';
import type { ServiceOption } from '../src/domain/types.js';

const svc = (id: string): ServiceOption => {
  const s = SERVICES.find((x) => x.id === id);
  if (!s) throw new Error(`missing service ${id}`);
  return s;
};

const ALL_WEEK = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
  weekday,
  startMinute: 8 * 60,
  endMinute: 17 * 60,
}));

const cleaner = (id: string, skills: string[] = []): StaffMember => ({
  id,
  displayName: id,
  active: true,
  skills,
  weeklyAvailability: ALL_WEEK,
});

// Monday 14 September 2026
const DAY = '2026-09-14';
const NOW = localToUtc(2026, 9, 14, 6 * 60); // 6am local, before opening

describe('availability — clock time vs labour time', () => {
  it('a 2-cleaner 3-hour job blocks 3 hours of clock time, not 6', () => {
    const s = svc('svc_basic_2x3');
    expect(s.requiredStaffCount).toBe(2);
    expect(s.appointmentDurationMinutes).toBe(180);
    expect(s.labourMinutes).toBe(360);

    const slots = findAvailableSlots({
      service: s,
      dateKey: DAY,
      staff: [cleaner('a'), cleaner('b')],
      busy: [],
      now: NOW,
      minimumLeadMinutes: 0,
    });
    const first = slots[0]!;
    expect((first.endUtc.getTime() - first.startUtc.getTime()) / 60000).toBe(180);
  });

  it('returns nothing when only one cleaner exists for a two-cleaner service', () => {
    const slots = findAvailableSlots({
      service: svc('svc_basic_2x3'),
      dateKey: DAY,
      staff: [cleaner('a')],
      busy: [],
      now: NOW,
      minimumLeadMinutes: 0,
    });
    expect(slots).toEqual([]);
  });

  it('proposes exactly the required number of cleaners even when more are free', () => {
    const slots = findAvailableSlots({
      service: svc('svc_basic_2x3'),
      dateKey: DAY,
      staff: [cleaner('a'), cleaner('b'), cleaner('c')],
      busy: [],
      now: NOW,
      minimumLeadMinutes: 0,
    });
    expect(slots[0]!.proposedStaffIds).toHaveLength(2);
    expect(slots[0]!.eligibleStaffIds).toHaveLength(3);
  });

  it('drops a slot when an existing booking removes the second cleaner', () => {
    const busy: StaffBusy[] = [
      {
        staffId: 'b',
        startUtc: localToUtc(2026, 9, 14, 8 * 60),
        endUtc: localToUtc(2026, 9, 14, 11 * 60),
        kind: 'BOOKING',
      },
    ];
    const slots = findAvailableSlots({
      service: svc('svc_basic_2x3'),
      dateKey: DAY,
      staff: [cleaner('a'), cleaner('b')],
      busy,
      now: NOW,
      minimumLeadMinutes: 0,
      buffers: { preJobMinutes: 0, postJobMinutes: 0 },
    });
    expect(slots.some((s) => s.startUtc.getTime() === localToUtc(2026, 9, 14, 8 * 60).getTime())).toBe(false);
    expect(slots.some((s) => s.startUtc.getTime() === localToUtc(2026, 9, 14, 11 * 60).getTime())).toBe(true);
  });

  it('honours time off', () => {
    const busy: StaffBusy[] = [
      {
        staffId: 'b',
        startUtc: localToUtc(2026, 9, 14, 0),
        endUtc: localToUtc(2026, 9, 15, 0),
        kind: 'TIME_OFF',
      },
    ];
    const slots = findAvailableSlots({
      service: svc('svc_basic_2x3'),
      dateKey: DAY,
      staff: [cleaner('a'), cleaner('b')],
      busy,
      now: NOW,
      minimumLeadMinutes: 0,
    });
    expect(slots).toEqual([]);
  });

  it('respects the post-job travel buffer', () => {
    const busy: StaffBusy[] = [
      {
        staffId: 'a',
        startUtc: localToUtc(2026, 9, 14, 8 * 60),
        endUtc: localToUtc(2026, 9, 14, 11 * 60),
        kind: 'BOOKING',
      },
    ];
    const at1100 = localToUtc(2026, 9, 14, 11 * 60);
    const noBuffer = findAvailableSlots({
      service: svc('svc_basic_1x3'),
      dateKey: DAY,
      staff: [cleaner('a')],
      busy,
      now: NOW,
      minimumLeadMinutes: 0,
      buffers: { preJobMinutes: 0, postJobMinutes: 0 },
    });
    const withBuffer = findAvailableSlots({
      service: svc('svc_basic_1x3'),
      dateKey: DAY,
      staff: [cleaner('a')],
      busy,
      now: NOW,
      minimumLeadMinutes: 0,
      buffers: { preJobMinutes: 0, postJobMinutes: 30 },
    });
    expect(noBuffer.some((s) => s.startUtc.getTime() === at1100.getTime())).toBe(true);
    expect(withBuffer.some((s) => s.startUtc.getTime() === at1100.getTime())).toBe(false);
  });

  it('only offers cleaners qualified for the service', () => {
    const slots = findAvailableSlots({
      service: svc('svc_deep_1x3'),
      dateKey: DAY,
      staff: [cleaner('a', ['svc_basic_1x3'])],
      busy: [],
      now: NOW,
      minimumLeadMinutes: 0,
    });
    expect(slots).toEqual([]);
  });

  it('flags when the customer usual cleaner is on the proposed crew', () => {
    const slots = findAvailableSlots({
      service: svc('svc_basic_1x3'),
      dateKey: DAY,
      staff: [cleaner('a'), cleaner('zed')],
      busy: [],
      now: NOW,
      minimumLeadMinutes: 0,
      preferredStaffId: 'zed',
    });
    expect(slots[0]!.proposedStaffIds).toContain('zed');
    expect(slots[0]!.preferredStaffAvailable).toBe(true);
  });

  it('refuses to schedule a quote-required service', () => {
    expect(() =>
      findAvailableSlots({
        service: svc('svc_window'),
        dateKey: DAY,
        staff: [cleaner('a')],
        busy: [],
        now: NOW,
      }),
    ).toThrow(/quote/i);
  });

  it('never offers a slot that runs past closing', () => {
    const slots = findAvailableSlots({
      service: svc('svc_basic_2x4'),
      dateKey: DAY,
      staff: [cleaner('a'), cleaner('b')],
      busy: [],
      now: NOW,
      minimumLeadMinutes: 0,
      closeMinute: 17 * 60,
    });
    for (const s of slots) {
      const endLocal = (s.endUtc.getTime() - localToUtc(2026, 9, 14, 0).getTime()) / 60000;
      expect(endLocal).toBeLessThanOrEqual(17 * 60);
    }
  });

  it('respects minimum lead time', () => {
    const tenAm = localToUtc(2026, 9, 14, 10 * 60);
    const slots = findAvailableSlots({
      service: svc('svc_basic_1x3'),
      dateKey: DAY,
      staff: [cleaner('a')],
      busy: [],
      now: tenAm,
      minimumLeadMinutes: 120,
    });
    for (const s of slots) expect(s.startUtc.getTime()).toBeGreaterThanOrEqual(tenAm.getTime() + 120 * 60000);
  });
});

describe('DST safety', () => {
  it('keeps a 9am local start at 9am across the spring-forward day', () => {
    // 8 March 2026 — clocks jump 2am -> 3am in Toronto
    const before = localToUtc(2026, 3, 7, 9 * 60);
    const during = localToUtc(2026, 3, 8, 9 * 60);
    const after = localToUtc(2026, 3, 9, 9 * 60);
    const fmt = (d: Date) =>
      new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Toronto',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(d);
    expect(fmt(before)).toBe('09:00');
    expect(fmt(during)).toBe('09:00');
    expect(fmt(after)).toBe('09:00');
  });

  it('keeps 9am local across the fall-back day', () => {
    const during = localToUtc(2026, 11, 1, 9 * 60);
    expect(
      new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Toronto',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(during),
    ).toBe('09:00');
  });
});

describe('slot holds and booking confirmation', () => {
  let repo: MemorySchedulingRepo;
  let quotes: MemoryQuoteRepo;
  let service: BookingService;
  let idc = 0;
  const start = localToUtc(2026, 9, 14, 10 * 60);

  const putQuote = (over: Partial<Parameters<MemoryQuoteRepo['put']>[0]> = {}) => {
    const q = {
      id: 'q1',
      serviceOptionId: 'svc_basic_2x3',
      grandTotalCents: 25878,
      expiresAt: new Date(NOW.getTime() + 30 * 60000),
      customerId: 'cus_1',
      snapshot: { frozen: true, grandTotalCents: 25878 },
      ...over,
    };
    quotes.put(q);
    return q;
  };

  beforeEach(() => {
    repo = new MemorySchedulingRepo();
    quotes = new MemoryQuoteRepo();
    idc = 0;
    repo.staff = [cleaner('a'), cleaner('b')];
    service = new BookingService(repo, quotes, () => NOW, () => `id_${++idc}`, {
      preJobMinutes: 0,
      postJobMinutes: 0,
    });
  });

  it('creates a hold that reserves exactly the required cleaners', async () => {
    const hold = await service.holdSlot({
      service: svc('svc_basic_2x3'),
      startUtc: start,
      customerId: 'cus_1',
    });
    expect(hold.staffIds).toHaveLength(2);
    expect(hold.expiresAt.getTime() - NOW.getTime()).toBe(10 * 60000);
  });

  it('a live hold blocks the last remaining capacity', async () => {
    await service.holdSlot({ service: svc('svc_basic_2x3'), startUtc: start, customerId: 'cus_1' });
    await expect(
      service.holdSlot({ service: svc('svc_basic_2x3'), startUtc: start, customerId: 'cus_2' }),
    ).rejects.toThrow(/just taken/i);
  });

  it('two simultaneous requests for the last crew: exactly one wins', async () => {
    const results = await Promise.allSettled([
      service.holdSlot({ service: svc('svc_basic_2x3'), startUtc: start, customerId: 'cus_1' }),
      service.holdSlot({ service: svc('svc_basic_2x3'), startUtc: start, customerId: 'cus_2' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });

  it('an expired hold releases capacity again', async () => {
    let clock = NOW;
    const svcLate = new BookingService(repo, quotes, () => clock, () => `id_${++idc}`, {
      preJobMinutes: 0,
      postJobMinutes: 0,
    });
    await svcLate.holdSlot({ service: svc('svc_basic_2x3'), startUtc: start, customerId: 'cus_1' });
    clock = new Date(NOW.getTime() + 11 * 60000); // past the 10-minute TTL
    const second = await svcLate.holdSlot({
      service: svc('svc_basic_2x3'),
      startUtc: start,
      customerId: 'cus_2',
    });
    expect(second.staffIds).toHaveLength(2);
  });

  it('the server allocates the booking number, and it is sequential per year', async () => {
    putQuote();
    const hold = await service.holdSlot({
      service: svc('svc_basic_2x3'),
      startUtc: start,
      customerId: 'cus_1',
    });
    const booking = await service.confirmBooking({
      holdId: hold.id,
      quoteId: 'q1',
      customerId: 'cus_1',
      addressId: 'addr_1',
      service: svc('svc_basic_2x3'),
    });
    expect(booking.bookingNumber).toBe('R2N-2026-000001');
    expect(booking.status).toBe('CONFIRMED');
    expect(formatBookingNumber(2026, 1284)).toBe('R2N-2026-001284');
  });

  it('takes the total from the quote and ignores anything the browser claims', async () => {
    putQuote({ grandTotalCents: 25878 });
    const hold = await service.holdSlot({
      service: svc('svc_basic_2x3'),
      startUtc: start,
      customerId: 'cus_1',
    });
    const booking = await service.confirmBooking({
      holdId: hold.id,
      quoteId: 'q1',
      customerId: 'cus_1',
      addressId: 'addr_1',
      service: svc('svc_basic_2x3'),
      clientClaimedTotalCents: 100, // "I'll pay a dollar"
    });
    expect(booking.grandTotalCents).toBe(25878);
  });

  it('refuses to confirm with an expired quote', async () => {
    putQuote({ expiresAt: new Date(NOW.getTime() - 1000) });
    const hold = await service.holdSlot({
      service: svc('svc_basic_2x3'),
      startUtc: start,
      customerId: 'cus_1',
    });
    await expect(
      service.confirmBooking({
        holdId: hold.id,
        quoteId: 'q1',
        customerId: 'cus_1',
        addressId: 'addr_1',
        service: svc('svc_basic_2x3'),
      }),
    ).rejects.toThrow(/expired/i);
  });

  it('refuses to confirm with an expired hold', async () => {
    putQuote();
    let clock = NOW;
    const late = new BookingService(repo, quotes, () => clock, () => `id_${++idc}`, {
      preJobMinutes: 0,
      postJobMinutes: 0,
    });
    const hold = await late.holdSlot({
      service: svc('svc_basic_2x3'),
      startUtc: start,
      customerId: 'cus_1',
    });
    clock = new Date(NOW.getTime() + 11 * 60000);
    quotes.put({ ...quotes.quotes.get('q1')!, expiresAt: new Date(clock.getTime() + 60000) });
    await expect(
      late.confirmBooking({
        holdId: hold.id,
        quoteId: 'q1',
        customerId: 'cus_1',
        addressId: 'addr_1',
        service: svc('svc_basic_2x3'),
      }),
    ).rejects.toThrow(/expired/i);
  });

  it('refuses to confirm without a hold', async () => {
    putQuote();
    await expect(
      service.confirmBooking({
        holdId: 'made-up',
        quoteId: 'q1',
        customerId: 'cus_1',
        addressId: 'addr_1',
        service: svc('svc_basic_2x3'),
      }),
    ).rejects.toThrow(/gone/i);
  });

  it('one customer cannot confirm against another customer hold', async () => {
    putQuote();
    const hold = await service.holdSlot({
      service: svc('svc_basic_2x3'),
      startUtc: start,
      customerId: 'cus_1',
    });
    await expect(
      service.confirmBooking({
        holdId: hold.id,
        quoteId: 'q1',
        customerId: 'cus_intruder',
        addressId: 'addr_1',
        service: svc('svc_basic_2x3'),
      }),
    ).rejects.toThrow(/gone/i);
  });

  it('rejects a quote for a different service than the one held', async () => {
    putQuote({ serviceOptionId: 'svc_deep_1x3' });
    const hold = await service.holdSlot({
      service: svc('svc_basic_2x3'),
      startUtc: start,
      customerId: 'cus_1',
    });
    await expect(
      service.confirmBooking({
        holdId: hold.id,
        quoteId: 'q1',
        customerId: 'cus_1',
        addressId: 'addr_1',
        service: svc('svc_basic_2x3'),
      }),
    ).rejects.toThrow(/does not match/i);
  });

  it('a hold cannot be redeemed twice', async () => {
    putQuote();
    const hold = await service.holdSlot({
      service: svc('svc_basic_2x3'),
      startUtc: start,
      customerId: 'cus_1',
    });
    await service.confirmBooking({
      holdId: hold.id,
      quoteId: 'q1',
      customerId: 'cus_1',
      addressId: 'addr_1',
      service: svc('svc_basic_2x3'),
    });
    await expect(
      service.confirmBooking({
        holdId: hold.id,
        quoteId: 'q1',
        customerId: 'cus_1',
        addressId: 'addr_1',
        service: svc('svc_basic_2x3'),
      }),
    ).rejects.toThrow(/already used/i);
  });

  it('freezes the price snapshot onto the booking', async () => {
    putQuote();
    const hold = await service.holdSlot({
      service: svc('svc_basic_2x3'),
      startUtc: start,
      customerId: 'cus_1',
    });
    const booking = await service.confirmBooking({
      holdId: hold.id,
      quoteId: 'q1',
      customerId: 'cus_1',
      addressId: 'addr_1',
      service: svc('svc_basic_2x3'),
    });
    expect(booking.priceSnapshot).toEqual({ frozen: true, grandTotalCents: 25878 });
  });
});

describe('phone identity', () => {
  it('normalizes Canadian numbers to E.164', () => {
    for (const input of ['514 825 2825', '(514) 825-2825', '+1 514 825 2825', '15148252825']) {
      expect(normalizePhone(input)).toBe('+15148252825');
    }
  });

  it('rejects malformed numbers', () => {
    expect(() => normalizePhone('123')).toThrow(IdentityError);
    expect(() => normalizePhone('014 825 2825')).toThrow(/valid/i);
    expect(() => normalizePhone('+44 20 7946 0000')).toThrow(/Canadian/i);
  });

  it('masks numbers for display and logs', () => {
    expect(maskPhone('+15148252825')).toBe('+1 514 ••• 2825');
  });
});

describe('OTP flow', () => {
  let provider: FakeVerificationProvider;
  let customers: MemoryCustomerRepo;
  let identity: IdentityService;
  let clock: number;

  beforeEach(() => {
    provider = new FakeVerificationProvider('123456');
    customers = new MemoryCustomerRepo();
    clock = Date.parse('2026-09-14T12:00:00Z');
    identity = new IdentityService(
      provider,
      customers,
      new RateLimiter(undefined, () => clock),
      () => new Date(clock),
    );
  });

  it('says the same neutral thing whether or not the customer exists', async () => {
    await customers.create('+15148252825');
    const known = await identity.startVerification('514 825 2825', '1.1.1.1');
    clock += 60000;
    const unknown = await identity.startVerification('514 825 2826', '1.1.1.2');
    expect(known.message).toBe(unknown.message);
    expect(known).not.toHaveProperty('customerId');
    expect(known).not.toHaveProperty('firstName');
  });

  it('accepts the right code and recognizes a returning customer', async () => {
    const existing = await customers.create('+15148252825');
    existing.firstName = 'Pascal';
    await identity.startVerification('514 825 2825', '1.1.1.1');
    const session = await identity.completeVerification('514 825 2825', '123456');
    expect(session.isNewCustomer).toBe(false);
    expect(session.customerId).toBe(existing.id);
    const profile = await identity.profileForSession(session);
    expect(profile.firstName).toBe('Pascal');
  });

  it('creates a customer on first verification', async () => {
    await identity.startVerification('514 825 2825', '1.1.1.1');
    const session = await identity.completeVerification('514 825 2825', '123456');
    expect(session.isNewCustomer).toBe(true);
  });

  it('rejects a wrong code', async () => {
    await identity.startVerification('514 825 2825', '1.1.1.1');
    await expect(identity.completeVerification('514 825 2825', '999999')).rejects.toThrow(/not right/i);
  });

  it('locks out after too many wrong codes', async () => {
    await identity.startVerification('514 825 2825', '1.1.1.1');
    for (let i = 0; i < 5; i++) {
      await expect(identity.completeVerification('514 825 2825', '000000')).rejects.toThrow();
    }
    await expect(identity.completeVerification('514 825 2825', '123456')).rejects.toThrow(
      /Too many incorrect/i,
    );
  });

  it('enforces a resend cooldown', async () => {
    await identity.startVerification('514 825 2825', '1.1.1.1');
    await expect(identity.startVerification('514 825 2825', '1.1.1.1')).rejects.toThrow(/Wait/i);
  });

  it('caps sends per phone per hour', async () => {
    for (let i = 0; i < 5; i++) {
      await identity.startVerification('514 825 2825', `1.1.1.${i}`);
      clock += 60000;
    }
    await expect(identity.startVerification('514 825 2825', '1.1.1.9')).rejects.toThrow(
      /Too many codes/i,
    );
  });

  it('caps sends per IP per hour across different numbers', async () => {
    for (let i = 0; i < 15; i++) {
      await identity.startVerification(`514 825 28${String(10 + i)}`, '9.9.9.9');
      clock += 60000;
    }
    await expect(identity.startVerification('514 999 1234', '9.9.9.9')).rejects.toThrow(
      /Too many codes/i,
    );
  });

  it('expires a verified session', async () => {
    await identity.startVerification('514 825 2825', '1.1.1.1');
    const session = await identity.completeVerification('514 825 2825', '123456');
    clock += 61 * 60000;
    await expect(identity.profileForSession(session)).rejects.toThrow(/expired/i);
  });

  it('never lets one customer read another address', () => {
    const session: VerifiedSession = {
      phoneE164: '+15148252825',
      customerId: 'cus_1',
      isNewCustomer: false,
      verifiedAt: new Date(),
      expiresAt: new Date(Date.now() + 60000),
    };
    const other: CustomerAddress = {
      id: 'addr_x',
      customerId: 'cus_2',
      label: 'Home',
      formattedAddress: '754 Av. 36e',
      placeId: null,
      city: 'Lachine',
      province: 'QC',
      postalCode: 'H8T 1B7',
      latitude: null,
      longitude: null,
      isDefault: true,
    };
    expect(() => assertOwnsAddress(session, other)).toThrow(/Not found/);
  });
});

describe('integration status', () => {
  it('reports NOT_CONFIGURED when credentials are absent, never a fake green light', () => {
    const states = integrationStatus({});
    expect(states.every((s) => s.status === 'NOT_CONFIGURED')).toBe(true);
    const stripe = states.find((s) => s.key === 'stripe')!;
    expect(stripe.missingEnv).toContain('STRIPE_SECRET_KEY');
    expect(stripe.blocks).toMatch(/Apple Pay/);
  });

  it('reports CONNECTED only when every required variable is present', () => {
    const partial = integrationStatus({ TWILIO_ACCOUNT_SID: 'x', TWILIO_AUTH_TOKEN: 'y' });
    expect(partial.find((s) => s.key === 'takatak_auth')!.status).toBe('NOT_CONFIGURED');

    const full = integrationStatus({
      TAKATAK_SUPABASE_URL: 'https://project.supabase.co',
      TAKATAK_SUPABASE_ANON_KEY: 'anon-key',
    });
    expect(full.find((s) => s.key === 'takatak_auth')!.status).toBe('CONNECTED');
  });

  it('treats a blank string as missing', () => {
    const states = integrationStatus({ GOOGLE_MAPS_API_KEY: '   ' });
    expect(states.find((s) => s.key === 'google_maps')!.status).toBe('NOT_CONFIGURED');
  });
});

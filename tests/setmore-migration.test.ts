import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  SetmoreImporter,
  mapServiceName,
  parseCsv,
  mapCustomerColumns,
  mapAppointmentColumns,
  validateCustomer,
  validateAppointment,
  externalIdFor,
} from '../src/migration/setmore-import.js';
import { assertDestructiveAllowed } from '../src/db/safety.js';
import { seed } from '../prisma/seed.js';

const URL_ = process.env.TEST_DATABASE_URL;
const d = URL_ ? describe : describe.skip;

const wall = (date: Date) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);

describe('service mapping', () => {
  it('maps a fully specified basic service', () => {
    expect(mapServiceName('Basic Cleaning - 2 Cleaners 3 Hours')).toBe('svc_basic_2x3');
    expect(mapServiceName('basic cleaning 1 cleaner 3 hours')).toBe('svc_basic_1x3');
  });

  it('maps deep cleaning', () => {
    expect(mapServiceName('Deep Cleaning — 2 Cleaners × 4 Hours')).toBe('svc_deep_2x4');
  });

  it('maps the single-variant services without crew or duration', () => {
    expect(mapServiceName('Move-in / Move-out Cleaning')).toBe('svc_move');
    expect(mapServiceName('Carpet Cleaning')).toBe('svc_carpet');
    expect(mapServiceName('Window Washing')).toBe('svc_window');
  });

  it('understands French service names', () => {
    expect(mapServiceName('Grand ménage - 2 nettoyeurs 3 heures')).toBe('svc_deep_2x3');
    expect(mapServiceName('Nettoyage de tapis')).toBe('svc_carpet');
  });

  it('[INV-DATA-04] REFUSES to guess when crew size or duration is missing', () => {
    // "Basic Cleaning" alone does not say whether two cleaners were booked
    // for three hours or one for four. Guessing sends the wrong crew.
    expect(mapServiceName('Basic Cleaning')).toBeNull();
    expect(mapServiceName('Deep Clean 2 Cleaners')).toBeNull();
    expect(mapServiceName('Cleaning 3 hours')).toBeNull();
  });

  it('returns null for anything unrecognised', () => {
    expect(mapServiceName('Consultation')).toBeNull();
    expect(mapServiceName('')).toBeNull();
  });
});

describe('CSV parsing', () => {
  it('handles quoted fields containing commas', () => {
    const csv = 'Name,Address\n"Denis, Pascal","754 Av. 36e, Lachine, QC"';
    const rows = parseCsv(csv);
    expect(rows[0]!.Name).toBe('Denis, Pascal');
    // A naive split(',') corrupts exactly the rows that matter most.
    expect(rows[0]!.Address).toBe('754 Av. 36e, Lachine, QC');
  });

  it('handles escaped quotes', () => {
    const rows = parseCsv('Note\n"He said ""urgent"" twice"');
    expect(rows[0]!.Note).toBe('He said "urgent" twice');
  });

  it('handles CRLF and a byte-order mark from Excel', () => {
    const rows = parseCsv('\uFEFFA,B\r\n1,2\r\n');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ A: '1', B: '2' });
  });

  it('skips blank lines', () => {
    expect(parseCsv('A\n1\n\n2\n')).toHaveLength(2);
  });

  it('returns nothing for an empty file', () => {
    expect(parseCsv('')).toEqual([]);
  });

  it('accepts the column names Setmore actually exports', () => {
    const c = mapCustomerColumns({ 'First Name': 'Pascal', 'Phone Number': '514-825-2825' });
    expect(c.firstName).toBe('Pascal');
    expect(c.phone).toBe('514-825-2825');

    const a = mapAppointmentColumns({ 'Service Name': 'Basic', 'Start Date': '2026-09-01' });
    expect(a.serviceName).toBe('Basic');
    expect(a.date).toBe('2026-09-01');
  });
});

describe('validation', () => {
  it('rejects a customer with no way to sign in', () => {
    const issues = validateCustomer({ firstName: 'Ghost' }, 1);
    expect(issues.some((i) => i.severity === 'ERROR' && i.field === 'phone')).toBe(true);
  });

  it('rejects an unusable phone number', () => {
    const issues = validateCustomer({ phone: '123' }, 1);
    expect(issues.some((i) => i.severity === 'ERROR')).toBe(true);
  });

  it('warns but accepts a missing name', () => {
    const issues = validateCustomer({ phone: '514-825-2825' }, 1);
    expect(issues.every((i) => i.severity === 'WARNING')).toBe(true);
  });

  it('reads Setmore times as LOCAL Montréal time', () => {
    const res = validateAppointment(
      { date: '2026-09-01', time: '10:00', serviceName: 'Basic Cleaning 2 Cleaners 3 Hours' },
      1,
      new Date('2026-08-01T00:00:00Z'),
    );
    // Treating them as UTC would move every appointment four or five hours.
    expect(wall(res.startAt!)).toBe('10:00');
  });

  it('keeps the local hour across the DST boundary', () => {
    const summer = validateAppointment(
      { date: '2026-07-15', time: '09:00', serviceName: 'Carpet Cleaning' },
      1,
      new Date('2026-01-01T00:00:00Z'),
    );
    const winter = validateAppointment(
      { date: '2026-12-15', time: '09:00', serviceName: 'Carpet Cleaning' },
      2,
      new Date('2026-01-01T00:00:00Z'),
    );
    expect(wall(summer.startAt!)).toBe('09:00');
    expect(wall(winter.startAt!)).toBe('09:00');
  });

  it('flags a malformed date rather than importing a wrong one', () => {
    const res = validateAppointment({ date: '01/09/2026', time: '10:00' }, 1, new Date());
    expect(res.issues.some((i) => i.severity === 'ERROR' && i.field === 'date')).toBe(true);
    expect(res.startAt).toBeNull();
  });

  it('identifies past appointments', () => {
    const res = validateAppointment(
      { date: '2020-01-01', time: '10:00', serviceName: 'Carpet Cleaning' },
      1,
      new Date('2026-08-01T00:00:00Z'),
    );
    expect(res.isPast).toBe(true);
  });

  it('produces a stable external id for the same row', () => {
    const row = { id: 'abc' };
    expect(externalIdFor('customer', row, 'x')).toBe(externalIdFor('customer', row, 'y'));
    // Without an id, the fallback still has to be deterministic.
    expect(externalIdFor('customer', {}, 'same')).toBe(externalIdFor('customer', {}, 'same'));
    expect(externalIdFor('customer', {}, 'a')).not.toBe(externalIdFor('customer', {}, 'b'));
  });
});

d('Setmore import', () => {
  let prisma: PrismaClient;
  let importer: SetmoreImporter;
  const NOW = new Date('2026-08-01T12:00:00Z');

  beforeAll(async () => {
    assertDestructiveAllowed(process.env);
    prisma = new PrismaClient({ datasources: { db: { url: URL_ } } });
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.bookingStatusHistory.deleteMany();
    await prisma.bookingStaff.deleteMany();
    await prisma.booking.deleteMany();
    await prisma.quoteLine.deleteMany();
    await prisma.quote.deleteMany();
    await prisma.recurrenceSeries.deleteMany();
    await prisma.customerAddress.deleteMany();
    await prisma.customerPhone.deleteMany();
    await prisma.customer.deleteMany();
    await prisma.bookingNumberSequence.deleteMany();
    await seed(prisma);
    importer = new SetmoreImporter(prisma, () => NOW);
  });

  const CUSTOMERS = [
    {
      id: 'c1',
      firstName: 'Marie',
      lastName: 'Tremblay',
      phone: '514-555-1001',
      email: 'marie@example.com',
      address: '754 Av. 36e',
      city: 'Lachine',
      postalCode: 'H8T 1B7',
    },
    { id: 'c2', firstName: 'Jean', phone: '514-555-1002', address: '99 Rue Y', city: 'Laval', postalCode: 'H7N3S8' },
  ];

  const APPOINTMENTS = [
    {
      id: 'a1',
      customerId: 'c1',
      serviceName: 'Basic Cleaning - 2 Cleaners 3 Hours',
      date: '2026-09-05',
      time: '10:00',
      status: 'Confirmed',
      amount: '258.69',
    },
    {
      id: 'a2',
      customerId: 'c2',
      serviceName: 'Deep Cleaning - 1 Cleaner 3 Hours',
      date: '2026-09-08',
      time: '13:00',
      status: 'Confirmed',
      amount: '145.15',
    },
  ];

  /* ---------------- dry run ---------------- */

  it('DRY RUN BY DEFAULT: nothing is written', async () => {
    const report = await importer.run({ customers: CUSTOMERS, appointments: APPOINTMENTS });

    expect(report.dryRun).toBe(true);
    expect(report.customers.imported).toBe(2);
    expect(report.appointments.imported).toBe(2);
    // The whole point: an operator sees the outcome before committing.
    expect(await prisma.customer.count()).toBe(0);
    expect(await prisma.booking.count()).toBe(0);
  });

  it('reports every rejection with a reason', async () => {
    const report = await importer.run({
      customers: [{ id: 'x', firstName: 'Ghost' }],
      appointments: [{ id: 'y', customerId: 'x', serviceName: 'Consultation', date: 'bad', time: '10:00' }],
    });
    expect(report.customers.rejected).toBe(1);
    expect(report.appointments.rejected).toBe(1);
    expect(report.issues.some((i) => i.message.match(/could never sign in/))).toBe(true);
    expect(report.issues.some((i) => i.field === 'date')).toBe(true);
  });

  it('lists services it could not map, with counts, for a human to resolve', async () => {
    const report = await importer.run({
      customers: CUSTOMERS,
      appointments: [
        { customerId: 'c1', serviceName: 'Basic Cleaning', date: '2026-09-05', time: '10:00' },
        { customerId: 'c1', serviceName: 'Basic Cleaning', date: '2026-09-06', time: '10:00' },
        { customerId: 'c2', serviceName: 'Special Request', date: '2026-09-07', time: '10:00' },
      ],
    });
    expect(report.unmappedServices).toEqual([
      { name: 'Basic Cleaning', count: 2 },
      { name: 'Special Request', count: 1 },
    ]);
    expect(report.appointments.imported).toBe(0);
  });

  /* ---------------- real import ---------------- */

  it('imports customers with addresses and unverified phones', async () => {
    await importer.run({ customers: CUSTOMERS, appointments: [] }, { dryRun: false });

    expect(await prisma.customer.count()).toBe(2);
    const marie = await prisma.customer.findFirstOrThrow({
      where: { firstName: 'Marie' },
      include: { phones: true, addresses: true },
    });
    expect(marie.email).toBe('marie@example.com');
    expect(marie.phones[0]!.phoneE164).toBe('+15145551001');
    // Imported, not verified: the customer proves the number themselves.
    expect(marie.phones[0]!.verifiedAt).toBeNull();
    expect(marie.addresses[0]!.city).toBe('Lachine');
    expect(marie.addresses[0]!.postalCode).toBe('H8T1B7');
  });

  it('imports future appointments as real bookings', async () => {
    const report = await importer.run(
      { customers: CUSTOMERS, appointments: APPOINTMENTS },
      { dryRun: false },
    );
    expect(report.appointments.imported).toBe(2);

    const bookings = await prisma.booking.findMany({ orderBy: { startAt: 'asc' } });
    expect(bookings).toHaveLength(2);
    expect(bookings[0]!.bookingNumber).toMatch(/^R2N-\d{4}-\d{6}$/);
    expect(wall(bookings[0]!.startAt)).toBe('10:00');
    // The agreed price is preserved, not recalculated.
    expect(bookings[0]!.grandTotalCents).toBe(25869);
  });

  it('imports bookings UNASSIGNED so dispatch decides using real availability', async () => {
    await importer.run({ customers: CUSTOMERS, appointments: APPOINTMENTS }, { dryRun: false });
    const bookings = await prisma.booking.findMany({ include: { staff: true } });
    for (const b of bookings) expect(b.staff).toHaveLength(0);
  });

  it('does NOT create past appointments, but counts them', async () => {
    const report = await importer.run(
      {
        customers: CUSTOMERS,
        appointments: [
          { customerId: 'c1', serviceName: 'Carpet Cleaning', date: '2020-03-01', time: '10:00' },
          ...APPOINTMENTS,
        ],
      },
      { dryRun: false },
    );
    expect(report.appointments.past).toBe(1);
    // History is not work to dispatch; creating it would put phantom jobs on
    // the board.
    expect(await prisma.booking.count()).toBe(2);
  });

  it('skips cancelled and no-show appointments', async () => {
    const report = await importer.run(
      {
        customers: CUSTOMERS,
        appointments: [
          { customerId: 'c1', serviceName: 'Carpet Cleaning', date: '2026-09-05', time: '10:00', status: 'Cancelled' },
          { customerId: 'c2', serviceName: 'Carpet Cleaning', date: '2026-09-06', time: '10:00', status: 'No Show' },
        ],
      },
      { dryRun: false },
    );
    expect(report.appointments.rejected).toBe(2);
    expect(await prisma.booking.count()).toBe(0);
  });

  /* ---------------- idempotency ---------------- */

  it('IDEMPOTENT: re-running creates nothing extra', async () => {
    await importer.run({ customers: CUSTOMERS, appointments: APPOINTMENTS }, { dryRun: false });
    const second = await importer.run(
      { customers: CUSTOMERS, appointments: APPOINTMENTS },
      { dryRun: false },
    );

    expect(second.customers.duplicates).toBe(2);
    expect(second.appointments.duplicates).toBe(2);
    expect(second.appointments.imported).toBe(0);
    expect(await prisma.customer.count()).toBe(2);
    expect(await prisma.booking.count()).toBe(2);
  });

  it('matches a customer who already booked on the new platform', async () => {
    // They found the new site first and booked directly.
    const existing = await prisma.customer.create({
      data: { firstName: 'Marie', phones: { create: { phoneE164: '+15145551001', verifiedAt: new Date() } } },
    });

    const report = await importer.run({ customers: CUSTOMERS, appointments: [] }, { dryRun: false });
    expect(report.customers.duplicates).toBe(1);
    expect(await prisma.customer.count()).toBe(2); // not 3

    // Their verified phone is untouched.
    const phone = await prisma.customerPhone.findUniqueOrThrow({ where: { phoneE164: '+15145551001' } });
    expect(phone.customerId).toBe(existing.id);
    expect(phone.verifiedAt).not.toBeNull();
  });

  it('an appointment for an unknown customer is reported, not orphaned', async () => {
    const report = await importer.run(
      {
        customers: [],
        appointments: [{ customerId: 'nobody', serviceName: 'Carpet Cleaning', date: '2026-09-05', time: '10:00' }],
      },
      { dryRun: false },
    );
    expect(report.appointments.rejected).toBe(1);
    expect(report.issues.some((i) => i.field === 'customerId')).toBe(true);
    expect(await prisma.booking.count()).toBe(0);
  });

  it('a customer with no address cannot have a cleaning scheduled', async () => {
    const report = await importer.run(
      {
        customers: [{ id: 'c9', firstName: 'Nomad', phone: '514-555-1009' }],
        appointments: [{ customerId: 'c9', serviceName: 'Carpet Cleaning', date: '2026-09-05', time: '10:00' }],
      },
      { dryRun: false },
    );
    expect(report.appointments.rejected).toBe(1);
    expect(report.issues.some((i) => i.field === 'address')).toBe(true);
  });

  it('marks imported quotes so they are never mistaken for engine output', async () => {
    await importer.run({ customers: CUSTOMERS, appointments: APPOINTMENTS }, { dryRun: false });
    const quote = await prisma.quote.findFirstOrThrow();
    expect(quote.pricingVersion).toBe('setmore-import');
    expect((quote.priceSnapshot as { source?: string }).source).toBe('SETMORE_IMPORT');
  });

  it('records that each booking came from the migration', async () => {
    await importer.run({ customers: CUSTOMERS, appointments: APPOINTMENTS }, { dryRun: false });
    const history = await prisma.bookingStatusHistory.findMany();
    expect(history.every((h) => h.actor === 'SETMORE_IMPORT')).toBe(true);
  });

  it('a dry run after a real import reports duplicates, not new work', async () => {
    await importer.run({ customers: CUSTOMERS, appointments: APPOINTMENTS }, { dryRun: false });
    const dry = await importer.run({ customers: CUSTOMERS, appointments: APPOINTMENTS });
    expect(dry.customers.duplicates).toBe(2);
  });
});

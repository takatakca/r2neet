import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { SERVICES } from '../data/catalogue.js';
import { normalizePhone } from '../identity/identity.js';
import { localToUtc } from '../scheduling/availability.js';

/**
 * Setmore migration.
 *
 * This is the last thing standing between the platform and going live: real
 * customers with real appointments already on the books.
 *
 * Three rules, all of them learned from migrations that went badly:
 *
 * 1. **Dry run is the default.** An operator sees exactly what would happen,
 *    including every rejected row and why, before anything is written.
 * 2. **Import is idempotent.** A migration that cannot be safely re-run
 *    forces a decision under pressure when it half-fails. Every record
 *    carries a deterministic external id.
 * 3. **A row is never guessed.** A booking whose service cannot be mapped is
 *    reported for a human, not quietly assigned to something plausible.
 *    Wrong data is worse than missing data.
 */

export type ImportSeverity = 'ERROR' | 'WARNING';

export interface ImportIssue {
  row: number;
  field: string;
  severity: ImportSeverity;
  message: string;
  /** Never the raw value if it could be personal data. */
  hint?: string;
}

export interface SetmoreCustomerRow {
  id?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  address?: string;
  city?: string;
  postalCode?: string;
  notes?: string;
}

export interface SetmoreAppointmentRow {
  id?: string;
  customerId?: string;
  customerEmail?: string;
  customerPhone?: string;
  serviceName?: string;
  /** Local date, YYYY-MM-DD. */
  date?: string;
  /** Local time, HH:MM. */
  time?: string;
  durationMinutes?: number | string;
  staffName?: string;
  status?: string;
  amount?: string | number;
  notes?: string;
}

export interface ImportReport {
  dryRun: boolean;
  customers: {
    total: number;
    valid: number;
    imported: number;
    duplicates: number;
    rejected: number;
  };
  appointments: {
    total: number;
    valid: number;
    imported: number;
    duplicates: number;
    rejected: number;
    past: number;
    unmappedService: number;
  };
  issues: ImportIssue[];
  /** Services seen in the export that no R2NETTE service matches. */
  unmappedServices: { name: string; count: number }[];
}

/* ------------------------------------------------------------------ */
/* service mapping                                                     */
/* ------------------------------------------------------------------ */

/**
 * Map a Setmore service name onto a catalogue entry.
 *
 * Matching is conservative: crew size and duration must both agree, because
 * "Basic Cleaning" alone does not say whether two cleaners were booked for
 * three hours or one for four. Getting that wrong sends the wrong number of
 * people to someone's home.
 */
export function mapServiceName(raw: string): string | null {
  const name = raw.toLowerCase().trim();
  if (!name) return null;

  const cleaners = /(\d)\s*(?:cleaner|nettoyeur|personne)/.exec(name)?.[1];
  const hours = /(\d)\s*(?:hour|hr|heure)/.exec(name)?.[1];

  const family =
    /deep|grand|profond/.test(name) ? 'cat_deep'
    : /move|déménag|demenag/.test(name) ? 'move'
    : /carpet|tapis/.test(name) ? 'carpet'
    : /window|vitre|fenêtre|fenetre/.test(name) ? 'window'
    : /basic|regular|standard|base|ménage|menage/.test(name) ? 'cat_basic'
    : null;

  if (family === 'move') return 'svc_move';
  if (family === 'carpet') return 'svc_carpet';
  if (family === 'window') return 'svc_window';
  if (!family || !cleaners || !hours) return null;

  const match = SERVICES.find(
    (s) =>
      s.categoryId === family &&
      s.requiredStaffCount === Number(cleaners) &&
      s.appointmentDurationMinutes === Number(hours) * 60,
  );
  return match?.id ?? null;
}

/* ------------------------------------------------------------------ */
/* validation                                                          */
/* ------------------------------------------------------------------ */

const EMAIL = /^\S+@\S+\.\S{2,}$/;

/** Deterministic id so re-running never duplicates. */
export function externalIdFor(kind: 'customer' | 'appointment', row: { id?: string }, fallback: string): string {
  const basis = row.id?.trim() || createHash('sha256').update(fallback).digest('hex').slice(0, 16);
  return `setmore:${kind}:${basis}`;
}

export function validateCustomer(row: SetmoreCustomerRow, index: number): ImportIssue[] {
  const issues: ImportIssue[] = [];
  const hasPhone = Boolean(row.phone?.trim());
  const hasEmail = Boolean(row.email?.trim());

  // Identity in this system is a verified phone. Without one, a customer
  // could never sign in to see their own bookings.
  if (!hasPhone && !hasEmail) {
    issues.push({
      row: index,
      field: 'phone',
      severity: 'ERROR',
      message: 'No phone or email. This customer could never sign in.',
    });
  }
  if (hasPhone) {
    try {
      normalizePhone(row.phone!);
    } catch {
      issues.push({
        row: index,
        field: 'phone',
        severity: 'ERROR',
        message: 'Phone number is not a valid North American number.',
      });
    }
  }
  if (hasEmail && !EMAIL.test(row.email!.trim())) {
    issues.push({ row: index, field: 'email', severity: 'WARNING', message: 'Email looks malformed; importing without it.' });
  }
  if (!row.firstName?.trim() && !row.lastName?.trim()) {
    issues.push({ row: index, field: 'firstName', severity: 'WARNING', message: 'No name; will show as "Customer".' });
  }
  return issues;
}

export function validateAppointment(
  row: SetmoreAppointmentRow,
  index: number,
  now: Date,
): { issues: ImportIssue[]; startAt: Date | null; serviceOptionId: string | null; isPast: boolean } {
  const issues: ImportIssue[] = [];

  if (!row.date || !/^\d{4}-\d{2}-\d{2}$/.test(row.date)) {
    issues.push({ row: index, field: 'date', severity: 'ERROR', message: 'Missing or malformed date (expected YYYY-MM-DD).' });
    return { issues, startAt: null, serviceOptionId: null, isPast: false };
  }
  if (!row.time || !/^\d{1,2}:\d{2}$/.test(row.time)) {
    issues.push({ row: index, field: 'time', severity: 'ERROR', message: 'Missing or malformed time (expected HH:MM).' });
    return { issues, startAt: null, serviceOptionId: null, isPast: false };
  }

  const [y, m, d] = row.date.split('-').map(Number);
  const [hh, mm] = row.time.split(':').map(Number);
  // Setmore times are local Montréal wall-clock. Treating them as UTC would
  // move every appointment by four or five hours.
  const startAt = localToUtc(y!, m!, d!, hh! * 60 + mm!);
  const isPast = startAt < now;

  const serviceOptionId = row.serviceName ? mapServiceName(row.serviceName) : null;
  if (!serviceOptionId) {
    issues.push({
      row: index,
      field: 'serviceName',
      severity: 'ERROR',
      message: 'Service could not be matched to the R2NETTE catalogue.',
      hint: row.serviceName,
    });
  }

  const cancelled = /cancel|annul|no.?show/i.test(row.status ?? '');
  if (cancelled) {
    issues.push({ row: index, field: 'status', severity: 'WARNING', message: 'Cancelled or no-show; not imported.' });
  }

  return { issues, startAt, serviceOptionId, isPast };
}

/* ------------------------------------------------------------------ */
/* import                                                              */
/* ------------------------------------------------------------------ */

export class SetmoreImporter {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Import customers and their future appointments.
   *
   * Past appointments are counted but not created: they are history, not work
   * to be dispatched, and materialising them would put phantom jobs on the
   * board.
   */
  async run(
    input: { customers: SetmoreCustomerRow[]; appointments: SetmoreAppointmentRow[] },
    options: { dryRun?: boolean; importPast?: boolean } = {},
  ): Promise<ImportReport> {
    const dryRun = options.dryRun !== false;
    const at = this.now();

    const report: ImportReport = {
      dryRun,
      customers: { total: input.customers.length, valid: 0, imported: 0, duplicates: 0, rejected: 0 },
      appointments: {
        total: input.appointments.length,
        valid: 0,
        imported: 0,
        duplicates: 0,
        rejected: 0,
        past: 0,
        unmappedService: 0,
      },
      issues: [],
      unmappedServices: [],
    };

    /** Setmore customer id or contact -> R2NETTE customer id. */
    const customerIds = new Map<string, string>();
    const unmapped = new Map<string, number>();

    /* ---------------- customers ---------------- */

    for (const [i, row] of input.customers.entries()) {
      const issues = validateCustomer(row, i + 1);
      report.issues.push(...issues);
      if (issues.some((x) => x.severity === 'ERROR')) {
        report.customers.rejected++;
        continue;
      }
      report.customers.valid++;

      const phone = row.phone?.trim() ? normalizePhone(row.phone) : null;
      const email = row.email?.trim() && EMAIL.test(row.email.trim()) ? row.email.trim() : null;
      const externalId = externalIdFor('customer', row, `${phone ?? ''}|${email ?? ''}`);

      // Match an existing customer by verified phone before creating one, so
      // a customer who already booked on the new platform is not duplicated.
      const existing = phone
        ? await this.prisma.customerPhone.findUnique({ where: { phoneE164: phone } })
        : null;

      if (existing) {
        report.customers.duplicates++;
        customerIds.set(row.id ?? phone ?? email ?? String(i), existing.customerId);
        continue;
      }

      if (dryRun) {
        report.customers.imported++;
        customerIds.set(row.id ?? phone ?? email ?? String(i), `dry-${i}`);
        continue;
      }

      try {
        const created = await this.prisma.customer.create({
          data: {
            firstName: row.firstName?.trim() || null,
            lastName: row.lastName?.trim() || null,
            email,
            legacyExternalId: externalId,
            ...(phone
              ? {
                  phones: {
                    create: {
                      phoneE164: phone,
                      isPrimary: true,
                      // Imported, not verified. The customer proves the
                      // number themselves on first sign-in.
                      verifiedAt: null,
                    },
                  },
                }
              : {}),
            ...(row.address?.trim()
              ? {
                  addresses: {
                    create: {
                      label: 'Home',
                      formattedAddress: row.address.trim(),
                      city: row.city?.trim() || 'Montréal',
                      province: 'QC',
                      postalCode: (row.postalCode ?? '').replace(/\s/g, '').toUpperCase() || 'H0H0H0',
                      isDefault: true,
                    },
                  },
                }
              : {}),
          },
        });
        customerIds.set(row.id ?? phone ?? email ?? String(i), created.id);
        report.customers.imported++;
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          report.customers.duplicates++;
          continue;
        }
        throw e;
      }
    }

    /* ---------------- appointments ---------------- */

    for (const [i, row] of input.appointments.entries()) {
      const { issues, startAt, serviceOptionId, isPast } = validateAppointment(row, i + 1, at);
      report.issues.push(...issues);

      if (row.serviceName && !serviceOptionId) {
        unmapped.set(row.serviceName, (unmapped.get(row.serviceName) ?? 0) + 1);
        report.appointments.unmappedService++;
      }
      if (issues.some((x) => x.severity === 'ERROR')) {
        report.appointments.rejected++;
        continue;
      }
      if (/cancel|annul|no.?show/i.test(row.status ?? '')) {
        report.appointments.rejected++;
        continue;
      }

      report.appointments.valid++;

      if (isPast) {
        // Counted so the operator can reconcile totals, but never created.
        report.appointments.past++;
        if (!options.importPast) continue;
      }

      const key = row.customerId ?? (row.customerPhone ? normalizePhone(row.customerPhone) : row.customerEmail);
      const customerId = key ? customerIds.get(key) : undefined;
      if (!customerId) {
        report.issues.push({
          row: i + 1,
          field: 'customerId',
          severity: 'ERROR',
          message: 'Appointment does not match any imported customer.',
        });
        report.appointments.rejected++;
        report.appointments.valid--;
        continue;
      }

      const externalId = externalIdFor('appointment', row, `${key}|${row.date}|${row.time}`);

      if (dryRun) {
        report.appointments.imported++;
        continue;
      }

      const already = await this.prisma.booking.findFirst({ where: { legacyExternalId: externalId } });
      if (already) {
        report.appointments.duplicates++;
        continue;
      }

      const service = SERVICES.find((s) => s.id === serviceOptionId)!;
      const duration = Number(row.durationMinutes) || service.appointmentDurationMinutes || 180;
      const endAt = new Date(startAt!.getTime() + duration * 60000);

      const address = await this.prisma.customerAddress.findFirst({
        where: { customerId },
        orderBy: { isDefault: 'desc' },
      });
      if (!address) {
        report.issues.push({
          row: i + 1,
          field: 'address',
          severity: 'ERROR',
          message: 'Customer has no address; cannot schedule a cleaning.',
        });
        report.appointments.rejected++;
        report.appointments.valid--;
        continue;
      }

      // The imported amount is what Setmore recorded. It is preserved as the
      // agreed price rather than recalculated, because the customer already
      // agreed to that figure — re-pricing would change what they owe.
      const amountCents = Math.round(Number(String(row.amount ?? '0').replace(/[^0-9.]/g, '')) * 100);

      await this.prisma.$transaction(async (tx) => {
        const quote = await tx.quote.create({
          data: {
            customerId,
            serviceOptionId: serviceOptionId!,
            frequency: 'ONE_TIME',
            baseServiceCents: amountCents,
            subtotalCents: amountCents,
            gstCents: 0,
            qstCents: 0,
            taxTotalCents: 0,
            grandTotalCents: amountCents,
            gstRateMicroPercent: 5_000_000,
            qstRateMicroPercent: 9_975_000,
            pricingVersion: 'setmore-import',
            // Marked so it is never mistaken for a quote this engine produced.
            priceSnapshot: { source: 'SETMORE_IMPORT', originalAmount: row.amount ?? null } as never,
            expiresAt: startAt!,
          },
        });

        const year = at.getUTCFullYear();
        await tx.$executeRaw`
          INSERT INTO "BookingNumberSequence" ("year","lastValue","updatedAt")
          VALUES (${year}, 0, now()) ON CONFLICT ("year") DO NOTHING`;
        const rows = await tx.$queryRaw<{ lastValue: number }[]>`
          UPDATE "BookingNumberSequence" SET "lastValue" = "lastValue" + 1, "updatedAt" = now()
          WHERE "year" = ${year} RETURNING "lastValue"`;

        await tx.booking.create({
          data: {
            bookingNumber: `R2N-${year}-${String(rows[0]!.lastValue).padStart(6, '0')}`,
            customerId,
            serviceOptionId: serviceOptionId!,
            addressId: address.id,
            quoteId: quote.id,
            startAt: startAt!,
            endAt,
            // Imported unassigned on purpose: dispatch decides who goes,
            // using real availability rather than Setmore's roster.
            status: 'CONFIRMED',
            grandTotalCents: amountCents,
            priceSnapshot: { source: 'SETMORE_IMPORT' } as never,
            legacyExternalId: externalId,
            history: {
              create: [
                { status: 'CONFIRMED', actor: 'SETMORE_IMPORT', reason: 'Migrated from Setmore' },
              ],
            },
          },
        });
      });
      report.appointments.imported++;
    }

    report.unmappedServices = [...unmapped.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

    return report;
  }
}

/* ------------------------------------------------------------------ */
/* CSV                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Minimal RFC 4180 CSV parser.
 *
 * Setmore exports CSV, and addresses contain commas and quotes. A naive
 * `split(',')` corrupts exactly the rows that matter.
 */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  const stripped = text.replace(/^\uFEFF/, ''); // Excel byte-order mark

  for (let i = 0; i < stripped.length; i++) {
    const c = stripped[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (stripped[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && stripped[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((v) => v !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    if (row.some((v) => v !== '')) rows.push(row);
  }

  if (rows.length === 0) return [];
  const headers = rows[0]!.map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => (obj[h] = (r[i] ?? '').trim()));
    return obj;
  });
}

/** Common Setmore column names, so an operator does not have to rename them. */
export function mapCustomerColumns(row: Record<string, string>): SetmoreCustomerRow {
  const pick = (...names: string[]) => names.map((n) => row[n]).find((v) => v && v.trim()) ?? undefined;
  return {
    id: pick('Customer ID', 'customer_id', 'id'),
    firstName: pick('First Name', 'first_name', 'firstName'),
    lastName: pick('Last Name', 'last_name', 'lastName'),
    email: pick('Email', 'email', 'Email Address'),
    phone: pick('Phone', 'phone', 'Phone Number', 'Mobile'),
    address: pick('Address', 'address', 'Street'),
    city: pick('City', 'city'),
    postalCode: pick('Postal Code', 'postal_code', 'Zip'),
  };
}

export function mapAppointmentColumns(row: Record<string, string>): SetmoreAppointmentRow {
  const pick = (...names: string[]) => names.map((n) => row[n]).find((v) => v && v.trim()) ?? undefined;
  return {
    id: pick('Appointment ID', 'appointment_id', 'id'),
    customerId: pick('Customer ID', 'customer_id'),
    customerEmail: pick('Customer Email', 'Email'),
    customerPhone: pick('Customer Phone', 'Phone'),
    serviceName: pick('Service', 'service', 'Service Name'),
    date: pick('Date', 'date', 'Start Date'),
    time: pick('Time', 'time', 'Start Time'),
    durationMinutes: pick('Duration', 'duration'),
    staffName: pick('Staff', 'staff', 'Provider'),
    status: pick('Status', 'status'),
    amount: pick('Amount', 'amount', 'Price', 'Cost'),
  };
}

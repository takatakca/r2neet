import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { assertDestructiveAllowed } from '../src/db/safety.js';
import { importContactBatch } from '../src/migration/customer-contacts.js';

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;
d('persistent customer contact evidence', () => {
  let prisma: PrismaClient;
  const input = { sourceAccount: 'r2nette.ca@gmail.com', contacts: [{ email: 'crm.fixture@example.com', displayName: 'History name',
    sources: [{ messageId: '1a143b93349000b1', occurredAt: '2026-10-01T12:00:00Z' }] }] };
  beforeAll(async () => {
    assertDestructiveAllowed(process.env);
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await prisma.$connect();
  });
  beforeEach(async () => {
    await prisma.customerContactSource.deleteMany();
    await prisma.customerContact.deleteMany();
  });
  afterAll(async () => {
    await prisma.customerContactSource.deleteMany();
    await prisma.customerContact.deleteMany();
    await prisma.$disconnect();
  });

  it('is replay-safe, preserves owner qualification, and never creates or verifies a login', async () => {
    const customers = await prisma.customer.count();
    const phones = await prisma.customerPhone.count();
    const profiles = await prisma.takatakSyncEvent.count();
    const first = await importContactBatch(prisma, input);
    expect(first.sourcesAdded).toBe(1);
    const contact = await prisma.customerContact.findUniqueOrThrow({ where: { emailNormalized: 'crm.fixture@example.com' } });
    expect(contact.status).toBe('TO_REVIEW');
    await prisma.customerContact.update({ where: { id: contact.id }, data: { status: 'CUSTOMER', displayName: 'Owner corrected' } });
    const replay = await importContactBatch(prisma, { ...input, contacts: [{ ...input.contacts[0], email: 'CRM.FIXTURE@example.com' }] });
    expect(replay.sourcesAdded).toBe(0);
    expect(await prisma.customerContact.count()).toBe(1);
    const preserved = await prisma.customerContact.findUniqueOrThrow({ where: { id: contact.id } });
    expect(preserved.status).toBe('CUSTOMER'); expect(preserved.displayName).toBe('Owner corrected');
    expect(await prisma.customer.count()).toBe(customers);
    expect(await prisma.customerPhone.count()).toBe(phones);
    expect(await prisma.takatakSyncEvent.count()).toBe(profiles);
  });

  it('adds new source evidence, keeps UTC history bounds, and cascades only its own evidence', async () => {
    await importContactBatch(prisma, input);
    await importContactBatch(prisma, { ...input, contacts: [{ ...input.contacts[0], sources: [
      { messageId: '1a143b93349000b2', occurredAt: '2026-09-01T08:00:00-04:00' },
      { messageId: '1a143b93349000b3', occurredAt: '2026-10-10T12:00:00Z' },
    ] }] });
    const c = await prisma.customerContact.findUniqueOrThrow({ where: { emailNormalized: 'crm.fixture@example.com' } });
    expect(c.firstSeenAt.toISOString()).toBe('2026-09-01T12:00:00.000Z');
    expect(c.lastSeenAt.toISOString()).toBe('2026-10-10T12:00:00.000Z');
    expect(await prisma.customerContactSource.count()).toBe(3);
    await prisma.customerContact.delete({ where: { id: c.id } });
    expect(await prisma.customerContactSource.count()).toBe(0);
  });

  it('serializes concurrent imports of the same email without losing provenance bounds', async () => {
    await Promise.all([
      importContactBatch(prisma, input),
      importContactBatch(prisma, { ...input, contacts: [{ ...input.contacts[0], sources: [
        { messageId: '1a143b93349000b4', occurredAt: '2026-08-01T12:00:00Z' },
      ] }] }),
    ]);
    expect(await prisma.customerContact.count()).toBe(1);
    expect(await prisma.customerContactSource.count()).toBe(2);
    const c = await prisma.customerContact.findFirstOrThrow();
    expect(c.firstSeenAt.toISOString()).toBe('2026-08-01T12:00:00.000Z');
    expect(c.lastSeenAt.toISOString()).toBe('2026-10-01T12:00:00.000Z');
  });
});

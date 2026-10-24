import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';

export const CONTACT_STATUSES = ['TO_REVIEW', 'PROSPECT', 'CUSTOMER', 'OTHER'] as const;
export const sourceAccount = 'r2nette.ca@gmail.com';
const email = z.string().trim().max(320).email().transform((v) => v.toLowerCase());
const source = z.object({
  messageId: z.string().regex(/^[a-f0-9]{12,32}$/),
  occurredAt: z.string().datetime({ offset: true }),
}).strict();
export const contactImportSchema = z.object({
  sourceAccount: z.literal(sourceAccount),
  contacts: z.array(z.object({
    email,
    displayName: z.string().trim().max(200).refine((v) => !/[\u0000-\u001f]/.test(v)).nullable(),
    sources: z.array(source).min(1).max(250),
  }).strict()).min(1).max(20),
}).strict().refine((v) => v.contacts.reduce((n, c) => n + c.sources.length, 0) <= 500,
  'Too many source rows in one batch.');

export const contactUpdateSchema = z.object({
  status: z.enum(CONTACT_STATUSES),
  displayName: z.string().trim().min(1).max(200).refine((v) => !/[\u0000-\u001f]/.test(v)).nullable().optional(),
}).strict();

/** No identity/account writes, no marketing choice, no message bodies. */
export async function importContactBatch(prisma: PrismaClient, input: unknown) {
  const data = contactImportSchema.parse(input);
  let processed = 0;
  let sourcesAdded = 0;
  // One small transaction per validated batch; a failing source never leaves
  // a partially imported contact. Retries preserve curated names and status.
  await prisma.$transaction(async (tx) => {
    // Stable lock order prevents two overlapping batches from deadlocking.
    for (const row of [...data.contacts].sort((a, b) => a.email.localeCompare(b.email))) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`r2nette-crm:${row.email}`}, 0))`;
      const dates = row.sources.map((s) => new Date(s.occurredAt).getTime());
      const saved = await tx.customerContact.upsert({
        where: { emailNormalized: row.email },
        create: { emailNormalized: row.email, displayName: row.displayName || null,
          firstSeenAt: new Date(Math.min(...dates)), lastSeenAt: new Date(Math.max(...dates)) },
        update: {},
      });
      const added = await tx.customerContactSource.createMany({
        data: row.sources.map((s) => ({ contactId: saved.id, accountEmail: data.sourceAccount,
          messageId: s.messageId, occurredAt: new Date(s.occurredAt) })),
        skipDuplicates: true,
      });
      const bounds = await tx.customerContactSource.aggregate({
        where: { contactId: saved.id }, _min: { occurredAt: true }, _max: { occurredAt: true },
      });
      await tx.customerContact.update({ where: { id: saved.id }, data: {
        firstSeenAt: bounds._min.occurredAt!, lastSeenAt: bounds._max.occurredAt!,
      } });
      processed++;
      sourcesAdded += added.count;
    }
  });
  return { processed, sourcesAdded };
}

/** Project only reviewed fields from our private extraction file. */
export function inventoryBatches(raw: unknown): z.infer<typeof contactImportSchema>[] {
  const inventory = z.object({
    source_account: z.literal(sourceAccount),
    contacts: z.array(z.object({ email, display_name: z.string().max(200).optional() })).max(10000),
    sources: z.array(z.tuple([z.string(), z.string(), z.string(), z.string(), z.string()])).max(100000),
  }).passthrough().parse(raw);
  const rawContacts = z.object({ contacts: z.array(z.object({ email, contact_id: z.string() })) }).passthrough().parse(raw);
  const byContact = new Map<string, { messageId: string; occurredAt: string }[]>();
  for (const s of inventory.sources) {
    const rows = byContact.get(s[0]) || [];
    rows.push({ messageId: s[1], occurredAt: s[2] }); byContact.set(s[0], rows);
  }
  const contacts = inventory.contacts.map((c, i) => ({ email: c.email, displayName: c.display_name || null,
    sources: byContact.get(rawContacts.contacts[i]!.contact_id) || [] }));
  const batches: z.infer<typeof contactImportSchema>[] = [];
  let current: typeof contacts = [];
  let count = 0;
  for (const contact of contacts) {
    // A large history is split, not silently truncated; email upsert keeps
    // one contact and the unique source constraint makes retries harmless.
    for (let i = 0; i < contact.sources.length; i += 250) {
      const chunk = { ...contact, sources: contact.sources.slice(i, i + 250) };
      if (current.length === 20 || count + chunk.sources.length > 500) {
        batches.push(contactImportSchema.parse({ sourceAccount, contacts: current }));
        current = []; count = 0;
      }
      current.push(chunk); count += chunk.sources.length;
    }
    if (!contact.sources.length) throw new Error('Every imported contact needs a source.');
  }
  if (current.length) batches.push(contactImportSchema.parse({ sourceAccount, contacts: current }));
  return batches;
}

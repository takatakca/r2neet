import express, { type Request, type NextFunction, type Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { CONTACT_STATUSES, contactUpdateSchema, importContactBatch } from '../migration/customer-contacts.js';

const querySchema = z.object({
  q: z.string().trim().max(120).default(''),
  status: z.enum(CONTACT_STATUSES).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
}).strict();
const idSchema = z.string().uuid();

export function createCustomerContactsApi(prisma: PrismaClient, authorize: (req: Request) => unknown) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try { authorize(req); next(); } catch (error) { next(error); }
  });
  const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) =>
    (req: Request, res: Response, next: NextFunction) => void fn(req, res).catch(next);

  router.get('/', wrap(async (req, res) => {
    const { q, status, page } = querySchema.parse(req.query);
    const where = {
      ...(status ? { status } : {}),
      ...(q ? { OR: [
        { emailNormalized: { contains: q, mode: 'insensitive' as const } },
        { displayName: { contains: q, mode: 'insensitive' as const } },
      ] } : {}),
    };
    const [contacts, total] = await Promise.all([
      prisma.customerContact.findMany({ where, skip: (page - 1) * 50, take: 50,
        orderBy: { emailNormalized: 'asc' }, include: { _count: { select: { sources: true } } } }),
      prisma.customerContact.count({ where }),
    ]);
    res.json({ contacts: contacts.map((c) => ({ id: c.id, email: c.emailNormalized,
      displayName: c.displayName, status: c.status, firstSeenAt: c.firstSeenAt,
      lastSeenAt: c.lastSeenAt, sourceCount: c._count.sources })), total, page, pageSize: 50 });
  }));

  router.get('/accounts', wrap(async (req, res) => {
    const { q, page } = querySchema.parse(req.query);
    const where = q ? { OR: [
      { email: { contains: q, mode: 'insensitive' as const } },
      { firstName: { contains: q, mode: 'insensitive' as const } },
      { lastName: { contains: q, mode: 'insensitive' as const } },
    ] } : {};
    const [accounts, total] = await Promise.all([
      prisma.customer.findMany({ where, skip: (page - 1) * 50, take: 50, orderBy: { id: 'asc' },
        select: { id: true, firstName: true, lastName: true, email: true, registrationCompletedAt: true,
          _count: { select: { bookings: true } } } }),
      prisma.customer.count({ where }),
    ]);
    res.json({ accounts: accounts.map((c) => ({ id: c.id,
      displayName: [c.firstName, c.lastName].filter(Boolean).join(' '), email: c.email,
      registrationCompleted: c.registrationCompletedAt !== null, bookingCount: c._count.bookings })),
    total, page, pageSize: 50 });
  }));

  router.get('/:id', wrap(async (req, res) => {
    const id = idSchema.parse(req.params.id);
    const contact = await prisma.customerContact.findUnique({ where: { id },
      include: { sources: { orderBy: { occurredAt: 'desc' }, take: 100 },
        _count: { select: { sources: true } } } });
    if (!contact) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Contact not found.' } });
    res.json({ id: contact.id, displayName: contact.displayName, email: contact.emailNormalized,
      status: contact.status, sourceCount: contact._count.sources,
      sources: contact.sources.map((s) => ({ id: s.id, occurredAt: s.occurredAt,
        url: `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(s.accountEmail)}#all/${s.messageId}` })),
      hasMoreSources: contact._count.sources > contact.sources.length });
  }));

  router.use((req, res, next) => {
    if (!req.is('application/json') || req.get('sec-fetch-site') === 'cross-site') {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Use the account JSON form.' } });
    }
    next();
  });

  router.post('/import', wrap(async (req, res) => {
    res.json(await importContactBatch(prisma, req.body));
  }));

  router.patch('/:id', wrap(async (req, res) => {
    const id = idSchema.parse(req.params.id);
    const input = contactUpdateSchema.parse(req.body);
    const result = await prisma.customerContact.updateMany({ where: { id }, data: input });
    if (!result.count) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Contact not found.' } });
    res.json({ ok: true });
  }));

  router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (error instanceof z.ZodError) {
      // Do not echo rejected fields or values (they can contain private data).
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid contact request.' } });
    }
    next(error);
  });
  return router;
}

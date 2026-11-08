// Codex — assistant OpenAI · 2026-10-29
import { Router } from 'express';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { ApiError } from './app.js';

export const commercialSchema = z.object({
  company: z.string().trim().min(2).max(120), contactName: z.string().trim().min(2).max(120),
  phone: z.string().trim().max(40).optional(), sector: z.enum(['OFFICE', 'RETAIL', 'BAR', 'KITCHEN', 'OTHER']),
  cadence: z.enum(['ONE_TIME', 'DAILY', 'WEEKLY', 'MONTHLY', 'ANNUAL_CONTRACT']),
  preferredAt: z.string().datetime({ offset: true }).optional(),
  details: z.string().trim().min(10).max(2000), locale: z.enum(['fr', 'en']),
}).strict();

export function commercialRoutes(prisma: PrismaClient, now: () => Date) {
  const app = Router();
  app.post('/api/v1/commercial/enquiries', (req, res, next) => {
    void (async () => {
      res.setHeader('Cache-Control', 'no-store');
      if (!req.customerId) throw new ApiError(401, 'UNAUTHORIZED', 'Sign in by email before sending your request.');
      if (req.get('sec-fetch-site') === 'cross-site' || !req.is('application/json')) throw new ApiError(403, 'REQUEST_REJECTED', 'Use the form on this website.');
      const input = commercialSchema.parse(req.body);
      if (input.preferredAt && (new Date(input.preferredAt) <= now() || new Date(input.preferredAt).getTime() > now().getTime() + 366 * 86400000)) throw new ApiError(400, 'VALIDATION_ERROR', 'Choose a future time within the next year.');
      const customer = await prisma.customer.findUniqueOrThrow({ where: { id: req.customerId } });
      if (!customer.email) throw new ApiError(400, 'VALIDATION_ERROR', 'Add your email to your account first.');
      // Account-wide quota also bounds retries and spam; no SMS or paid dialling.
      const recent = await prisma.commercialEnquiry.count({ where: { customerId: customer.id, createdAt: { gt: new Date(now().getTime() - 3600000) } } });
      if (recent >= 3) throw new ApiError(429, 'REQUEST_LIMIT', 'Your request is already in the queue. Please wait before sending another.');
      const enquiry = await prisma.commercialEnquiry.create({ data: { ...input, preferredAt: input.preferredAt ? new Date(input.preferredAt) : null, customerId: customer.id, email: customer.email } });
      res.status(201).json({ reference: enquiry.id, status: 'NEW', appointmentConfirmed: false });
    })().catch(next);
  });
  return app;
}

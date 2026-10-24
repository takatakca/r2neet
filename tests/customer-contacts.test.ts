import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import type { PrismaClient } from '@prisma/client';
import { createOpsApi, STAFF_COOKIE } from '../src/api/ops.js';
import { StaffAuthService, can, type StaffRole } from '../src/auth/staff-auth.js';
import { contactImportSchema, inventoryBatches } from '../src/migration/customer-contacts.js';

const contactId = '10000000-0000-4000-8000-000000000001';
const occurredAt = '2026-10-01T12:00:00Z';
const batch = { sourceAccount: 'r2nette.ca@gmail.com', contacts: [{ email: 'CLIENT@example.com',
  displayName: 'Test Client', sources: [{ messageId: '1a143b93349000b1', occurredAt }] }] };

describe('customer contact input and historical identity boundary', () => {
  it('normalizes email but rejects consent, login and arbitrary source fields', () => {
    expect(contactImportSchema.parse(batch).contacts[0]!.email).toBe('client@example.com');
    for (const extra of [{ marketingConsent: true }, { customerId: contactId }, { verifiedPhone: '+15145550100' }, { notes: 'private' }]) {
      expect(() => contactImportSchema.parse({ ...batch, contacts: [{ ...batch.contacts[0], ...extra }] })).toThrow();
    }
    expect(() => contactImportSchema.parse({ ...batch, sourceAccount: 'someone@example.com' })).toThrow();
    expect(() => contactImportSchema.parse({ ...batch, contacts: [{ ...batch.contacts[0], sources: [{ messageId: 'javascript:alert(1)', occurredAt }] }] })).toThrow();
  });

  it('projects evidence only and splits large source histories without truncating', () => {
    const sources = Array.from({ length: 601 }, (_, i) => ['c1', (1000000000000 + i).toString(16).padStart(16, '0'), occurredAt, 'envoye', 'https://untrusted.invalid']);
    const batches = inventoryBatches({ source_account: 'r2nette.ca@gmail.com', contacts: [{ contact_id: 'c1', email: 'Test@example.com', display_name: 'Test', marketing_eligible: true }], sources });
    expect(batches).toHaveLength(2);
    expect(batches.flatMap((b) => b.contacts.flatMap((c) => c.sources))).toHaveLength(601);
    expect(JSON.stringify(batches)).not.toContain('untrusted.invalid');
    expect(JSON.stringify(batches)).not.toContain('marketing_eligible');
  });

  it('requires provenance and limits batch size', () => {
    expect(() => inventoryBatches({ source_account: 'r2nette.ca@gmail.com', contacts: [{ contact_id: 'none', email: 'test@example.com' }], sources: [] })).toThrow();
    expect(() => inventoryBatches({ source_account: 'other@example.com', contacts: [], sources: [] })).toThrow();
    expect(() => contactImportSchema.parse({ ...batch, contacts: Array(21).fill(batch.contacts[0]) })).toThrow();
  });

  it('grants CRM access only to the owner', () => {
    expect(can('OWNER', 'customers.manage')).toBe(true);
    expect(can('DISPATCHER', 'customers.manage')).toBe(false);
    expect(can('CLEANER', 'customers.manage')).toBe(false);
  });
});

describe('private customer contact HTTP routes', () => {
  let role: StaffRole = 'OWNER';
  const findMany = vi.fn();
  const count = vi.fn();
  const findUnique = vi.fn();
  const updateMany = vi.fn();
  const prisma = { customerContact: { findMany, count, findUnique, updateMany } } as unknown as PrismaClient;
  const app = express().use(createOpsApi({ prisma }));
  const base = '/api/v1/admin/customer-contacts';
  const owner = (r: request.Test) => r.set('Cookie', `${STAFF_COOKIE}=synthetic-token`);

  beforeEach(() => {
    vi.clearAllMocks(); role = 'OWNER';
    vi.spyOn(StaffAuthService.prototype, 'resolve').mockImplementation(async () => ({
      userId: 'staff', displayName: 'Owner', email: 'owner@example.com', role, staffId: null, mustChangePassword: false,
    }));
    findMany.mockResolvedValue([]); count.mockResolvedValue(0); updateMany.mockResolvedValue({ count: 1 });
  });
  afterEach(() => vi.restoreAllMocks());

  it('refuses anonymous and non-owner reads and mutations before database access', async () => {
    await request(app).get(base).expect(401);
    for (const candidate of ['DISPATCHER', 'CLEANER'] as const) {
      role = candidate;
      await owner(request(app).get(base)).expect(403);
      await owner(request(app).post(`${base}/import`)).send(batch).expect(403);
      await owner(request(app).patch(`${base}/${contactId}`)).send({ status: 'CUSTOMER' }).expect(403);
    }
    expect(findMany).not.toHaveBeenCalled(); expect(updateMany).not.toHaveBeenCalled();
  });

  it('bounds and filters search and marks private responses no-store', async () => {
    const res = await owner(request(app).get(`${base}?q=TEST&status=PROSPECT&page=2`)).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 50, skip: 50,
      where: { status: 'PROSPECT', OR: [
        { emailNormalized: { contains: 'TEST', mode: 'insensitive' } },
        { displayName: { contains: 'TEST', mode: 'insensitive' } },
      ] } }));
    await owner(request(app).get(`${base}?page=0`)).expect(400);
    await owner(request(app).get(`${base}?page=1001`)).expect(400);
    await owner(request(app).get(`${base}?status=anything`)).expect(400);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('reconstructs Gmail links, returns bounded sources and no raw messages', async () => {
    findUnique.mockResolvedValue({ id: contactId, displayName: 'Client', emailNormalized: 'client@example.com', status: 'TO_REVIEW',
      _count: { sources: 101 }, sources: [{ id: 'source', occurredAt, accountEmail: 'r2nette.ca@gmail.com', messageId: '1a143b93349000b1' }] });
    const r = await owner(request(app).get(`${base}/${contactId}`)).expect(200);
    expect(r.body.hasMoreSources).toBe(true);
    expect(r.body.sources[0].url).toBe('https://mail.google.com/mail/u/?authuser=r2nette.ca%40gmail.com#all/1a143b93349000b1');
    expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({ include: expect.objectContaining({ sources: { orderBy: { occurredAt: 'desc' }, take: 100 } }) }));
    findUnique.mockResolvedValue(null);
    await owner(request(app).get(`${base}/${contactId}`)).expect(404);
  });

  it('allows classification only, rejects unknown fields and cross-site mutation', async () => {
    await owner(request(app).patch(`${base}/${contactId}`)).send({ status: 'PROSPECT' }).expect(200);
    expect(updateMany).toHaveBeenCalledWith({ where: { id: contactId }, data: { status: 'PROSPECT' } });
    await owner(request(app).patch(`${base}/${contactId}`)).send({ status: 'CUSTOMER', marketingConsent: true }).expect(400);
    await owner(request(app).patch(`${base}/${contactId}`)).set('Sec-Fetch-Site', 'cross-site').send({ status: 'CUSTOMER' }).expect(400);
    await owner(request(app).patch(`${base}/${contactId}`)).type('form').send({ status: 'CUSTOMER' }).expect(400);
    expect(updateMany).toHaveBeenCalledTimes(1);
  });
});

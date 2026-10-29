// Codex — assistant OpenAI · 2026-10-29
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApi } from '../src/api/app.js';
import { FakeVerificationProvider } from '../src/identity/identity.js';
import { publicProfiles } from '../src/api/public-experience.js';
import { commercialSchema } from '../src/api/commercial.js';
import { calendarRange, gpsLinks } from '../web/src/lib/account-experience.js';

describe('public experience boundaries',()=>{
 it('does not publish fabricated handles or unsafe configured links',()=>{
  const profiles=publicProfiles(JSON.stringify({facebook:'javascript:alert(1)',youtube:'https://evil.example/youtube.com',pinterest:'https://www.pinterest.com/real/'}));
  expect(profiles.some(p=>p.platform==='facebook'||p.platform==='youtube')).toBe(false);expect(profiles.find(p=>p.platform==='pinterest')?.url).toBe('https://www.pinterest.com/real/');
 });
 it('rejects a commercial price/confirmed-slot/identity injected by the browser',()=>{
  expect(commercialSchema.safeParse({company:'Office',contactName:'Alex',sector:'OFFICE',cadence:'ANNUAL_CONTRACT',details:'Clean the offices weekly.',locale:'fr',price:1,customerId:'victim'}).success).toBe(false);
 });
 it('calendar spans actual month boundaries and Monday-based weeks',()=>{expect(calendarRange('2026-11-01','week')).toEqual({from:'2026-10-26',to:'2026-11-02'});expect(calendarRange('2026-12-31','month')).toEqual({from:'2026-11-30',to:'2027-01-11'});expect(calendarRange('2026-12-31','day')).toEqual({from:'2026-12-31',to:'2027-01-01'});});
 it('only sends the address to GPS on explicit link navigation and encodes it',()=>{const links=gpsLinks('123 Rue A & B, Montréal');expect(links.waze).toContain('123%20Rue%20A%20%26%20B');expect(new URL(links.google).searchParams.get('destination')).toBe('123 Rue A & B, Montréal');});
 it('refuses cross-site consent writes and records explicit separate categories',async()=>{
  const records:any[]=[];const prisma:any={privacyConsent:{create:async({data}:any)=>{records.push(data);return data;}}};
  const app=createApi({prisma,verification:new FakeVerificationProvider()});
  expect((await request(app).post('/api/v1/privacy/consent').set('sec-fetch-site','cross-site').send({version:'2026-10-29',analytics:true,marketing:true})).status).toBe(403);
  const r=await request(app).post('/api/v1/privacy/consent').send({version:'2026-10-29',analytics:false,marketing:false});expect(r.status).toBe(200);expect(records[0]).toMatchObject({analytics:false,marketing:false});expect(records[0].visitorHash).toHaveLength(64);expect(records[0]).not.toHaveProperty('email');expect(r.headers['cache-control']).toBe('no-store');
 });
 it('keeps commercial enquiries and calendar data behind the customer session',async()=>{const prisma:any={};const app=createApi({prisma,verification:new FakeVerificationProvider()});expect((await request(app).post('/api/v1/commercial/enquiries').send({})).status).toBe(401);expect((await request(app).get('/api/v1/account/calendar?from=2026-10-01&to=2026-11-01')).status).toBe(401);});
});

// Codex — assistant OpenAI · 2026-10-29
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createApi } from '../src/api/app.js';
import { FakeVerificationProvider } from '../src/identity/identity.js';
import { SupabaseEmailAuthProvider } from '../src/identity/email-auth.js';

const at=new Date('2026-10-29T08:00:00Z');
function setup() {
 let challenge: any=null, customer: any=null, paid=false, phone: any=null;
 const creates: any[]=[];
 const prisma:any={
  customerSession:{findUnique:async()=>({customerId:'customer-a',revokedAt:null,expiresAt:new Date('2027-01-01')}),update:async()=>({}),create:async({data}:any)=>{creates.push(data);return data;}},
  emailAuthChallenge:{create:async({data}:any)=>{challenge={id:'challenge',consumedAt:null,...data};return challenge;},findUnique:async()=>challenge,updateMany:async()=>{if(challenge.consumedAt)return{count:0};challenge.consumedAt=at;return{count:1};}},
  customer:{findFirst:async()=>customer,create:async({data}:any)=>{customer={id:'customer-a',...data};return customer;},findUniqueOrThrow:async()=>customer},
  customerPhone:{findFirst:async()=>null,findUnique:async()=>phone,upsert:vi.fn(async()=>({}))},
  payment:{findFirst:async()=>paid?{id:'paid'}:null},
  $executeRaw:async()=>1,
 };
 prisma.$transaction=async(fn:any)=>fn(prisma);
 const emailAuth={configured:true,send:vi.fn(async()=>{}),verify:vi.fn(async(email:string,_code:string)=>({subject:'verified-subject',email}))};
 const sms=new FakeVerificationProvider('123456');const start=vi.spyOn(sms,'start');
 const app=createApi({prisma,verification:sms,emailAuth,now:()=>at});
 return {app,prisma,emailAuth,start,creates,setPaid:()=>{paid=true;},setCustomer:(c:any)=>{customer=c;},setPhone:(p:any)=>{phone=p;}};
}
async function sent(app:ReturnType<typeof createApi>){const r=await request(app).post('/api/v1/auth/email/send').send({email:'Alex@example.ca'});expect(r.status).toBe(200);return (r.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;}
const proof={email:'alex@example.ca',code:'123456',locale:'fr',termsAccepted:true};
describe('email-first browser authentication and paid SMS',()=>{
 it('creates an email-proven session without phone proof, SMS or marketing consent',async()=>{const s=setup(),cookie=await sent(s.app);const r=await request(s.app).post('/api/v1/auth/email/verify').set('Cookie',cookie).send(proof);expect(r.status).toBe(200);expect(s.start).not.toHaveBeenCalled();expect(s.creates[0]).toMatchObject({phoneVerifiedAt:null,emailVerifiedAt:at});expect(s.creates[0].sessionTokenHash).toHaveLength(64);expect(s.creates[0]).not.toHaveProperty('token');expect(r.body).not.toHaveProperty('customer');});
 it('requires the browser challenge and prevents replay',async()=>{const s=setup();expect((await request(s.app).post('/api/v1/auth/email/verify').send(proof)).status).toBe(401);const cookie=await sent(s.app);expect((await request(s.app).post('/api/v1/auth/email/verify').set('Cookie',cookie).send(proof)).status).toBe(200);expect((await request(s.app).post('/api/v1/auth/email/verify').set('Cookie',cookie).send(proof)).status).toBe(401);});
 it('never links a historic email-only profile or a different provider subject',async()=>{const s=setup();s.setCustomer({id:'historic',email:proof.email,emailAuthSubject:null});const cookie=await sent(s.app);const r=await request(s.app).post('/api/v1/auth/email/verify').set('Cookie',cookie).send(proof);expect(r.status).toBe(409);expect(s.creates).toHaveLength(0);});
 it('rejects cross-site sends and strict-body identity injection before calling providers',async()=>{const s=setup();expect((await request(s.app).post('/api/v1/auth/email/send').set('sec-fetch-site','cross-site').send({email:proof.email})).status).toBe(403);expect((await request(s.app).post('/api/v1/auth/email/send').send({email:proof.email,customerId:'victim'})).status).toBe(400);expect(s.emailAuth.send).not.toHaveBeenCalled();});
 it('blocks repeated email sends before a second provider request',async()=>{const s=setup();await sent(s.app);expect((await request(s.app).post('/api/v1/auth/email/send').send({email:proof.email})).status).toBe(429);expect(s.emailAuth.send).toHaveBeenCalledTimes(1);});
 it('never sends paid SMS for a new number through the legacy public routes',async()=>{const s=setup();const r=await request(s.app).post('/api/v1/auth/phone/send').send({phone:'5148252825',intent:'signup'});expect(r.status).toBe(200);expect(s.start).not.toHaveBeenCalled();const denied=await request(s.app).post('/api/v1/auth/phone/verify').send({phone:'5148252825',intent:'signup',code:'123456'});expect(denied.status).toBe(401);});
 it('rejects SMS before successful payment even when a booking/payment is claimed in the body',async()=>{const s=setup();const r=await request(s.app).post('/api/v1/account/phone/send').set('Cookie','r2n_session=opaque').send({phone:'5148252825',paymentStatus:'SUCCEEDED'});expect(r.status).toBe(403);expect(s.start).not.toHaveBeenCalled();});
 it('starts SMS only after server payment evidence and never reassigns another account phone',async()=>{const s=setup();s.setPaid();expect((await request(s.app).post('/api/v1/account/phone/send').set('Cookie','r2n_session=opaque').send({phone:'5148252825'})).status).toBe(200);expect(s.start).toHaveBeenCalledTimes(1);s.setPhone({customerId:'other'});const r=await request(s.app).post('/api/v1/account/phone/verify').set('Cookie','r2n_session=opaque').send({phone:'5148252825',code:'123456'});expect(r.status).toBe(409);expect(s.prisma.customerPhone.upsert).not.toHaveBeenCalled();});
});
describe('Supabase email provider boundary',()=>{
 const env={TAKATAK_SUPABASE_URL:'https://auth.example.test',TAKATAK_SUPABASE_ANON_KEY:'public-test-key',R2NETTE_EMAIL_AUTH_ENABLED:'true'};
 it('requires an explicit verified email template/SMTP opt-in',()=>{expect(new SupabaseEmailAuthProvider({...env,R2NETTE_EMAIL_AUTH_ENABLED:'false'}).configured).toBe(false);});
 it('requires provider-confirmed email and exact requested address, ignoring editable metadata',async()=>{const fetcher=vi.fn(async(_url: string | URL | Request, _init?: RequestInit)=>new Response(JSON.stringify({user:{id:'subject',email:'attacker@example.ca',email_confirmed_at:at.toISOString(),user_metadata:{email:'alex@example.ca'}}}),{status:200}));const p=new SupabaseEmailAuthProvider(env,fetcher as typeof fetch);await expect(p.verify('alex@example.ca','123456')).rejects.toMatchObject({code:'EMAIL_CODE_INVALID'});});
 it('sends email OTP and validates provider response without returning provider tokens',async()=>{const fetcher=vi.fn(async(_url: string | URL | Request, _init?: RequestInit)=>new Response(JSON.stringify({access_token:'never-return',user:{id:'subject',email:'alex@example.ca',email_confirmed_at:at.toISOString()}}),{status:200}));const p=new SupabaseEmailAuthProvider(env,fetcher as typeof fetch);await p.send('alex@example.ca');const result=await p.verify('alex@example.ca','123456');expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toEqual({email:'alex@example.ca',create_user:true});expect(result).toEqual({subject:'subject',email:'alex@example.ca'});});
});

import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildPaymentEvent,
  buildProfileEvent,
  loadTakatakSyncConfig,
  mapTakatakPaymentStatus,
  signTakatakRequest,
  type PaymentSnapshot,
  type ProfileSnapshot,
} from '../src/integrations/takatak-sync.js';

const at = new Date('2026-10-13T20:00:00.000Z');

function profile(): ProfileSnapshot {
  return {
    id: 'customer-1',
    firstName: 'Marie',
    lastName: 'Tremblay',
    email: 'marie@example.test',
    preferredLocale: 'fr',
    registrationCompletedAt: new Date('2026-10-01T12:00:00.000Z'),
    termsAcceptedAt: new Date('2026-10-01T12:00:00.000Z'),
    privacyAcceptedAt: new Date('2026-10-01T12:00:00.000Z'),
    marketingConsent: false,
    marketingConsentUpdatedAt: new Date('2026-10-01T12:00:00.000Z'),
    createdAt: new Date('2026-10-01T11:59:00.000Z'),
    updatedAt: at,
    phones: [
      {
        phoneE164: '+15145551212',
        verifiedAt: new Date('2026-10-01T11:58:00.000Z'),
        isPrimary: true,
      },
    ],
    addresses: [
      {
        id: 'address-1',
        formattedAddress: '123 Rue Exemple, Montréal, QC H1H 1H1, Canada',
        streetNumber: '123',
        route: 'Rue Exemple',
        unit: '4',
        city: 'Montréal',
        province: 'QC',
        postalCode: 'H1H 1H1',
        country: 'CA',
      },
    ],
  };
}

describe('R2NETTE -> TAKATAK contract', () => {
  it('builds the narrow profile payload and only marks proven phone identity verified', () => {
    const event = buildProfileEvent(profile(), 'CUSTOMER_REGISTERED', at);

    expect(event.sourceApplication).toBe('R2NETTE');
    expect(event.externalUserId).toBe('customer-1');
    expect(event.verifiedFields).toEqual(['phone']);
    expect(event.collectedFields.locale).toBe('fr');
    expect(event.collectedFields.addresses).toEqual([
      expect.objectContaining({
        id: 'address-1',
        type: 'CLEANING_SERVICE',
        line1: '123 Rue Exemple',
        line2: '4',
        city: 'Montréal',
      }),
    ]);
    expect(event.consentRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'TERMS', status: 'GRANTED' }),
        expect.objectContaining({ type: 'PRIVACY', status: 'GRANTED' }),
        expect.objectContaining({ type: 'MARKETING', status: 'DENIED' }),
      ]),
    );

    const serialized = JSON.stringify(event);
    for (const forbidden of [
      'password',
      'otpCode',
      'sessionToken',
      'cardNumber',
      'cvc',
      'doorCode',
      'alarmCode',
      'entryInstructions',
      'privateBookingNotes',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('uses deterministic ids for the same profile snapshot', () => {
    const first = buildProfileEvent(profile(), 'PROFILE_UPDATED', at);
    const second = buildProfileEvent(profile(), 'PROFILE_UPDATED', at);
    expect(second.eventId).toBe(first.eventId);
  });

  it('maps R2NETTE payment state into the master contract and keeps money in cents', () => {
    const payment: PaymentSnapshot = {
      id: 'payment-1',
      customerId: 'customer-1',
      amountCents: 12345,
      refundedAmountCents: 2345,
      currency: 'cad',
      status: 'PARTIALLY_REFUNDED',
      stripeCustomerId: 'cus_provider_reference',
      paidAt: new Date('2026-10-13T19:00:00.000Z'),
      failedAt: null,
      updatedAt: at,
      booking: { bookingNumber: 'R2N-2026-000001' },
    };
    const event = buildPaymentEvent(payment, at);

    expect(event).not.toBeNull();
    expect(event!.payment).toEqual(
      expect.objectContaining({
        bookingNumber: 'R2N-2026-000001',
        status: 'PARTIALLY_REFUNDED',
        amount: 12345,
        refundedAmount: 2345,
        currency: 'CAD',
        stripeCustomerReference: 'cus_provider_reference',
      }),
    );
    expect(mapTakatakPaymentStatus('SUCCEEDED')).toBe('PAID');
    expect(mapTakatakPaymentStatus('FAILED')).toBe('FAILED');
    expect(mapTakatakPaymentStatus('PROCESSING')).toBe('PENDING');
  });

  it('does not create a payment event without an R2NETTE booking number', () => {
    const payment: PaymentSnapshot = {
      id: 'payment-setup',
      customerId: 'customer-1',
      amountCents: 0,
      refundedAmountCents: 0,
      currency: 'CAD',
      status: 'SUCCEEDED',
      stripeCustomerId: 'cus_provider_reference',
      paidAt: at,
      failedAt: null,
      updatedAt: at,
      booking: null,
    };
    expect(buildPaymentEvent(payment, at)).toBeNull();
  });

  it('signs the exact timestamp.eventId.rawBody bytes required by TAKATAK', () => {
    const secret = 'shared-test-secret';
    const timestamp = '1791921600';
    const eventId = 'r2nette:test:event';
    const body = '{"eventId":"r2nette:test:event","sourceApplication":"R2NETTE"}';
    const expected = createHmac('sha256', secret)
      .update(`${timestamp}.${eventId}.${body}`, 'utf8')
      .digest('hex');

    expect(signTakatakRequest(secret, timestamp, eventId, body)).toBe(expected);
  });

  it('stays disabled unless explicitly enabled and fully configured', () => {
    expect(loadTakatakSyncConfig({})).toEqual({
      enabled: false,
      configured: false,
      url: null,
      clientId: null,
      secret: null,
    });
    expect(
      loadTakatakSyncConfig({
        TAKATAK_R2NETTE_SYNC_ENABLED: 'true',
        TAKATAK_R2NETTE_SYNC_URL: 'https://takatak.ca/api/integrations/r2nette/events',
        TAKATAK_R2NETTE_SYNC_CLIENT_ID: 'r2nette-prod',
        TAKATAK_R2NETTE_SYNC_WEBHOOK_SECRET: 'secret',
      }).configured,
    ).toBe(true);
  });
});

import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';

/**
 * Customer notifications.
 *
 * The rule: **anything that moves money or changes a commitment must be told
 * to the customer.** A silent charge is worse than a declined one.
 *
 * Deduplication is a database unique constraint on `dedupeKey`, not an
 * in-memory guard, so a worker retry or a second instance cannot send the
 * same message twice.
 */

export type Channel = 'EMAIL' | 'SMS';

export type Template =
  | 'BOOKING_CONFIRMED'
  | 'BOOKING_REMINDER'
  | 'BOOKING_CANCELLED'
  | 'BOOKING_RESCHEDULED'
  | 'RECURRING_VISIT_SCHEDULED'
  | 'PAYMENT_SUCCEEDED'
  | 'PAYMENT_FAILED'
  | 'PAYMENT_ACTION_REQUIRED'
  | 'CARD_EXPIRING';

export interface RenderedMessage {
  subject?: string;
  body: string;
}

export interface NotificationProvider {
  readonly name: string;
  readonly channel: Channel;
  readonly configured: boolean;
  send(to: string, message: RenderedMessage): Promise<{ providerId: string }>;
}

/* ------------------------------------------------------------------ */
/* copy                                                                */
/* ------------------------------------------------------------------ */

export interface TemplateVars {
  firstName?: string | null;
  bookingNumber?: string;
  when?: string;
  address?: string;
  amount?: string;
  reason?: string;
  manageUrl?: string;
}

/**
 * Message copy, in both languages.
 *
 * Plain, specific, and never alarming: a failed payment is a thing to fix,
 * not an accusation. Every message says what happens next.
 */
const COPY: Record<Template, Record<'en' | 'fr', (v: TemplateVars) => RenderedMessage>> = {
  BOOKING_CONFIRMED: {
    en: (v) => ({
      subject: `Your cleaning is booked — ${v.bookingNumber}`,
      body: `Hi ${v.firstName ?? 'there'}, your cleaning is confirmed for ${v.when} at ${v.address}. Booking ${v.bookingNumber}. You can change or cancel free up to 24 hours before.`,
    }),
    fr: (v) => ({
      subject: `Votre ménage est réservé — ${v.bookingNumber}`,
      body: `Bonjour ${v.firstName ?? ''}, votre ménage est confirmé le ${v.when} au ${v.address}. Réservation ${v.bookingNumber}. Modification ou annulation gratuite jusqu'à 24 heures avant.`,
    }),
  },
  BOOKING_REMINDER: {
    en: (v) => ({
      subject: 'Your cleaning is tomorrow',
      body: `Hi ${v.firstName ?? 'there'}, a quick reminder that your cleaning is ${v.when} at ${v.address}. Reply or call (514) 825-2825 if anything has changed.`,
    }),
    fr: (v) => ({
      subject: 'Votre ménage est demain',
      body: `Bonjour ${v.firstName ?? ''}, petit rappel : votre ménage est ${v.when} au ${v.address}. Appelez le (514) 825-2825 si quelque chose a changé.`,
    }),
  },
  BOOKING_CANCELLED: {
    en: (v) => ({
      subject: `Cleaning cancelled — ${v.bookingNumber}`,
      body: `Your cleaning on ${v.when} has been cancelled. Nothing has been charged. Book again any time at r2nette.ca.`,
    }),
    fr: (v) => ({
      subject: `Ménage annulé — ${v.bookingNumber}`,
      body: `Votre ménage du ${v.when} a été annulé. Aucun montant n'a été facturé. Réservez à nouveau quand vous voulez sur r2nette.ca.`,
    }),
  },
  BOOKING_RESCHEDULED: {
    en: (v) => ({
      subject: 'Your cleaning has moved',
      body: `Your cleaning is now ${v.when} at ${v.address}. Booking ${v.bookingNumber}.`,
    }),
    fr: (v) => ({
      subject: 'Votre ménage a été déplacé',
      body: `Votre ménage est maintenant le ${v.when} au ${v.address}. Réservation ${v.bookingNumber}.`,
    }),
  },
  RECURRING_VISIT_SCHEDULED: {
    en: (v) => ({
      subject: 'Your next cleaning is scheduled',
      body: `Hi ${v.firstName ?? 'there'}, your next cleaning is ${v.when} at ${v.address}. It is part of your recurring plan — you can skip or pause any time at ${v.manageUrl ?? 'r2nette.ca/account'}.`,
    }),
    fr: (v) => ({
      subject: 'Votre prochain ménage est planifié',
      body: `Bonjour ${v.firstName ?? ''}, votre prochain ménage est ${v.when} au ${v.address}. Il fait partie de votre forfait — vous pouvez sauter ou mettre en pause à tout moment sur ${v.manageUrl ?? 'r2nette.ca/account'}.`,
    }),
  },
  PAYMENT_SUCCEEDED: {
    en: (v) => ({
      subject: `Payment received — ${v.amount}`,
      body: `We received ${v.amount} for your cleaning on ${v.when}. Booking ${v.bookingNumber}. Thank you.`,
    }),
    fr: (v) => ({
      subject: `Paiement reçu — ${v.amount}`,
      body: `Nous avons reçu ${v.amount} pour votre ménage du ${v.when}. Réservation ${v.bookingNumber}. Merci.`,
    }),
  },
  PAYMENT_FAILED: {
    en: (v) => ({
      subject: 'We could not process your payment',
      body: `We could not charge ${v.amount} for your cleaning on ${v.when}. Your cleaning is still booked. Please update your card at ${v.manageUrl ?? 'r2nette.ca/account'} or call (514) 825-2825.`,
    }),
    fr: (v) => ({
      subject: "Nous n'avons pas pu traiter votre paiement",
      body: `Nous n'avons pas pu facturer ${v.amount} pour votre ménage du ${v.when}. Votre ménage est toujours réservé. Mettez votre carte à jour sur ${v.manageUrl ?? 'r2nette.ca/account'} ou appelez le (514) 825-2825.`,
    }),
  },
  PAYMENT_ACTION_REQUIRED: {
    en: (v) => ({
      subject: 'Your bank needs to verify this payment',
      body: `Your bank asked us to verify ${v.amount} for your cleaning on ${v.when}. Please confirm it at ${v.manageUrl ?? 'r2nette.ca/account'}. Your cleaning is still booked.`,
    }),
    fr: (v) => ({
      subject: 'Votre banque doit vérifier ce paiement',
      body: `Votre banque demande de vérifier ${v.amount} pour votre ménage du ${v.when}. Confirmez sur ${v.manageUrl ?? 'r2nette.ca/account'}. Votre ménage est toujours réservé.`,
    }),
  },
  CARD_EXPIRING: {
    en: () => ({
      subject: 'Your saved card expires soon',
      body: `The card saved for your R2NETTE cleanings expires soon. Update it at r2nette.ca/account so your next visit is not interrupted.`,
    }),
    fr: () => ({
      subject: 'Votre carte enregistrée expire bientôt',
      body: `La carte enregistrée pour vos ménages R2NETTE expire bientôt. Mettez-la à jour sur r2nette.ca/account pour éviter toute interruption.`,
    }),
  },
};

export function render(template: Template, locale: 'en' | 'fr', vars: TemplateVars): RenderedMessage {
  return (COPY[template][locale] ?? COPY[template].en)(vars);
}

/* ------------------------------------------------------------------ */
/* providers                                                           */
/* ------------------------------------------------------------------ */

export class TwilioSmsProvider implements NotificationProvider {
  readonly name = 'twilio_sms';
  readonly channel: Channel = 'SMS';
  private readonly sid?: string;
  private readonly token?: string;
  private readonly from?: string;

  constructor(env: Record<string, string | undefined> = process.env) {
    this.sid = env.TWILIO_ACCOUNT_SID;
    this.token = env.TWILIO_AUTH_TOKEN;
    this.from = env.TWILIO_SMS_NUMBER ?? env.TWILIO_VOICE_NUMBER;
  }

  get configured(): boolean {
    return Boolean(this.sid && this.token && this.from);
  }

  async send(to: string, message: RenderedMessage) {
    if (!this.configured) throw new Error('INTEGRATION_NOT_CONFIGURED');
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${this.sid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + Buffer.from(`${this.sid}:${this.token}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: to, From: this.from!, Body: message.body }),
      },
    );
    if (!res.ok) throw new Error('SMS_SEND_FAILED');
    const json = (await res.json()) as { sid: string };
    return { providerId: json.sid };
  }
}

/** Generic transactional email over an HTTP API. */
export class HttpEmailProvider implements NotificationProvider {
  readonly name = 'email_http';
  readonly channel: Channel = 'EMAIL';
  private readonly key?: string;
  private readonly endpoint?: string;
  private readonly from?: string;

  constructor(env: Record<string, string | undefined> = process.env) {
    this.key = env.EMAIL_API_KEY;
    this.endpoint = env.EMAIL_API_URL;
    this.from = env.EMAIL_FROM;
  }

  get configured(): boolean {
    return Boolean(this.key && this.endpoint && this.from);
  }

  async send(to: string, message: RenderedMessage) {
    if (!this.configured) throw new Error('INTEGRATION_NOT_CONFIGURED');
    const res = await fetch(this.endpoint!, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: this.from,
        to,
        subject: message.subject ?? 'R2NETTE',
        text: message.body,
      }),
    });
    if (!res.ok) throw new Error('EMAIL_SEND_FAILED');
    return { providerId: `email_${Date.now()}` };
  }
}

export class FakeNotificationProvider implements NotificationProvider {
  readonly configured = true;
  sent: { to: string; message: RenderedMessage }[] = [];
  failNext = false;

  constructor(
    readonly channel: Channel = 'EMAIL',
    readonly name = 'fake',
  ) {}

  async send(to: string, message: RenderedMessage) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('PROVIDER_DOWN');
    }
    this.sent.push({ to, message });
    return { providerId: `fake_${this.sent.length}` };
  }
}

/* ------------------------------------------------------------------ */
/* service                                                             */
/* ------------------------------------------------------------------ */

const hash = (v: string) => createHash('sha256').update(v).digest('hex');

/** After this many failures we stop trying and leave it for a person. */
export const MAX_SEND_ATTEMPTS = 3;

export class NotificationService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly providers: Partial<Record<Channel, NotificationProvider>> = {},
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Send once, ever, for a given (booking, template).
   *
   * The row is written BEFORE the provider call, so a crash mid-send leaves
   * evidence rather than silence. A duplicate key means someone already sent
   * it and we stop.
   */
  async notify(input: {
    template: Template;
    channel: Channel;
    recipient: string;
    customerId?: string | null;
    bookingId?: string | null;
    locale?: 'en' | 'fr';
    vars?: TemplateVars;
    /** Overrides the default one-per-booking-per-template key. */
    dedupeKey?: string;
  }): Promise<{ sent: boolean; reason?: string }> {
    const locale = input.locale ?? 'en';
    const dedupeKey =
      input.dedupeKey ?? `${input.template}:${input.bookingId ?? input.customerId ?? input.recipient}`;
    const message = render(input.template, locale, input.vars ?? {});

    let row;
    try {
      row = await this.prisma.notification.create({
        data: {
          customerId: input.customerId ?? null,
          bookingId: input.bookingId ?? null,
          channel: input.channel,
          template: input.template,
          status: 'QUEUED',
          // Proof of delivery, not a second copy of their contact details.
          recipientHash: hash(input.recipient),
          // Which field to re-read on retry. The address is never stored.
          recipientField: input.channel === 'EMAIL' ? 'email' : 'phone',
          renderVars: (input.vars ?? {}) as never,
          locale,
          subject: message.subject ?? null,
          dedupeKey,
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        return { sent: false, reason: 'ALREADY_SENT' };
      }
      throw e;
    }

    const provider = this.providers[input.channel];
    if (!provider?.configured) {
      // Recorded as suppressed, never reported as sent.
      await this.prisma.notification.update({
        where: { id: row.id },
        data: { status: 'SUPPRESSED', failureCode: 'INTEGRATION_NOT_CONFIGURED' },
      });
      return { sent: false, reason: 'NOT_CONFIGURED' };
    }

    try {
      const res = await provider.send(input.recipient, message);
      await this.prisma.notification.update({
        where: { id: row.id },
        data: {
          status: 'SENT',
          providerId: res.providerId,
          sentAt: this.now(),
          attempts: { increment: 1 },
        },
      });
      return { sent: true };
    } catch (e) {
      await this.prisma.notification.update({
        where: { id: row.id },
        data: {
          status: 'FAILED',
          failureCode: (e as Error).message,
          attempts: { increment: 1 },
        },
      });
      return { sent: false, reason: 'SEND_FAILED' };
    }
  }

  /**
   * Retry sends that failed for transient reasons.
   *
   * The recipient is re-derived from the customer record rather than stored,
   * so a retry cannot resurrect an address the customer has since changed or
   * asked us to delete. If they updated it, the retry goes to the new one —
   * which is what they would want.
   */
  async retryFailed(limit = 25): Promise<{ resent: number; abandoned: number }> {
    const rows = await this.prisma.notification.findMany({
      where: { status: 'FAILED', attempts: { lt: MAX_SEND_ATTEMPTS } },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });

    let resent = 0;
    let abandoned = 0;

    for (const r of rows) {
      const provider = this.providers[r.channel as Channel];
      if (!provider?.configured) continue;

      const recipient = await this.recipientFor(r.customerId, r.channel as Channel);
      if (!recipient) {
        // No way to reach them any more. Stop rather than retry forever.
        await this.prisma.notification.update({
          where: { id: r.id },
          data: { status: 'SUPPRESSED', failureCode: 'NO_RECIPIENT' },
        });
        abandoned++;
        continue;
      }

      // If they changed their address, the hash will differ. That is fine —
      // we send to where they are now, and record the new hash.
      const message = render(
        r.template as Template,
        (r.locale as 'en' | 'fr') ?? 'en',
        (r.renderVars as TemplateVars) ?? {},
      );

      try {
        const res = await provider.send(recipient, message);
        await this.prisma.notification.update({
          where: { id: r.id },
          data: {
            status: 'SENT',
            providerId: res.providerId,
            sentAt: this.now(),
            recipientHash: hash(recipient),
            attempts: { increment: 1 },
          },
        });
        resent++;
      } catch (e) {
        const attempts = r.attempts + 1;
        await this.prisma.notification.update({
          where: { id: r.id },
          data: {
            status: attempts >= MAX_SEND_ATTEMPTS ? 'SUPPRESSED' : 'FAILED',
            failureCode: (e as Error).message,
            attempts,
          },
        });
        if (attempts >= MAX_SEND_ATTEMPTS) abandoned++;
      }
    }
    return { resent, abandoned };
  }

  /** Current contact details, read fresh from the customer record. */
  private async recipientFor(customerId: string | null, channel: Channel): Promise<string | null> {
    if (!customerId) return null;
    const c = await this.prisma.customer.findUnique({
      where: { id: customerId },
      include: { phones: true },
    });
    if (!c) return null;
    return channel === 'EMAIL' ? c.email : (c.phones[0]?.phoneE164 ?? null);
  }
}

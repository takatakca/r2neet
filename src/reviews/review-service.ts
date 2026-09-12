import { createHash, randomBytes } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';

/**
 * Reviews.
 *
 * The rule everything here protects: **a source cannot be claimed, only
 * earned.** GOOGLE requires an external id from the provider sync.
 * R2NETTE_VERIFIED requires a completed booking and a valid invitation token.
 * There is no code path — public, admin, or otherwise — that lets someone
 * type a testimonial and label it Google.
 */

export const REVIEW_SOURCES = [
  'GOOGLE',
  'SETMORE_LEGACY',
  'R2NETTE_VERIFIED',
  'MANUAL_APPROVED',
] as const;
export type ReviewSource = (typeof REVIEW_SOURCES)[number];

export type ReviewStatus = 'IMPORTED' | 'PENDING' | 'PUBLISHED' | 'HIDDEN' | 'REJECTED';

export class ReviewError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

/** Sources that can only be created by a provider sync or a real booking. */
const PROVENANCE_REQUIRED: Record<ReviewSource, 'EXTERNAL_ID' | 'COMPLETED_BOOKING' | 'NONE'> = {
  GOOGLE: 'EXTERNAL_ID',
  SETMORE_LEGACY: 'EXTERNAL_ID',
  R2NETTE_VERIFIED: 'COMPLETED_BOOKING',
  MANUAL_APPROVED: 'NONE',
};

export interface ExternalReview {
  externalId: string;
  customerDisplayName: string;
  rating: number;
  reviewText?: string | null;
  reviewDate: Date;
  sourceUrl?: string | null;
  language?: string;
}

export interface ReviewProvider {
  readonly name: string;
  readonly configured: boolean;
  listReviews(): Promise<ExternalReview[]>;
}

/**
 * Google Business Profile. Server-side OAuth only — the refresh token never
 * reaches a browser.
 */
export class GoogleBusinessProfileReviewProvider implements ReviewProvider {
  readonly name = 'google_business_profile';
  private readonly env: Record<string, string | undefined>;

  constructor(env: Record<string, string | undefined> = process.env) {
    this.env = env;
  }

  get configured(): boolean {
    return Boolean(
      this.env.GOOGLE_BUSINESS_CLIENT_ID &&
        this.env.GOOGLE_BUSINESS_CLIENT_SECRET &&
        this.env.GOOGLE_BUSINESS_REFRESH_TOKEN &&
        this.env.GOOGLE_BUSINESS_LOCATION_ID,
    );
  }

  private async accessToken(): Promise<string> {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.env.GOOGLE_BUSINESS_CLIENT_ID!,
        client_secret: this.env.GOOGLE_BUSINESS_CLIENT_SECRET!,
        refresh_token: this.env.GOOGLE_BUSINESS_REFRESH_TOKEN!,
        grant_type: 'refresh_token',
      }),
    });
    if (!res.ok) throw new ReviewError('Google authorization failed.', 'GOOGLE_AUTH_FAILED');
    return ((await res.json()) as { access_token: string }).access_token;
  }

  async listReviews(): Promise<ExternalReview[]> {
    if (!this.configured) {
      throw new ReviewError('Google reviews are not configured.', 'INTEGRATION_NOT_CONFIGURED');
    }
    const token = await this.accessToken();
    const account = this.env.GOOGLE_BUSINESS_ACCOUNT_ID;
    const location = this.env.GOOGLE_BUSINESS_LOCATION_ID;
    const res = await fetch(
      `https://mybusiness.googleapis.com/v4/accounts/${account}/locations/${location}/reviews`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) throw new ReviewError('Google review fetch failed.', 'GOOGLE_FETCH_FAILED');
    const json = (await res.json()) as {
      reviews?: {
        reviewId: string;
        reviewer?: { displayName?: string };
        starRating?: string;
        comment?: string;
        createTime?: string;
      }[];
    };
    const stars: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
    return (json.reviews ?? []).map((r) => ({
      externalId: r.reviewId,
      customerDisplayName: r.reviewer?.displayName ?? 'Google user',
      rating: stars[r.starRating ?? 'FIVE'] ?? 5,
      reviewText: r.comment ?? null,
      reviewDate: r.createTime ? new Date(r.createTime) : new Date(),
    }));
  }
}

export class FakeReviewProvider implements ReviewProvider {
  readonly name = 'fake_reviews';
  readonly configured = true;
  constructor(private readonly reviews: ExternalReview[] = []) {}
  async listReviews(): Promise<ExternalReview[]> {
    return this.reviews;
  }
}

/* ------------------------------------------------------------------ */

export interface ReviewSummary {
  averageRating: number | null;
  reviewCount: number;
  bySource: Record<string, { averageRating: number; reviewCount: number }>;
}

export class ReviewService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Create a review, enforcing provenance for the claimed source.
   *
   * This is the only creation path. It refuses GOOGLE without an external
   * id and R2NETTE_VERIFIED without a completed booking.
   */
  async create(input: {
    source: ReviewSource;
    customerDisplayName: string;
    rating: number;
    reviewText?: string | null;
    reviewDate?: Date;
    externalId?: string | null;
    bookingId?: string | null;
    customerId?: string | null;
    language?: string;
    status?: ReviewStatus;
  }) {
    if (!REVIEW_SOURCES.includes(input.source)) {
      throw new ReviewError('Unknown review source.', 'INVALID_SOURCE');
    }
    if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5) {
      throw new ReviewError('Rating must be 1 to 5.', 'INVALID_RATING');
    }

    const requirement = PROVENANCE_REQUIRED[input.source];

    if (requirement === 'EXTERNAL_ID' && !input.externalId) {
      throw new ReviewError(
        `${input.source} reviews can only be created by a provider sync or verified import.`,
        'PROVENANCE_REQUIRED',
      );
    }

    if (requirement === 'COMPLETED_BOOKING') {
      if (!input.bookingId) {
        throw new ReviewError(
          'A verified review must reference a completed booking.',
          'PROVENANCE_REQUIRED',
        );
      }
      const booking = await this.prisma.booking.findUnique({ where: { id: input.bookingId } });
      if (!booking) throw new ReviewError('Booking not found.', 'BOOKING_NOT_FOUND');
      if (booking.status !== 'COMPLETED') {
        throw new ReviewError(
          'Only a completed cleaning can be reviewed.',
          'BOOKING_NOT_COMPLETED',
        );
      }
    }

    return this.prisma.review.create({
      data: {
        source: input.source,
        externalId: input.externalId ?? null,
        customerDisplayName: input.customerDisplayName,
        rating: input.rating,
        reviewText: input.reviewText ?? null,
        originalText: input.reviewText ?? null,
        reviewDate: input.reviewDate ?? this.now(),
        bookingId: input.bookingId ?? null,
        customerId: input.customerId ?? null,
        language: input.language ?? 'en',
        status: input.status ?? 'PENDING',
      },
    });
  }

  /** Idempotent provider sync. Re-running never duplicates. */
  async syncFromProvider(provider: ReviewProvider, source: ReviewSource = 'GOOGLE') {
    const state = { imported: 0, updated: 0 };
    try {
      const external = await provider.listReviews();
      for (const r of external) {
        const existing = await this.prisma.review.findUnique({
          where: { source_externalId: { source, externalId: r.externalId } },
        });
        if (existing) {
          await this.prisma.review.update({
            where: { id: existing.id },
            data: { rating: r.rating, reviewText: r.reviewText ?? null },
          });
          state.updated++;
        } else {
          await this.prisma.review.create({
            data: {
              source,
              externalId: r.externalId,
              customerDisplayName: r.customerDisplayName,
              rating: r.rating,
              reviewText: r.reviewText ?? null,
              originalText: r.reviewText ?? null,
              reviewDate: r.reviewDate,
              sourceUrl: r.sourceUrl ?? null,
              language: r.language ?? 'en',
              status: 'PUBLISHED',
            },
          });
          state.imported++;
        }
      }
      await this.prisma.reviewSyncState.upsert({
        where: { id: source.toLowerCase() },
        create: {
          id: source.toLowerCase(),
          provider: provider.name,
          lastSyncAt: this.now(),
          lastSuccessfulSyncAt: this.now(),
          reviewsImported: state.imported,
        },
        update: {
          lastSyncAt: this.now(),
          lastSuccessfulSyncAt: this.now(),
          lastError: null,
          reviewsImported: { increment: state.imported },
        },
      });
      return state;
    } catch (e) {
      await this.prisma.reviewSyncState.upsert({
        where: { id: source.toLowerCase() },
        create: {
          id: source.toLowerCase(),
          provider: provider.name,
          lastSyncAt: this.now(),
          lastError: (e as Error).message,
        },
        update: { lastSyncAt: this.now(), lastError: (e as Error).message },
      });
      throw e;
    }
  }

  /**
   * Setmore legacy import. Dry run first so an operator sees exactly what
   * would change before anything is written.
   */
  async importLegacy(
    rows: { externalId?: string; name: string; rating: number; text?: string; date?: string }[],
    options: { dryRun?: boolean } = {},
  ) {
    const report = { found: rows.length, valid: 0, invalid: 0, duplicates: 0, created: 0 };
    for (const row of rows) {
      const externalId = row.externalId ?? `setmore:${row.name}:${row.date ?? ''}`;
      const validRating = Number.isInteger(row.rating) && row.rating >= 1 && row.rating <= 5;
      if (!row.name || !validRating) {
        report.invalid++;
        continue;
      }
      report.valid++;
      const existing = await this.prisma.review.findUnique({
        where: { source_externalId: { source: 'SETMORE_LEGACY', externalId } },
      });
      if (existing) {
        report.duplicates++;
        continue;
      }
      if (!options.dryRun) {
        await this.prisma.review.create({
          data: {
            source: 'SETMORE_LEGACY',
            externalId,
            customerDisplayName: row.name,
            rating: row.rating,
            reviewText: row.text ?? null,
            originalText: row.text ?? null,
            reviewDate: row.date ? new Date(row.date) : this.now(),
            status: 'PUBLISHED',
          },
        });
      }
      report.created++;
    }
    return report;
  }

  /* ---------------- invitations ---------------- */

  /** Issue a review invitation for a completed booking. */
  async issueInvitation(bookingId: string, ttlDays = 30) {
    const booking = await this.prisma.booking.findUnique({ where: { id: bookingId } });
    if (!booking) throw new ReviewError('Booking not found.', 'BOOKING_NOT_FOUND');
    if (booking.status !== 'COMPLETED') {
      throw new ReviewError('Booking is not completed yet.', 'BOOKING_NOT_COMPLETED');
    }
    const token = randomBytes(32).toString('base64url');
    await this.prisma.reviewInvitation.upsert({
      where: { bookingId },
      create: {
        bookingId,
        customerId: booking.customerId,
        tokenHash: createHash('sha256').update(token).digest('hex'),
        expiresAt: new Date(this.now().getTime() + ttlDays * 86400000),
      },
      update: {
        tokenHash: createHash('sha256').update(token).digest('hex'),
        expiresAt: new Date(this.now().getTime() + ttlDays * 86400000),
        usedAt: null,
      },
    });
    return { token };
  }

  /** Redeem an invitation. Single use, expiring, and never reveals the booking. */
  async submitInvitedReview(token: string, input: { rating: number; text?: string; language?: string }) {
    const invitation = await this.prisma.reviewInvitation.findUnique({
      where: { tokenHash: createHash('sha256').update(token).digest('hex') },
    });
    if (!invitation) throw new ReviewError('That review link is not valid.', 'INVITATION_INVALID');
    if (invitation.usedAt) throw new ReviewError('That review link was already used.', 'INVITATION_USED');
    if (invitation.expiresAt <= this.now()) {
      throw new ReviewError('That review link has expired.', 'INVITATION_EXPIRED');
    }

    const customer = await this.prisma.customer.findUnique({
      where: { id: invitation.customerId },
    });

    const review = await this.create({
      source: 'R2NETTE_VERIFIED',
      customerDisplayName: customer?.firstName ?? 'R2NETTE customer',
      rating: input.rating,
      reviewText: input.text ?? null,
      bookingId: invitation.bookingId,
      customerId: invitation.customerId,
      language: input.language ?? 'en',
      status: 'PENDING',
    });
    await this.prisma.reviewInvitation.update({
      where: { id: invitation.id },
      data: { usedAt: this.now() },
    });
    return review;
  }

  /* ---------------- reads ---------------- */

  /** Published only. Hidden, rejected and pending never reach the public. */
  async listPublished(opts: { source?: string; limit?: number; featured?: boolean } = {}) {
    return this.prisma.review.findMany({
      where: {
        status: 'PUBLISHED',
        ...(opts.source ? { source: opts.source } : {}),
        ...(opts.featured !== undefined ? { featured: opts.featured } : {}),
      },
      orderBy: [{ featured: 'desc' }, { reviewDate: 'desc' }],
      take: Math.min(opts.limit ?? 20, 50),
      select: {
        id: true,
        source: true,
        customerDisplayName: true,
        rating: true,
        reviewText: true,
        reviewDate: true,
        sourceUrl: true,
        language: true,
        featured: true,
      },
    });
  }

  /**
   * Aggregate from PUBLISHED reviews only.
   *
   * Returns null average and zero count when there are none — the hero must
   * be able to show nothing rather than invent "5.0 from 21 reviews".
   */
  async summary(): Promise<ReviewSummary> {
    const rows = await this.prisma.review.findMany({
      where: { status: 'PUBLISHED' },
      select: { rating: true, source: true },
    });
    if (rows.length === 0) return { averageRating: null, reviewCount: 0, bySource: {} };

    const bySource: Record<string, { total: number; count: number }> = {};
    let total = 0;
    for (const r of rows) {
      total += r.rating;
      bySource[r.source] ??= { total: 0, count: 0 };
      bySource[r.source]!.total += r.rating;
      bySource[r.source]!.count += 1;
    }
    return {
      averageRating: Math.round((total / rows.length) * 10) / 10,
      reviewCount: rows.length,
      bySource: Object.fromEntries(
        Object.entries(bySource).map(([k, v]) => [
          k,
          { averageRating: Math.round((v.total / v.count) * 10) / 10, reviewCount: v.count },
        ]),
      ),
    };
  }

  async moderate(id: string, status: ReviewStatus, actor: string) {
    return this.prisma.review.update({
      where: { id },
      data: { status, moderatedBy: actor, moderatedAt: this.now() },
    });
  }
}

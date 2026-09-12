import { randomUUID } from 'node:crypto';

/**
 * Google Places (New) + Routes.
 *
 * Two rules this module exists to enforce:
 *
 * 1. The customer NEVER types a distance. They pick an address; the server
 *    computes the route. A browser-supplied kilometre figure is a price
 *    control, and price controls belong on the server.
 *
 * 2. Field masks are minimal. Google bills partly on requested fields, so a
 *    residential address lookup asks for address components and location —
 *    never ratings, photos, opening hours or reviews.
 */

export class PlacesError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export interface AddressSuggestion {
  placeId: string;
  primaryText: string;
  secondaryText: string;
}

export interface NormalizedAddress {
  placeId: string;
  formattedAddress: string;
  streetNumber: string | null;
  route: string | null;
  city: string;
  province: string;
  postalCode: string;
  country: string;
  latitude: number;
  longitude: number;
}

export interface RouteResult {
  distanceMeters: number;
  distanceKm: number;
  durationSeconds: number;
  provider: string;
  calculatedAt: Date;
}

export interface PlacesProvider {
  readonly configured: boolean;
  autocomplete(input: string, sessionToken: string): Promise<AddressSuggestion[]>;
  /** Ends the session — the caller must mint a fresh token afterwards. */
  details(placeId: string, sessionToken: string): Promise<NormalizedAddress>;
  computeRoute(
    origin: { latitude: number; longitude: number },
    destination: { placeId: string },
  ): Promise<RouteResult>;
}

/**
 * Autocomplete session tokens.
 *
 * Google groups an autocomplete session's keystrokes with the final Place
 * Details call for billing. A token must be fresh per session and retired
 * once details are fetched; reusing one across sessions is both a billing
 * problem and against current guidance.
 */
export class SessionTokenManager {
  private tokens = new Map<string, { token: string; createdAt: number }>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 3 * 60 * 1000,
  ) {}

  /** Get the live token for a search session, creating one if needed. */
  acquire(sessionId: string): string {
    const existing = this.tokens.get(sessionId);
    if (existing && this.now() - existing.createdAt < this.ttlMs) return existing.token;
    const token = randomUUID();
    this.tokens.set(sessionId, { token, createdAt: this.now() });
    return token;
  }

  /** Called after Place Details. The next search gets a brand-new token. */
  retire(sessionId: string): void {
    this.tokens.delete(sessionId);
  }

  has(sessionId: string): boolean {
    return this.tokens.has(sessionId);
  }
}

/* ------------------------------------------------------------------ */

const PLACES_BASE = 'https://places.googleapis.com/v1';
const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';

/** Only what an address lookup needs. Nothing billable that we won't use. */
const AUTOCOMPLETE_FIELD_MASK =
  'suggestions.placePrediction.placeId,suggestions.placePrediction.structuredFormat';
const DETAILS_FIELD_MASK = 'id,formattedAddress,addressComponents,location';
const ROUTES_FIELD_MASK = 'routes.distanceMeters,routes.duration';

export class GooglePlacesProvider implements PlacesProvider {
  private readonly key: string | undefined;

  constructor(env: Record<string, string | undefined> = process.env) {
    this.key = env.GOOGLE_MAPS_API_KEY;
  }

  get configured(): boolean {
    return Boolean(this.key);
  }

  private assertConfigured(): void {
    if (!this.configured) {
      throw new PlacesError(
        'Address lookup is not configured. Add GOOGLE_MAPS_API_KEY.',
        'INTEGRATION_NOT_CONFIGURED',
      );
    }
  }

  async autocomplete(input: string, sessionToken: string): Promise<AddressSuggestion[]> {
    this.assertConfigured();
    const res = await fetch(`${PLACES_BASE}/places:autocomplete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': this.key!,
        'X-Goog-FieldMask': AUTOCOMPLETE_FIELD_MASK,
      },
      body: JSON.stringify({
        input,
        sessionToken,
        includedRegionCodes: ['ca'],
        // Bias toward Greater Montréal without excluding legitimate
        // surrounding service areas.
        locationBias: {
          circle: {
            center: { latitude: 45.5019, longitude: -73.5674 },
            radius: 50000,
          },
        },
      }),
    });
    if (!res.ok) throw new PlacesError('Address lookup failed.', 'PLACES_ERROR');
    const json = (await res.json()) as {
      suggestions?: {
        placePrediction?: {
          placeId: string;
          structuredFormat?: { mainText?: { text: string }; secondaryText?: { text: string } };
        };
      }[];
    };
    return (json.suggestions ?? [])
      .filter((s) => s.placePrediction)
      .map((s) => ({
        placeId: s.placePrediction!.placeId,
        primaryText: s.placePrediction!.structuredFormat?.mainText?.text ?? '',
        secondaryText: s.placePrediction!.structuredFormat?.secondaryText?.text ?? '',
      }));
  }

  async details(placeId: string, sessionToken: string): Promise<NormalizedAddress> {
    this.assertConfigured();
    const res = await fetch(
      `${PLACES_BASE}/places/${encodeURIComponent(placeId)}?sessionToken=${encodeURIComponent(sessionToken)}`,
      {
        headers: {
          'X-Goog-Api-Key': this.key!,
          'X-Goog-FieldMask': DETAILS_FIELD_MASK,
        },
      },
    );
    if (!res.ok) throw new PlacesError('Could not load that address.', 'PLACES_ERROR');
    const json = (await res.json()) as {
      id: string;
      formattedAddress: string;
      location: { latitude: number; longitude: number };
      addressComponents?: { types: string[]; longText: string; shortText: string }[];
    };
    return normalizeComponents(json);
  }

  async computeRoute(
    origin: { latitude: number; longitude: number },
    destination: { placeId: string },
  ): Promise<RouteResult> {
    this.assertConfigured();
    const res = await fetch(ROUTES_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': this.key!,
        'X-Goog-FieldMask': ROUTES_FIELD_MASK,
      },
      body: JSON.stringify({
        origin: { location: { latLng: origin } },
        destination: { placeId: destination.placeId },
        travelMode: 'DRIVE',
        routingPreference: 'TRAFFIC_UNAWARE',
      }),
    });
    if (!res.ok) throw new PlacesError('Could not calculate travel distance.', 'ROUTES_ERROR');
    const json = (await res.json()) as {
      routes?: { distanceMeters?: number; duration?: string }[];
    };
    const route = json.routes?.[0];
    if (!route?.distanceMeters) {
      throw new PlacesError('No route to that address.', 'ROUTES_NO_ROUTE');
    }
    return {
      distanceMeters: route.distanceMeters,
      distanceKm: route.distanceMeters / 1000,
      durationSeconds: Number((route.duration ?? '0s').replace('s', '')),
      provider: 'google_routes',
      calculatedAt: new Date(),
    };
  }
}

export function normalizeComponents(json: {
  id: string;
  formattedAddress: string;
  location: { latitude: number; longitude: number };
  addressComponents?: { types: string[]; longText: string; shortText: string }[];
}): NormalizedAddress {
  const find = (type: string, short = false) => {
    const c = json.addressComponents?.find((x) => x.types.includes(type));
    return c ? (short ? c.shortText : c.longText) : null;
  };
  return {
    placeId: json.id,
    formattedAddress: json.formattedAddress,
    streetNumber: find('street_number'),
    route: find('route'),
    city: find('locality') ?? find('sublocality') ?? find('administrative_area_level_2') ?? '',
    province: find('administrative_area_level_1', true) ?? 'QC',
    postalCode: find('postal_code') ?? '',
    country: find('country', true) ?? 'CA',
    latitude: json.location.latitude,
    longitude: json.location.longitude,
  };
}

/** Deterministic provider for tests. */
export class FakePlacesProvider implements PlacesProvider {
  readonly configured = true;
  autocompleteCalls: { input: string; sessionToken: string }[] = [];
  detailsCalls: { placeId: string; sessionToken: string }[] = [];
  routeCalls = 0;
  nextDistanceMeters = 12_000;

  async autocomplete(input: string, sessionToken: string): Promise<AddressSuggestion[]> {
    this.autocompleteCalls.push({ input, sessionToken });
    return [
      { placeId: 'place_754', primaryText: '754 Avenue 36e', secondaryText: 'Lachine, QC, Canada' },
      { placeId: 'place_760', primaryText: '760 Avenue 36e', secondaryText: 'Lachine, QC, Canada' },
    ];
  }

  async details(placeId: string, sessionToken: string): Promise<NormalizedAddress> {
    this.detailsCalls.push({ placeId, sessionToken });
    return {
      placeId,
      formattedAddress: '754 Av. 36e, Lachine, QC H8T 1B7, Canada',
      streetNumber: '754',
      route: 'Avenue 36e',
      city: 'Lachine',
      province: 'QC',
      postalCode: 'H8T 1B7',
      country: 'CA',
      latitude: 45.4419,
      longitude: -73.6764,
    };
  }

  async computeRoute(): Promise<RouteResult> {
    this.routeCalls++;
    return {
      distanceMeters: this.nextDistanceMeters,
      distanceKm: this.nextDistanceMeters / 1000,
      durationSeconds: 900,
      provider: 'fake_routes',
      calculatedAt: new Date(),
    };
  }
}

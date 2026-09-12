import type { WorkerExpectation } from './health.js';
import { loadS3Config } from './object-storage.js';
import { LiveStripeProvider } from '../payments/stripe-provider.js';

/**
 * What production expects of each worker.
 *
 * `critical: true` means cutover stays blocked until it has succeeded at
 * least once in that environment. Source code existing is not evidence.
 */
export function workerExpectations(
  env: Record<string, string | undefined> = process.env,
): WorkerExpectation[] {
  return [
    {
      name: 'billing',
      label: 'Recurring billing',
      expectedWithinSeconds: 1800,
      critical: true,
      // Without Stripe there is nothing to charge; do not raise false alarms.
      configured: new LiveStripeProvider(env).configured,
    },
    { name: 'callbacks', label: 'Callback queue', expectedWithinSeconds: 600, critical: true },
    {
      name: 'notifications-retry',
      label: 'Notification delivery',
      expectedWithinSeconds: 1800,
      critical: true,
    },
    { name: 'recurrence', label: 'Recurring visits', expectedWithinSeconds: 14400, critical: true },
    {
      name: 'backup',
      label: 'Database backup',
      // One missed night is a warning, not a crisis.
      expectedWithinSeconds: 129600,
      critical: true,
    },
    {
      name: 'card-expiry',
      label: 'Card expiry warnings',
      expectedWithinSeconds: 172800,
      critical: false,
    },
    {
      name: 'operations-digest',
      label: 'Operations digest',
      expectedWithinSeconds: 172800,
      critical: false,
    },
  ];
}

/** Off-host storage is what makes a backup a backup. */
export function offHostConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return loadS3Config(env) !== null;
}

/** Local-only dumps are not completed disaster-recovery backups. */
export async function requireOffHostBackup(
  configured: boolean,
  reportMissing: () => Promise<unknown>,
): Promise<void> {
  if (configured) return;
  try {
    await reportMissing();
  } catch {
    // Incident reporting may also be unavailable; never convert failure to success.
  }
  throw new Error('Off-host backup is not configured; local dump retained.');
}

/**
 * Axios options for saving actions (sales, bills, receiving stock, returns,
 * adjustments, payments). The app's default request timeout is 5 seconds,
 * but a bill needs many database round-trips, so over a remote database it can
 * legitimately take longer. Giving up early shows an error even though the
 * server goes on to save the record, which invites a duplicate retry.
 */
export const SLOW_REQUEST = { timeout: 120_000 };

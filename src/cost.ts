// Estimated Artifacts cost from the published prices. Storage is not measured
// per workspace, so this estimate covers operations only.
// https://developers.cloudflare.com/artifacts/platform/pricing/

/** First 10,000 operations each month are included. Then $0.15 per 1,000. */
export const INCLUDED_OPERATIONS = 10_000;
export const USD_PER_THOUSAND_OPERATIONS = 0.15;

/** First 1 GB-month is included. Then $0.50 per GB-month. Not counted here. */
export const INCLUDED_STORAGE_GB = 1;
export const USD_PER_GB_MONTH = 0.5;

export function operationsCostUsd(accountOperations: number): number {
	const extra = Math.max(0, accountOperations - INCLUDED_OPERATIONS);
	return (extra / 1000) * USD_PER_THOUSAND_OPERATIONS;
}

export function formatUsd(amount: number): string {
	return `$${amount.toFixed(2)}`;
}

import { formatCurrency, formatDecimal } from '../../defaults/formatters';

/**
 * Money values for this tenant: Nepali Rupees, Indian-style digit grouping
 * (lakh/crore — e.g. 1,00,000 not 100,000), capped at 2 decimal places.
 * en-IN produces the same grouping used in Nepal; Intl has no dedicated
 * en-NP locale.
 */
export function formatMoney(value: number | string | null | undefined) {
  return (
    formatCurrency(value, {
      currency: 'NPR',
      locale: 'en-IN',
      digits: 2,
      minDigits: 2
    }) ?? '-'
  );
}

/** Plain quantities (not money) — same Indian grouping, no decimals unless present. */
export function formatQty(value: number | string | null | undefined) {
  if (value === null || value === undefined || value === '') {
    return '-';
  }
  const num = Number(value);
  if (Number.isNaN(num)) {
    return String(value);
  }
  return formatDecimal(num, { locale: 'en-IN', digits: 2 });
}

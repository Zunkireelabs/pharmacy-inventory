import { formatCurrency, formatDecimal } from '../../defaults/formatters';
import { useGlobalSettingsState } from '../../states/SettingsStates';

/**
 * Money values in the shop's currency, taken from the server's
 * INVENTREE_DEFAULT_CURRENCY global setting (Settings > Pricing; NPR if the
 * setting is not loaded yet). Indian-style digit grouping (lakh/crore, e.g.
 * 1,00,000) is used for NPR and INR; other currencies use the browser default.
 */
export function formatMoney(value: number | string | null | undefined) {
  const currency = String(
    useGlobalSettingsState
      .getState()
      .getSetting('INVENTREE_DEFAULT_CURRENCY', 'NPR') || 'NPR'
  );
  const indianGrouping = currency === 'NPR' || currency === 'INR';

  return (
    formatCurrency(value, {
      currency,
      locale: indianGrouping ? 'en-IN' : undefined,
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

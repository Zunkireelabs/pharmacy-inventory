import { Badge } from '@mantine/core';

import { formatMoney } from './format';

/** Outstanding-balance badge for the dashboard's Outstanding Customers
 * list. Deliberately simple (amount only) — the full aging/urgency
 * breakdown belongs to the Receivables workspace (a later phase), not the
 * dashboard glance view. */
export function CustomerBalanceBadge({
  amount
}: Readonly<{ amount: string }>) {
  return (
    <Badge color='red' variant='light' size='md'>
      {formatMoney(amount)}
    </Badge>
  );
}

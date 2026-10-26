import { t } from '@lingui/core/macro';
import { Badge } from '@mantine/core';

/**
 * Sale-type badge — distinct from InvoiceStatusBadge (payment state).
 * One consistent color per movement type, reused everywhere a movement
 * appears (dashboard recent activity, future Sales History) so the same
 * type always reads the same color across the whole product.
 */
const TYPE_COLOR: Record<string, string> = {
  b2b_credit: 'blue',
  b2c_cash: 'green',
  b2c_online: 'teal',
  gift: 'grape',
  restock: 'gray',
  correction: 'gray'
};

const TYPE_LABEL: Record<string, string> = {
  b2b_credit: t`B2B`,
  b2c_cash: t`Cash`,
  b2c_online: t`Online`,
  gift: t`Gift`,
  restock: t`Restock`,
  correction: t`Correction`
};

export function TransactionStatusBadge({
  saleType
}: Readonly<{ saleType: string }>) {
  return (
    <Badge color={TYPE_COLOR[saleType] ?? 'gray'} variant='light' size='sm'>
      {TYPE_LABEL[saleType] ?? saleType}
    </Badge>
  );
}

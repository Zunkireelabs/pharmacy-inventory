import { t } from '@lingui/core/macro';
import { Badge } from '@mantine/core';

const STATUS_COLOR: Record<string, string> = {
  unpaid: 'red',
  partially_paid: 'yellow',
  paid: 'green',
  cancelled: 'gray'
};

const STATUS_LABEL: Record<string, string> = {
  unpaid: t`Unpaid`,
  partially_paid: t`Partially Paid`,
  paid: t`Paid`,
  cancelled: t`Cancelled`
};

export function InvoiceStatusBadge({
  status
}: Readonly<{ status: string }>) {
  return (
    <Badge color={STATUS_COLOR[status] ?? 'gray'} size='sm'>
      {STATUS_LABEL[status] ?? status}
    </Badge>
  );
}

const AGING_COLOR: Record<string, string> = {
  current: 'green',
  '1-30': 'yellow',
  '31-60': 'orange',
  '61-90': 'red',
  '90+': 'grape'
};

const AGING_LABEL: Record<string, string> = {
  current: t`Current`,
  '1-30': t`1-30 days`,
  '31-60': t`31-60 days`,
  '61-90': t`61-90 days`,
  '90+': t`90+ days`
};

export function AgingBadge({
  bucket
}: Readonly<{ bucket: string | null }>) {
  if (!bucket) {
    return null;
  }

  return (
    <Badge color={AGING_COLOR[bucket] ?? 'gray'} size='sm' variant='outline'>
      {AGING_LABEL[bucket] ?? bucket}
    </Badge>
  );
}

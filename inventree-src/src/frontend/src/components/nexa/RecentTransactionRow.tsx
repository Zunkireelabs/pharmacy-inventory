import { Group, Stack, Text } from '@mantine/core';

import { formatMoney } from './format';
import { TransactionStatusBadge } from './TransactionStatusBadge';

export type RecentTransaction = {
  id: number;
  sale_type: string;
  part_name: string;
  customer_name?: string | null;
  total_value: string;
  created_at: string;
};

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** One compact row in the dashboard's Recent Activity list. No internal
 * database fields (tracking entry ids, raw movement pk) — only what a
 * shop employee needs to recognize the transaction. */
export function RecentTransactionRow({
  transaction
}: Readonly<{ transaction: RecentTransaction }>) {
  return (
    <Group justify='space-between' wrap='nowrap' py={6}>
      <Group gap='xs' wrap='nowrap' style={{ flex: 1, minWidth: 0 }}>
        <TransactionStatusBadge saleType={transaction.sale_type} />
        <Stack gap={0} style={{ flex: 1, minWidth: 0 }}>
          <Text size='sm' fw={500} truncate>
            {transaction.part_name}
          </Text>
          {transaction.customer_name && (
            <Text size='xs' c='dimmed' truncate>
              {transaction.customer_name}
            </Text>
          )}
        </Stack>
      </Group>
      <Stack gap={0} align='flex-end' style={{ flexShrink: 0 }}>
        <Text size='sm' fw={600}>
          {formatMoney(transaction.total_value)}
        </Text>
        <Text size='xs' c='dimmed'>
          {timeAgo(transaction.created_at)}
        </Text>
      </Stack>
    </Group>
  );
}

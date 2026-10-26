import { t } from '@lingui/core/macro';
import {
  Alert,
  Anchor,
  Card,
  Group,
  Progress,
  SimpleGrid,
  Skeleton,
  Stack,
  Text
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconCash,
  IconCoin,
  IconPackages
} from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';

import { api } from '../../App';
import { CustomerBalanceBadge } from './CustomerBalanceBadge';
import { formatMoney } from './format';
import { MetricCard } from './MetricCard';
import ReceivePaymentButton from './ReceivePaymentButton';
import RecordSaleButton from './RecordSaleButton';
import { RecentTransactionRow, type RecentTransaction } from './RecentTransactionRow';
import RestockButton from './RestockButton';

const TYPE_COLOR: Record<string, string> = {
  b2b_credit: 'blue',
  b2c_cash: 'green',
  b2c_online: 'teal'
};

const TYPE_LABEL: Record<string, string> = {
  b2b_credit: t`B2B Credit`,
  b2c_cash: t`Cash`,
  b2c_online: t`Online`
};

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function NexaDashboard() {
  const navigate = useNavigate();
  const today = todayIso();

  const salesToday = useQuery({
    queryKey: ['nexa-dashboard-sales-today', today],
    queryFn: async () => {
      const response = await api.get('/plugin/nexainventory/reports/sales/', {
        params: { date_from: today, date_to: today }
      });
      return response.data;
    }
  });

  const receivables = useQuery({
    queryKey: ['nexa-dashboard-receivables'],
    queryFn: async () => {
      const response = await api.get('/plugin/nexainventory/reports/receivables/');
      return response.data;
    }
  });

  const lowStock = useQuery({
    queryKey: ['nexa-dashboard-low-stock'],
    queryFn: async () => {
      const response = await api.get('/api/part/', {
        params: { low_stock: true, limit: 1 }
      });
      return response.data.count as number;
    }
  });

  const recentMovements = useQuery({
    queryKey: ['nexa-dashboard-recent-movements'],
    queryFn: async () => {
      const response = await api.get('/plugin/nexainventory/movements/', {
        params: { limit: 8 }
      });
      return response.data.results as RecentTransaction[];
    }
  });

  const hasAnyData = (recentMovements.data?.length ?? 0) > 0;

  const salesTotals = salesToday.data?.totals;
  const bySaleType = salesToday.data?.by_sale_type ?? {};
  const maxTypeValue = Math.max(
    1,
    ...Object.values(bySaleType).map((v: any) => Number(v.transaction_value))
  );

  const outstandingCustomers = (receivables.data?.by_customer ?? []).slice(0, 5);

  return (
    <Stack gap='lg'>
      {/* Primary actions — always first, per the product spec: staff act before they read numbers */}
      <SimpleGrid cols={{ base: 1, xs: 3 }} spacing='sm'>
        <RecordSaleButton
          fullWidth
          onSuccess={() => {
            salesToday.refetch();
            recentMovements.refetch();
            lowStock.refetch();
          }}
        />
        <ReceivePaymentButton fullWidth />
        <RestockButton fullWidth />
      </SimpleGrid>

      {/* Headline metrics */}
      <SimpleGrid cols={{ base: 1, xs: 2, md: 4 }}>
        <MetricCard
          label={t`Today's Sales`}
          value={salesToday.isFetching ? '' : formatMoney(salesTotals?.transaction_value ?? '0')}
          loading={salesToday.isFetching}
          icon={<IconCoin size={20} />}
          color='blue'
        />
        <MetricCard
          label={t`Collected Today`}
          value={salesToday.isFetching ? '' : formatMoney(salesTotals?.collected_value ?? '0')}
          loading={salesToday.isFetching}
          icon={<IconCash size={20} />}
          color='green'
        />
        <MetricCard
          label={t`Outstanding`}
          value={
            receivables.isFetching
              ? ''
              : formatMoney(receivables.data?.totals?.total_outstanding ?? '0')
          }
          loading={receivables.isFetching}
          icon={<IconAlertTriangle size={20} />}
          color='red'
        />
        <MetricCard
          label={t`Low Stock`}
          value={lowStock.isFetching ? '' : lowStock.isError ? '—' : (lowStock.data ?? 0)}
          hint={lowStock.isError ? t`No permission to view` : undefined}
          loading={lowStock.isFetching}
          icon={<IconPackages size={20} />}
          color={lowStock.isError ? 'gray' : 'orange'}
        />
      </SimpleGrid>

      {!hasAnyData && !recentMovements.isFetching && (
        <Alert color='blue' title={t`No sales recorded yet`}>
          {t`Use "New Sale" above to record your first transaction.`}
        </Alert>
      )}

      <SimpleGrid cols={{ base: 1, md: 2 }}>
        {/* Sales by type (today) */}
        <Card withBorder padding='md' radius='md'>
          <Text fw={700} mb='sm'>
            {t`Sales Today by Type`}
          </Text>
          {salesToday.isFetching ? (
            <Stack gap='xs'>
              <Skeleton height={16} />
              <Skeleton height={16} />
              <Skeleton height={16} />
            </Stack>
          ) : Object.keys(bySaleType).length === 0 ? (
            <Text size='sm' c='dimmed'>
              {t`No sales yet today`}
            </Text>
          ) : (
            <Stack gap='sm'>
              {Object.entries(bySaleType).map(([type, row]: [string, any]) => (
                <Stack key={type} gap={4}>
                  <Group justify='space-between'>
                    <Text size='sm'>{TYPE_LABEL[type] ?? type}</Text>
                    <Text size='sm' fw={600}>
                      {formatMoney(row.transaction_value)} ({row.transaction_count})
                    </Text>
                  </Group>
                  <Progress
                    value={(Number(row.transaction_value) / maxTypeValue) * 100}
                    color={TYPE_COLOR[type] ?? 'gray'}
                    size='sm'
                  />
                </Stack>
              ))}
            </Stack>
          )}
        </Card>

        {/* Recent activity */}
        <Card withBorder padding='md' radius='md'>
          <Text fw={700} mb='sm'>
            {t`Recent Activity`}
          </Text>
          {recentMovements.isFetching ? (
            <Stack gap='xs'>
              <Skeleton height={20} />
              <Skeleton height={20} />
              <Skeleton height={20} />
            </Stack>
          ) : !hasAnyData ? (
            <Text size='sm' c='dimmed'>
              {t`Nothing recorded yet`}
            </Text>
          ) : (
            <Stack gap={0}>
              {(recentMovements.data ?? []).map((txn) => (
                <RecentTransactionRow key={txn.id} transaction={txn} />
              ))}
            </Stack>
          )}
        </Card>
      </SimpleGrid>

      {/* Outstanding customers */}
      <Card withBorder padding='md' radius='md'>
        <Group justify='space-between' mb='sm'>
          <Text fw={700}>{t`Outstanding Customers`}</Text>
          <Anchor size='sm' component='button' onClick={() => navigate('/receivables/')}>
            {t`View all`}
          </Anchor>
        </Group>
        {receivables.isFetching ? (
          <Stack gap='xs'>
            <Skeleton height={20} />
            <Skeleton height={20} />
          </Stack>
        ) : outstandingCustomers.length === 0 ? (
          <Text size='sm' c='dimmed'>
            {t`No outstanding balances`}
          </Text>
        ) : (
          <Stack gap='xs'>
            {outstandingCustomers.map((c: any) => (
              <Group key={c.customer_id} justify='space-between'>
                <Anchor
                  size='sm'
                  component='button'
                  onClick={() => navigate(`/company/${c.customer_id}`)}
                >
                  {c.customer_name}
                </Anchor>
                <CustomerBalanceBadge amount={c.outstanding} />
              </Group>
            ))}
          </Stack>
        )}
      </Card>
    </Stack>
  );
}

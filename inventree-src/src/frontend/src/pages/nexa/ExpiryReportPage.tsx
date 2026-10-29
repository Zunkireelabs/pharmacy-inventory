import { t } from '@lingui/core/macro';
import {
  Anchor,
  Badge,
  Paper,
  SegmentedControl,
  Select,
  SimpleGrid,
  Skeleton,
  Stack,
  Table,
  Text
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { api } from '../../App';
import { PageDetail } from '../../components/nav/PageDetail';
import { formatExpiry, formatQty } from '../../components/nexa/format';
import { useBranches } from '../../components/nexa/ProductPicker';
import { ReportTabs } from '../../components/nexa/ReportTabs';
import { StatCard } from '../../components/nexa/StatCard';

type BatchRow = {
  stock_item_id: number;
  part_id: number;
  part_name: string;
  batch: string;
  expiry_date: string;
  days_left: number;
  quantity: string;
  location: string | null;
};

type ExpiryResponse = {
  as_of: string;
  window_days: number;
  expired: BatchRow[];
  expiring: BatchRow[];
  totals: { expired_batches: number; expiring_batches: number };
};

function BatchTable({
  rows,
  expired
}: Readonly<{ rows: BatchRow[]; expired: boolean }>) {
  const navigate = useNavigate();

  if (rows.length === 0) {
    return (
      <Text size='sm' c='dimmed'>
        {expired ? t`No expired stock on the shelves` : t`Nothing expiring in this window`}
      </Text>
    );
  }

  return (
    <Table.ScrollContainer minWidth={560}>
      <Table highlightOnHover verticalSpacing='xs'>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t`Medicine`}</Table.Th>
            <Table.Th>{t`Batch`}</Table.Th>
            <Table.Th>{t`Expiry`}</Table.Th>
            <Table.Th>{t`Days`}</Table.Th>
            <Table.Th ta='right'>{t`In Stock`}</Table.Th>
            <Table.Th>{t`Branch`}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((r) => (
            <Table.Tr key={r.stock_item_id}>
              <Table.Td>
                <Anchor
                  size='sm'
                  component='button'
                  onClick={() => navigate(`/stock/item/${r.stock_item_id}`)}
                >
                  {r.part_name}
                </Anchor>
              </Table.Td>
              <Table.Td>{r.batch || '-'}</Table.Td>
              <Table.Td>{formatExpiry(r.expiry_date)}</Table.Td>
              <Table.Td>
                <Badge
                  variant='light'
                  color={expired ? 'red' : r.days_left <= 30 ? 'orange' : 'yellow'}
                >
                  {expired ? t`expired` : `${r.days_left}`}
                </Badge>
              </Table.Td>
              <Table.Td ta='right'>{formatQty(r.quantity)}</Table.Td>
              <Table.Td>{r.location ?? '-'}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

/** Batches already expired and batches about to expire, soonest first. */
export default function ExpiryReportPage() {
  const [days, setDays] = useState('90');
  const [branch, setBranch] = useState<string | null>(null);
  const branches = useBranches();

  const query = useQuery({
    queryKey: ['nexa-expiry-report', days, branch],
    queryFn: async () => {
      const response = await api.get<ExpiryResponse>(
        '/plugin/nexainventory/reports/expiry/',
        { params: { days, branch: branch || undefined } }
      );
      return response.data;
    }
  });

  const data = query.data;

  return (
    <Stack gap='md'>
      <PageDetail title={t`Expiry Report`} />
      <ReportTabs active='expiry' />

      <SegmentedControl
        value={days}
        onChange={setDays}
        data={[
          { value: '30', label: t`30 days` },
          { value: '60', label: t`60 days` },
          { value: '90', label: t`90 days` },
          { value: '180', label: t`180 days` }
        ]}
        w='fit-content'
      />

      {(branches.data?.length ?? 0) > 0 && (
        <Select
          placeholder={t`All branches`}
          data={branches.data ?? []}
          value={branch}
          onChange={setBranch}
          clearable
          w={260}
        />
      )}

      <SimpleGrid cols={{ base: 1, xs: 2 }}>
        <StatCard
          label={t`Expired (still in stock)`}
          value={data?.totals.expired_batches ?? '-'}
          color={(data?.totals.expired_batches ?? 0) > 0 ? 'red' : undefined}
        />
        <StatCard
          label={t`Expiring within ${days} days`}
          value={data?.totals.expiring_batches ?? '-'}
          color='orange'
        />
      </SimpleGrid>

      {query.isError && (
        <Text c='red'>{t`Could not load the expiry report`}</Text>
      )}

      <Paper withBorder p='md' radius='md'>
        <Text fw={700} mb='sm' c='red'>
          {t`Expired — remove from sale and write off`}
        </Text>
        {query.isFetching && !data ? (
          <Skeleton height={60} />
        ) : (
          <BatchTable rows={data?.expired ?? []} expired />
        )}
      </Paper>

      <Paper withBorder p='md' radius='md'>
        <Text fw={700} mb='sm'>
          {t`Expiring soon`}
        </Text>
        {query.isFetching && !data ? (
          <Skeleton height={60} />
        ) : (
          <BatchTable rows={data?.expiring ?? []} expired={false} />
        )}
      </Paper>
    </Stack>
  );
}

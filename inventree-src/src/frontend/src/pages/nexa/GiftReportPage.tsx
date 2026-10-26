import { t } from '@lingui/core/macro';
import { Paper, SimpleGrid, Stack, Table, Text } from '@mantine/core';
import type { DateValue } from '@mantine/dates';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import { api } from '../../App';
import { PageDetail } from '../../components/nav/PageDetail';
import { formatMoney, formatQty } from '../../components/nexa/format';
import {
  ReportDateRangeFilter,
  formatDateParam
} from '../../components/nexa/ReportDateRangeFilter';
import { ReportTabs } from '../../components/nexa/ReportTabs';
import { StatCard } from '../../components/nexa/StatCard';

type GiftSummaryResponse = {
  date_from: string | null;
  date_to: string | null;
  totals: {
    gift_count: number;
    total_quantity: string;
    total_value: string;
  };
  by_part: {
    part_id: number;
    part_name: string;
    quantity: string;
    value: string;
  }[];
};

export default function GiftReportPage() {
  const [dateFrom, setDateFrom] = useState<DateValue>(null);
  const [dateTo, setDateTo] = useState<DateValue>(null);

  const params = useMemo(
    () => ({
      date_from: formatDateParam(dateFrom),
      date_to: formatDateParam(dateTo)
    }),
    [dateFrom, dateTo]
  );

  const query = useQuery({
    queryKey: ['nexa-gift-report', params],
    queryFn: async () => {
      const response = await api.get<GiftSummaryResponse>(
        '/plugin/nexainventory/reports/gifts/',
        { params }
      );
      return response.data;
    }
  });

  const data = query.data;

  return (
    <Stack>
      <PageDetail title={t`Gift Report`} />
      <ReportTabs active='gifts' />
      <ReportDateRangeFilter
        dateFrom={dateFrom}
        dateTo={dateTo}
        onDateFromChange={setDateFrom}
        onDateToChange={setDateTo}
      />
      <SimpleGrid cols={{ base: 1, xs: 3 }}>
        <StatCard label={t`Gifts`} value={data?.totals.gift_count ?? '-'} />
        <StatCard
          label={t`Total Quantity`}
          value={formatQty(data?.totals.total_quantity)}
        />
        <StatCard
          label={t`Total Value`}
          value={formatMoney(data?.totals.total_value)}
        />
      </SimpleGrid>
      <Paper withBorder p='md' radius='md'>
        <Text fw={700} mb='sm'>
          {t`Breakdown by Part`}
        </Text>
        <Table.ScrollContainer minWidth={400}>
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t`Part`}</Table.Th>
                <Table.Th>{t`Quantity`}</Table.Th>
                <Table.Th>{t`Value`}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {(data?.by_part ?? []).map((row) => (
                <Table.Tr key={row.part_id}>
                  <Table.Td>{row.part_name}</Table.Td>
                  <Table.Td>{formatQty(row.quantity)}</Table.Td>
                  <Table.Td>{formatMoney(row.value)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Paper>
    </Stack>
  );
}

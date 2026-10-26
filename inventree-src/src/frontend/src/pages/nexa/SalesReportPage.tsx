import { t } from '@lingui/core/macro';
import { Paper, SimpleGrid, Stack, Table, Text } from '@mantine/core';
import type { DateValue } from '@mantine/dates';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import { api } from '../../App';
import { formatMoney, formatQty } from '../../components/nexa/format';
import { StatCard } from '../../components/nexa/StatCard';
import {
  ReportDateRangeFilter,
  formatDateParam
} from '../../components/nexa/ReportDateRangeFilter';
import { PageDetail } from '../../components/nav/PageDetail';
import { ReportTabs } from '../../components/nexa/ReportTabs';

type SaleTypeSummary = {
  transaction_count: number;
  total_quantity: string;
  transaction_value: string;
  collected_value: string;
};

type SalesSummaryResponse = {
  date_from: string | null;
  date_to: string | null;
  totals: SaleTypeSummary;
  by_sale_type: Record<string, SaleTypeSummary>;
};

const TYPE_LABEL: Record<string, string> = {
  b2b_credit: t`B2B Credit`,
  b2c_cash: t`B2C Cash`,
  b2c_online: t`B2C Online`
};

export default function SalesReportPage() {
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
    queryKey: ['nexa-sales-report', params],
    queryFn: async () => {
      const response = await api.get<SalesSummaryResponse>(
        '/plugin/nexainventory/reports/sales/',
        { params }
      );
      return response.data;
    }
  });

  const data = query.data;

  return (
    <Stack>
      <PageDetail title={t`Sales Report`} />
      <ReportTabs active='sales' />
      <ReportDateRangeFilter
        dateFrom={dateFrom}
        dateTo={dateTo}
        onDateFromChange={setDateFrom}
        onDateToChange={setDateTo}
      />
      <SimpleGrid cols={{ base: 1, xs: 2, sm: 4 }}>
        <StatCard
          label={t`Transactions`}
          value={data?.totals.transaction_count ?? '-'}
        />
        <StatCard
          label={t`Total Quantity`}
          value={formatQty(data?.totals.total_quantity)}
        />
        <StatCard
          label={t`Transaction Value`}
          value={formatMoney(data?.totals.transaction_value)}
        />
        <StatCard
          label={t`Collected Value`}
          value={formatMoney(data?.totals.collected_value)}
          color='green'
        />
      </SimpleGrid>
      <Paper withBorder p='md' radius='md'>
        <Text fw={700} mb='sm'>
          {t`Breakdown by Sale Type`}
        </Text>
        <Table.ScrollContainer minWidth={500}>
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t`Sale Type`}</Table.Th>
                <Table.Th>{t`Transactions`}</Table.Th>
                <Table.Th>{t`Quantity`}</Table.Th>
                <Table.Th>{t`Transaction Value`}</Table.Th>
                <Table.Th>{t`Collected Value`}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {Object.entries(data?.by_sale_type ?? {}).map(
                ([saleType, row]) => (
                  <Table.Tr key={saleType}>
                    <Table.Td>{TYPE_LABEL[saleType] ?? saleType}</Table.Td>
                    <Table.Td>{row.transaction_count}</Table.Td>
                    <Table.Td>{formatQty(row.total_quantity)}</Table.Td>
                    <Table.Td>{formatMoney(row.transaction_value)}</Table.Td>
                    <Table.Td>{formatMoney(row.collected_value)}</Table.Td>
                  </Table.Tr>
                )
              )}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Paper>
    </Stack>
  );
}

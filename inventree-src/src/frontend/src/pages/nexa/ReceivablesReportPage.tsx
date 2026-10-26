import { t } from '@lingui/core/macro';
import { Anchor, Paper, SimpleGrid, Stack, Table, Text } from '@mantine/core';
import type { DateValue } from '@mantine/dates';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { api } from '../../App';
import { PageDetail } from '../../components/nav/PageDetail';
import { formatMoney } from '../../components/nexa/format';
import {
  ReportDateRangeFilter,
  formatDateParam
} from '../../components/nexa/ReportDateRangeFilter';
import { ReportTabs } from '../../components/nexa/ReportTabs';
import { StatCard } from '../../components/nexa/StatCard';

type AgingBucket = { invoice_count: number; outstanding: string };

type ReceivablesSummaryResponse = {
  date_from: string | null;
  date_to: string | null;
  totals: {
    total_invoiced: string;
    total_collected: string;
    total_outstanding: string;
    invoice_count: {
      unpaid: number;
      partially_paid: number;
      paid: number;
    };
  };
  aging: Record<string, AgingBucket>;
  by_customer: {
    customer_id: number;
    customer_name: string;
    outstanding: string;
  }[];
};

const AGING_ORDER = ['current', '1-30', '31-60', '61-90', '90+'];

export default function ReceivablesReportPage() {
  const navigate = useNavigate();
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
    queryKey: ['nexa-receivables-report', params],
    queryFn: async () => {
      const response = await api.get<ReceivablesSummaryResponse>(
        '/plugin/nexainventory/reports/receivables/',
        { params }
      );
      return response.data;
    }
  });

  const data = query.data;

  return (
    <Stack>
      <PageDetail title={t`Receivables Report`} />
      <ReportTabs active='receivables' />
      <ReportDateRangeFilter
        dateFrom={dateFrom}
        dateTo={dateTo}
        onDateFromChange={setDateFrom}
        onDateToChange={setDateTo}
      />
      <SimpleGrid cols={{ base: 1, xs: 2, sm: 3 }}>
        <StatCard
          label={t`Total Invoiced`}
          value={formatMoney(data?.totals.total_invoiced)}
        />
        <StatCard
          label={t`Total Collected`}
          value={formatMoney(data?.totals.total_collected)}
          color='green'
        />
        <StatCard
          label={t`Total Outstanding`}
          value={formatMoney(data?.totals.total_outstanding)}
          color='red'
        />
        <StatCard label={t`Unpaid`} value={data?.totals.invoice_count.unpaid ?? '-'} />
        <StatCard
          label={t`Partially Paid`}
          value={data?.totals.invoice_count.partially_paid ?? '-'}
        />
        <StatCard label={t`Paid`} value={data?.totals.invoice_count.paid ?? '-'} />
      </SimpleGrid>

      <Paper withBorder p='md' radius='md'>
        <Text fw={700} mb='sm'>
          {t`Aging`}
        </Text>
        <Table.ScrollContainer minWidth={500}>
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t`Bucket`}</Table.Th>
                <Table.Th>{t`Invoice Count`}</Table.Th>
                <Table.Th>{t`Outstanding`}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {AGING_ORDER.map((bucket) => {
                const row = data?.aging?.[bucket];
                return (
                  <Table.Tr key={bucket}>
                    <Table.Td>{bucket}</Table.Td>
                    <Table.Td>{row?.invoice_count ?? 0}</Table.Td>
                    <Table.Td>{formatMoney(row?.outstanding ?? '0')}</Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Paper>

      <Paper withBorder p='md' radius='md'>
        <Text fw={700} mb='sm'>
          {t`Outstanding by Customer`}
        </Text>
        <Table.ScrollContainer minWidth={400}>
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t`Customer`}</Table.Th>
                <Table.Th>{t`Outstanding`}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {(data?.by_customer ?? []).map((row) => (
                <Table.Tr key={row.customer_id}>
                  <Table.Td>
                    <Anchor
                      component='button'
                      onClick={() => navigate(`/company/${row.customer_id}`)}
                    >
                      {row.customer_name}
                    </Anchor>
                  </Table.Td>
                  <Table.Td>{formatMoney(row.outstanding)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Paper>
    </Stack>
  );
}

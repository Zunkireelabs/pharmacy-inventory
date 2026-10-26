import { t } from '@lingui/core/macro';
import { SimpleGrid, Stack } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';

import { api } from '../../App';
import type { InvoiceRow } from '../../tables/nexa/InvoiceTable';
import { InvoiceTable } from '../../tables/nexa/InvoiceTable';
import { formatMoney } from './format';
import { StatCard } from './StatCard';

type CustomerReceivablesResponse = {
  customer_id: number;
  total_outstanding: string;
  invoices: {
    id: number;
    reference: string;
    total: string;
    outstanding: string;
    status: string;
    due_date: string;
    aging_bucket: string | null;
  }[];
};

/**
 * Receivables tab content for the Company detail page — only shown for
 * customers (company.is_customer). Reuses InvoiceTable; the
 * per-customer endpoint doesn't return customer_name (redundant on this
 * page) or invoice_date/amount_paid, so those columns are omitted here.
 */
export function CustomerReceivablesPanel({
  customerId
}: Readonly<{ customerId: number }>) {
  const query = useQuery({
    queryKey: ['nexa-customer-receivables', customerId],
    queryFn: async () => {
      const response = await api.get<CustomerReceivablesResponse>(
        `/plugin/nexainventory/customers/${customerId}/receivables/`
      );
      return response.data;
    },
    enabled: !!customerId
  });

  const data = query.data;

  const rows: InvoiceRow[] = (data?.invoices ?? []).map((inv) => ({
    id: inv.id,
    reference: inv.reference,
    customer_id: customerId,
    invoice_date: '',
    due_date: inv.due_date,
    total: inv.total,
    outstanding: inv.outstanding,
    status: inv.status,
    is_overdue: false,
    aging_bucket: inv.aging_bucket
  }));

  return (
    <Stack>
      <SimpleGrid cols={{ base: 1, xs: 2 }}>
        <StatCard
          label={t`Total Outstanding`}
          value={data ? formatMoney(data.total_outstanding) : '-'}
          color='red'
        />
        <StatCard
          label={t`Outstanding Invoices`}
          value={data?.invoices.length ?? '-'}
        />
      </SimpleGrid>
      <InvoiceTable
        records={rows}
        loading={query.isFetching}
        showCustomer={false}
        showInvoiceDate={false}
      />
    </Stack>
  );
}

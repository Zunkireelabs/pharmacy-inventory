import { t } from '@lingui/core/macro';
import { Anchor, Table } from '@mantine/core';
import { DataTable, type DataTableColumn } from 'mantine-datatable';
import { useNavigate } from 'react-router-dom';

import { formatMoney } from '../../components/nexa/format';
import { AgingBadge, InvoiceStatusBadge } from '../../components/nexa/InvoiceStatusBadge';

export type InvoiceRow = {
  id: number;
  reference: string;
  customer_id: number;
  customer_name?: string;
  invoice_date: string;
  due_date: string;
  total: string;
  amount_paid?: string;
  outstanding: string;
  status: string;
  is_overdue: boolean;
  aging_bucket: string | null;
};

/**
 * Plain mantine-datatable usage (the same underlying library InvenTree's
 * InvenTreeTable wraps) rather than InvenTreeTable itself — our plugin
 * endpoints return a plain JSON array, not InvenTree's paginated
 * {count, results} list contract that InvenTreeTable expects, and have no
 * server-side sort/filter support to hand off to it.
 */
export function InvoiceTable({
  records,
  loading,
  showCustomer = true,
  showInvoiceDate = true
}: Readonly<{
  records: InvoiceRow[];
  loading: boolean;
  showCustomer?: boolean;
  showInvoiceDate?: boolean;
}>) {
  const navigate = useNavigate();

  const columns: DataTableColumn<InvoiceRow>[] = [
    {
      accessor: 'reference',
      title: t`Reference`,
      render: (row) => (
        <Anchor
          component='button'
          onClick={() => navigate(`/receivables/invoice/${row.id}`)}
        >
          {row.reference}
        </Anchor>
      )
    },
    ...(showCustomer
      ? [
          {
            accessor: 'customer_name',
            title: t`Customer`
          } as DataTableColumn<InvoiceRow>
        ]
      : []),
    ...(showInvoiceDate
      ? [
          {
            accessor: 'invoice_date',
            title: t`Invoice Date`
          } as DataTableColumn<InvoiceRow>
        ]
      : []),
    { accessor: 'due_date', title: t`Due Date` },
    {
      accessor: 'total',
      title: t`Total`,
      textAlign: 'right',
      render: (row) => formatMoney(row.total)
    },
    {
      accessor: 'outstanding',
      title: t`Outstanding`,
      textAlign: 'right',
      render: (row) => formatMoney(row.outstanding)
    },
    {
      accessor: 'status',
      title: t`Status`,
      render: (row) => <InvoiceStatusBadge status={row.status} />
    },
    {
      accessor: 'aging_bucket',
      title: t`Aging`,
      render: (row) => <AgingBadge bucket={row.aging_bucket} />
    }
  ];

  return (
    <Table.ScrollContainer minWidth={700}>
      <DataTable
        records={records}
        columns={columns}
        fetching={loading}
        idAccessor='id'
        minHeight={records.length === 0 ? 150 : undefined}
        noRecordsText={t`No invoices found`}
      />
    </Table.ScrollContainer>
  );
}

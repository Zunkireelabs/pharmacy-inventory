import { t } from '@lingui/core/macro';
import {
  Anchor,
  Button,
  Group,
  Paper,
  SimpleGrid,
  Skeleton,
  Stack,
  Table,
  Text
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { api } from '../../App';
import { PageDetail } from '../../components/nav/PageDetail';
import { formatMoney, formatQty } from '../../components/nexa/format';
import { AgingBadge, InvoiceStatusBadge } from '../../components/nexa/InvoiceStatusBadge';
import { StatCard } from '../../components/nexa/StatCard';
import { recordPaymentFields } from '../../forms/NexaForms';
import { useCreateApiFormModal } from '../../hooks/UseForm';
import {
  PaymentHistoryTable,
  type PaymentRow
} from '../../tables/nexa/PaymentHistoryTable';

type InvoiceLine = {
  id: number;
  sale_type_movement_id: number;
  quantity: string;
  unit_price: string;
  line_total: string;
};

type InvoiceDetail = {
  id: number;
  reference: string;
  customer_id: number;
  invoice_date: string;
  due_date: string;
  total: string;
  amount_paid: string;
  outstanding: string;
  status: string;
  is_overdue: boolean;
  aging_bucket: string | null;
  lines: InvoiceLine[];
};

export default function InvoiceDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();

  const invoiceQuery = useQuery({
    queryKey: ['nexa-invoice-detail', id],
    queryFn: async () => {
      const response = await api.get<InvoiceDetail>(
        `/plugin/nexainventory/invoices/${id}/`
      );
      return response.data;
    },
    enabled: !!id
  });

  const paymentsQuery = useQuery({
    queryKey: ['nexa-invoice-payments', id],
    queryFn: async () => {
      const response = await api.get<PaymentRow[]>(
        `/plugin/nexainventory/invoices/${id}/payments/`
      );
      return response.data;
    },
    enabled: !!id
  });

  const paymentFields = useMemo(() => recordPaymentFields(), []);

  const recordPaymentModal = useCreateApiFormModal({
    url: `/plugin/nexainventory/invoices/${id}/payments/`,
    title: t`Record Payment`,
    fields: paymentFields,
    ignorePermissionCheck: true,
    successMessage: t`Payment recorded`,
    onFormSuccess: () => {
      invoiceQuery.refetch();
      paymentsQuery.refetch();
    }
  });

  const invoice = invoiceQuery.data;

  if (invoiceQuery.isFetching && !invoice) {
    return <Skeleton height={400} />;
  }

  if (!invoice) {
    return <Text c='red'>{t`Invoice not found`}</Text>;
  }

  const canRecordPayment =
    invoice.status !== 'cancelled' && invoice.status !== 'paid';

  return (
    <Stack>
      {recordPaymentModal.modal}
      <PageDetail
        title={invoice.reference}
        actions={[
          <Button
            key='record-payment'
            disabled={!canRecordPayment}
            onClick={() => recordPaymentModal.open()}
          >
            {t`Record Payment`}
          </Button>
        ]}
      />

      <Group>
        <InvoiceStatusBadge status={invoice.status} />
        <AgingBadge bucket={invoice.aging_bucket} />
      </Group>

      <SimpleGrid cols={{ base: 1, xs: 2, sm: 4 }}>
        <StatCard label={t`Total`} value={formatMoney(invoice.total)} />
        <StatCard
          label={t`Paid`}
          value={formatMoney(invoice.amount_paid)}
          color='green'
        />
        <StatCard
          label={t`Outstanding`}
          value={formatMoney(invoice.outstanding)}
          color='red'
        />
        <StatCard label={t`Due Date`} value={invoice.due_date} />
      </SimpleGrid>

      <Paper withBorder p='md' radius='md'>
        <Group justify='space-between' mb='sm'>
          <Text fw={700}>{t`Customer`}</Text>
          <Anchor
            component='button'
            onClick={() => navigate(`/company/${invoice.customer_id}`)}
          >
            {t`View Customer`}
          </Anchor>
        </Group>
        <Text size='sm' c='dimmed'>
          {t`Invoice Date`}: {invoice.invoice_date}
        </Text>
      </Paper>

      <Paper withBorder p='md' radius='md'>
        <Text fw={700} mb='sm'>
          {t`Line Items`}
        </Text>
        <Table.ScrollContainer minWidth={400}>
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t`Quantity`}</Table.Th>
                <Table.Th>{t`Unit Price`}</Table.Th>
                <Table.Th>{t`Line Total`}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {invoice.lines.map((line) => (
                <Table.Tr key={line.id}>
                  <Table.Td>{formatQty(line.quantity)}</Table.Td>
                  <Table.Td>{formatMoney(line.unit_price)}</Table.Td>
                  <Table.Td>{formatMoney(line.line_total)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Paper>

      <Paper withBorder p='md' radius='md'>
        <Text fw={700} mb='sm'>
          {t`Payment History`}
        </Text>
        <PaymentHistoryTable
          records={paymentsQuery.data ?? []}
          loading={paymentsQuery.isFetching}
        />
      </Paper>
    </Stack>
  );
}

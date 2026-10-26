import { t } from '@lingui/core/macro';
import { Badge, Select, Stack, Table, Text, TextInput } from '@mantine/core';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { api } from '../../App';
import { PageDetail } from '../../components/nav/PageDetail';
import { formatMoney, formatQty } from '../../components/nexa/format';

type Row = {
  id: number;
  part_name: string;
  supplier: string;
  invoice_no: string;
  purchase_date: string;
  batch: string;
  expiry_date: string;
  quantity: string;
  bonus_quantity: string;
  line_total: string;
  payment_status: string;
  received_by: string;
};

const STATUS_COLOR: Record<string, string> = {
  paid: 'green',
  partial: 'yellow',
  unpaid: 'red'
};

/** Stock received from suppliers (purchase entries), newest first. */
export default function PurchaseListPage() {
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    const handle = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(handle);
  }, [search]);

  const query = useQuery({
    queryKey: ['nexa-purchases', debounced, status],
    queryFn: async () => {
      const response = await api.get('/plugin/nexainventory/purchases/', {
        params: { limit: 100, search: debounced || undefined, payment_status: status || undefined }
      });
      return response.data.results as Row[];
    },
    placeholderData: keepPreviousData
  });

  const rows = query.data ?? [];

  return (
    <Stack gap='md'>
      <PageDetail title={t`Purchase Entries`} />
      <Stack gap='xs' maw={420}>
        <TextInput
          placeholder={t`Search medicine, supplier, invoice or batch`}
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
        />
        <Select
          placeholder={t`All payment statuses`}
          data={[
            { value: 'unpaid', label: t`Unpaid` },
            { value: 'partial', label: t`Partially Paid` },
            { value: 'paid', label: t`Paid` }
          ]}
          value={status}
          onChange={setStatus}
          clearable
        />
      </Stack>
      {rows.length === 0 ? (
        <Text c='dimmed'>
          {query.isFetching ? t`Loading...` : t`No purchases recorded yet — use Receive Stock`}
        </Text>
      ) : (
        <Table.ScrollContainer minWidth={820}>
          <Table highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t`Date`}</Table.Th>
                <Table.Th>{t`Invoice`}</Table.Th>
                <Table.Th>{t`Supplier`}</Table.Th>
                <Table.Th>{t`Medicine`}</Table.Th>
                <Table.Th>{t`Batch`}</Table.Th>
                <Table.Th>{t`Expiry`}</Table.Th>
                <Table.Th ta='right'>{t`Qty (+free)`}</Table.Th>
                <Table.Th ta='right'>{t`Total`}</Table.Th>
                <Table.Th>{t`Payment`}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((r) => (
                <Table.Tr key={r.id}>
                  <Table.Td>{r.purchase_date}</Table.Td>
                  <Table.Td>{r.invoice_no || '-'}</Table.Td>
                  <Table.Td>{r.supplier || '-'}</Table.Td>
                  <Table.Td>{r.part_name}</Table.Td>
                  <Table.Td>{r.batch}</Table.Td>
                  <Table.Td>{r.expiry_date}</Table.Td>
                  <Table.Td ta='right'>
                    {formatQty(r.quantity)}
                    {Number(r.bonus_quantity) > 0 ? ` (+${formatQty(r.bonus_quantity)})` : ''}
                  </Table.Td>
                  <Table.Td ta='right'>{formatMoney(r.line_total)}</Table.Td>
                  <Table.Td>
                    <Badge variant='light' color={STATUS_COLOR[r.payment_status] ?? 'gray'}>
                      {r.payment_status}
                    </Badge>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
    </Stack>
  );
}

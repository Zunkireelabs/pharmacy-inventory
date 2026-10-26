import { t } from '@lingui/core/macro';
import { Anchor, Stack, Table, Text, TextInput } from '@mantine/core';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { api } from '../../App';
import { PageDetail } from '../../components/nav/PageDetail';
import { formatMoney } from '../../components/nexa/format';

type BillRow = {
  id: number;
  reference: string;
  customer_name: string;
  payment_mode: string;
  net_amount: string;
  created_at: string;
};

/** Recent customer bills; open one to view or reprint it. */
export default function BillListPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');

  useEffect(() => {
    const handle = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(handle);
  }, [search]);

  const query = useQuery({
    queryKey: ['nexa-bills', debounced],
    queryFn: async () => {
      const response = await api.get('/plugin/nexainventory/bills/', {
        params: { limit: 50, search: debounced || undefined }
      });
      return response.data.results as BillRow[];
    },
    placeholderData: keepPreviousData
  });

  const rows = query.data ?? [];

  return (
    <Stack gap='md'>
      <PageDetail title={t`Bills`} />
      <TextInput
        placeholder={t`Search by bill no, customer name or phone`}
        value={search}
        onChange={(e) => setSearch(e.currentTarget.value)}
        maw={420}
      />
      {rows.length === 0 ? (
        <Text c='dimmed'>{query.isFetching ? t`Loading...` : t`No bills yet`}</Text>
      ) : (
        <Table.ScrollContainer minWidth={520}>
          <Table highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t`Bill No`}</Table.Th>
                <Table.Th>{t`Date`}</Table.Th>
                <Table.Th>{t`Customer`}</Table.Th>
                <Table.Th>{t`Payment`}</Table.Th>
                <Table.Th ta='right'>{t`Net Amount`}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((b) => (
                <Table.Tr key={b.id}>
                  <Table.Td>
                    <Anchor component='button' onClick={() => navigate(`/bills/${b.id}`)}>
                      {b.reference}
                    </Anchor>
                  </Table.Td>
                  <Table.Td>{new Date(b.created_at).toLocaleString('en-GB')}</Table.Td>
                  <Table.Td>{b.customer_name || '-'}</Table.Td>
                  <Table.Td>{b.payment_mode}</Table.Td>
                  <Table.Td ta='right'>{formatMoney(b.net_amount)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
    </Stack>
  );
}

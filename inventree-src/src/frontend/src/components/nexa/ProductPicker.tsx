import { t } from '@lingui/core/macro';
import { Select, Text } from '@mantine/core';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { api } from '../../App';

type StockItemOption = {
  value: string;
  label: string;
  quantity: number;
  partName: string;
};

/**
 * Stock-item typeahead for the New Sale form — shows current stock level
 * inline in the dropdown so staff see availability before submitting, not
 * after a rejected request. Debounced search against the existing
 * /api/stock/ endpoint (no new API).
 */
export function ProductPicker({
  value,
  onChange
}: Readonly<{
  value: number | null;
  onChange: (
    stockItemId: number | null,
    stockQuantity: number | null,
    partName: string | null
  ) => void;
}>) {
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');

  useEffect(() => {
    const handle = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(handle);
  }, [search]);

  const query = useQuery({
    queryKey: ['nexa-stock-picker', debounced],
    queryFn: async () => {
      const response = await api.get('/api/stock/', {
        params: { search: debounced || undefined, part_detail: true, limit: 20 }
      });
      const items = response.data.results ?? response.data;
      return items.map((item: any) => {
        const partName = item.part_detail?.name ?? t`Unknown`;
        return {
          value: String(item.pk),
          label: `${partName} — ${item.quantity} in stock`,
          quantity: item.quantity,
          partName
        };
      }) as StockItemOption[];
    },
    // See CustomerPicker for why this is needed — avoids the options list
    // (and modal) flashing empty between debounced keystrokes.
    placeholderData: keepPreviousData
  });

  const options = query.data ?? [];

  return (
    <Select
      label={t`Product`}
      placeholder={t`Search for a product...`}
      autoComplete='off'
      searchable
      searchValue={search}
      onSearchChange={setSearch}
      data={options.map((o) => ({ value: o.value, label: o.label }))}
      value={value ? String(value) : null}
      onChange={(val) => {
        const selected = options.find((o) => o.value === val);
        onChange(
          val ? Number(val) : null,
          selected?.quantity ?? null,
          selected?.partName ?? null
        );
      }}
      nothingFoundMessage={
        query.isFetching ? t`Searching...` : t`No products found`
      }
      required
    />
  );
}

export function StockAvailabilityHint({
  quantity
}: Readonly<{ quantity: number | null }>) {
  if (quantity === null) return null;
  return (
    <Text size='xs' c={quantity > 0 ? 'dimmed' : 'red'}>
      {quantity > 0 ? t`${quantity} currently in stock` : t`Out of stock`}
    </Text>
  );
}

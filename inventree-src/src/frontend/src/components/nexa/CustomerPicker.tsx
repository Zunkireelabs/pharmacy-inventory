import { t } from '@lingui/core/macro';
import { Select } from '@mantine/core';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { api } from '../../App';

/** Customer typeahead for the New Sale (B2B) form — searches only
 * is_customer=true companies via the existing /api/company/ endpoint. */
export function CustomerPicker({
  value,
  onChange,
  required = true
}: Readonly<{
  value: number | null;
  onChange: (customerId: number | null) => void;
  required?: boolean;
}>) {
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');

  useEffect(() => {
    const handle = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(handle);
  }, [search]);

  const query = useQuery({
    queryKey: ['nexa-customer-picker', debounced],
    queryFn: async () => {
      const response = await api.get('/api/company/', {
        params: { search: debounced || undefined, is_customer: true, limit: 20 }
      });
      const items = response.data.results ?? response.data;
      return items.map((item: any) => ({
        value: String(item.pk),
        label: item.name
      }));
    },
    // Without this, every debounce tick swaps queryKey and TanStack Query
    // resets `data` to undefined while the new request is in flight, so the
    // dropdown options collapse to empty ("Searching...") and repopulate on
    // every keystroke pause — visible as the list (and surrounding modal,
    // on a small/fullScreen mobile viewport) flashing repeatedly while
    // typing. Keeping the previous page's results displayed until the new
    // ones arrive removes that flash.
    placeholderData: keepPreviousData
  });

  const options = query.data ?? [];

  return (
    <Select
      label={t`Customer`}
      placeholder={t`Search for a customer...`}
      autoComplete='off'
      searchable
      searchValue={search}
      onSearchChange={setSearch}
      data={options}
      value={value ? String(value) : null}
      onChange={(val) => onChange(val ? Number(val) : null)}
      nothingFoundMessage={
        query.isFetching ? t`Searching...` : t`No customers found`
      }
      required={required}
      clearable={!required}
    />
  );
}

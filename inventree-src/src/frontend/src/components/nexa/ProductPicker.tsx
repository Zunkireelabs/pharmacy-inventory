import { t } from '@lingui/core/macro';
import { Badge, Group, Select, Stack, Table, Text } from '@mantine/core';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

import { api } from '../../App';
import { formatQty } from './format';

export type MedicineFlags = {
  requiresPrescription: boolean;
  isControlled: boolean;
};

export type Batch = {
  id: number;
  batch: string;
  expiryDate: string | null;
  quantity: number;
  expired: boolean;
};

const NO_FLAGS: MedicineFlags = {
  requiresPrescription: false,
  isControlled: false
};

/** Prescription / controlled flags for every flagged medicine, keyed by part id. */
export function useMedicineFlags() {
  const query = useQuery({
    queryKey: ['nexa-medicine-flags'],
    queryFn: async () => {
      const response = await api.get('/plugin/nexainventory/medicine/');
      const map: Record<number, MedicineFlags> = {};
      for (const row of response.data ?? []) {
        map[row.part_id] = {
          requiresPrescription: !!row.requires_prescription,
          isControlled: !!row.is_controlled
        };
      }
      return map;
    },
    staleTime: 30_000
  });

  return query.data ?? {};
}

export type Branch = { value: string; label: string };

/** The pharmacy's branches (top-level stock locations). */
export function useBranches() {
  return useQuery({
    queryKey: ['nexa-branches'],
    queryFn: async () => {
      const response = await api.get('/plugin/nexainventory/branches/');
      return (response.data ?? []).map((b: any) => ({
        value: String(b.id),
        label: b.name
      })) as Branch[];
    },
    staleTime: 60_000
  });
}

export function flagsFor(
  all: Record<number, MedicineFlags>,
  partId: number | null
): MedicineFlags {
  return (partId !== null && all[partId]) || NO_FLAGS;
}

/**
 * In-stock batches of one medicine, earliest expiry first (no expiry last).
 * Expired batches are marked: the server will not sell them.
 */
export function useBatches(partId: number | null, branchId?: string | null) {
  return useQuery({
    queryKey: ['nexa-batches', partId, branchId ?? null],
    enabled: partId !== null,
    queryFn: async () => {
      const response = await api.get('/api/stock/', {
        params: {
          part: partId,
          in_stock: true,
          limit: 100,
          location: branchId || undefined,
          cascade: branchId ? true : undefined
        }
      });
      const today = new Date().toISOString().slice(0, 10);
      const rows: Batch[] = (response.data.results ?? response.data)
        .filter((item: any) => Number(item.quantity) > 0)
        .map((item: any) => ({
          id: item.pk,
          batch: item.batch ?? '',
          expiryDate: item.expiry_date ?? null,
          quantity: Number(item.quantity),
          expired: !!item.expiry_date && item.expiry_date < today
        }));
      rows.sort((a, b) => {
        if (a.expiryDate === b.expiryDate) return a.id - b.id;
        if (a.expiryDate === null) return 1;
        if (b.expiryDate === null) return -1;
        return a.expiryDate < b.expiryDate ? -1 : 1;
      });
      return rows;
    }
  });
}

/** Quantity that can actually be sold: in stock and not expired. */
export function sellableQuantity(batches: Batch[] | undefined): number | null {
  if (!batches) return null;
  return batches.filter((b) => !b.expired).reduce((s, b) => s + b.quantity, 0);
}

export function FlagBadges({ flags }: Readonly<{ flags: MedicineFlags }>) {
  if (!flags.requiresPrescription && !flags.isControlled) return null;
  return (
    <Group gap={4}>
      {flags.requiresPrescription && (
        <Badge size='xs' color='orange' variant='light'>
          {t`Rx`}
        </Badge>
      )}
      {flags.isControlled && (
        <Badge size='xs' color='red' variant='light'>
          {t`Controlled`}
        </Badge>
      )}
    </Group>
  );
}

type PartOption = {
  value: string;
  label: string;
  partName: string;
};

/**
 * Medicine typeahead for the New Sale form. Selecting a medicine (not a
 * specific batch) lets the server sell the earliest-expiring batches first.
 * Debounced search against the existing /api/part/ endpoint.
 */
export function ProductPicker({
  value,
  onChange
}: Readonly<{
  value: number | null;
  onChange: (partId: number | null, partName: string | null) => void;
}>) {
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const flags = useMedicineFlags();

  useEffect(() => {
    const handle = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(handle);
  }, [search]);

  const query = useQuery({
    queryKey: ['nexa-part-picker', debounced],
    queryFn: async () => {
      const response = await api.get('/api/part/', {
        params: { search: debounced || undefined, limit: 20, active: true }
      });
      const parts = response.data.results ?? response.data;
      return parts.map((part: any) => ({
        value: String(part.pk),
        label: `${part.full_name || part.name}${
          part.IPN ? ` (${part.IPN})` : ''
        }`,
        partName: part.name
      })) as PartOption[];
    },
    // See CustomerPicker for why this is needed — avoids the options list
    // (and modal) flashing empty between debounced keystrokes.
    placeholderData: keepPreviousData
  });

  const options = query.data ?? [];
  const selectedFlags = flagsFor(flags, value);

  return (
    <Stack gap={4}>
      <Select
        label={t`Medicine`}
        placeholder={t`Search for a medicine...`}
        autoComplete='off'
        searchable
        searchValue={search}
        onSearchChange={setSearch}
        data={options.map((o) => ({
          value: o.value,
          label: flagsFor(flags, Number(o.value)).requiresPrescription
            ? `${o.label}  ℞`
            : o.label
        }))}
        value={value ? String(value) : null}
        onChange={(val) => {
          const selected = options.find((o) => o.value === val);
          onChange(val ? Number(val) : null, selected?.partName ?? null);
        }}
        nothingFoundMessage={
          query.isFetching ? t`Searching...` : t`No medicines found`
        }
        required
      />
      {value !== null && <FlagBadges flags={selectedFlags} />}
    </Stack>
  );
}

/** Batches that will be used, in order, with expiry and quantity. */
export function BatchPreview({
  batches
}: Readonly<{ batches: Batch[] | undefined }>) {
  const rows = useMemo(() => (batches ?? []).slice(0, 4), [batches]);

  if (!batches) return null;
  if (batches.length === 0) {
    return (
      <Text size='xs' c='red'>
        {t`Out of stock`}
      </Text>
    );
  }

  const sellable = sellableQuantity(batches) ?? 0;
  const more = batches.length - rows.length;
  const sellableText = String(formatQty(sellable));

  return (
    <Stack gap={4}>
      <Text size='xs' c={sellable > 0 ? 'dimmed' : 'red'}>
        {sellable > 0
          ? t`${sellableText} available to sell — earliest expiry is sold first`
          : t`Only expired stock is left — nothing can be sold`}
      </Text>
      <Table withRowBorders={false} verticalSpacing={2} fz='xs'>
        <Table.Tbody>
          {rows.map((b) => (
            <Table.Tr key={b.id} c={b.expired ? 'red' : undefined}>
              <Table.Td>{b.batch || t`(no batch)`}</Table.Td>
              <Table.Td>
                {b.expiryDate ?? t`no expiry`}
                {b.expired ? ` — ${t`EXPIRED`}` : ''}
              </Table.Td>
              <Table.Td ta='right'>{formatQty(b.quantity)}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {more > 0 && (
        <Text size='xs' c='dimmed'>
          {t`+ ${more} more batches`}
        </Text>
      )}
    </Stack>
  );
}

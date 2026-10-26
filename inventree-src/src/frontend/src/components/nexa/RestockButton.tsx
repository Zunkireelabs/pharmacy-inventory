import { t } from '@lingui/core/macro';
import {
  Alert,
  Button,
  Modal,
  NumberInput,
  Select,
  SimpleGrid,
  Stack,
  TextInput
} from '@mantine/core';
import { DateInput } from '@mantine/dates';
import { useMediaQuery } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { IconAlertCircle, IconPackageImport } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { api } from '../../App';
import { ProductPicker } from './ProductPicker';

function toIsoDate(value: Date | string | null): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

/** Stock locations (branches / shelves) for the "received into" selector. */
function useLocations() {
  return useQuery({
    queryKey: ['nexa-locations'],
    queryFn: async () => {
      const response = await api.get('/api/stock/location/', {
        params: { limit: 100 }
      });
      return (response.data.results ?? response.data).map((loc: any) => ({
        value: String(loc.pk),
        label: loc.pathstring || loc.name
      })) as { value: string; label: string }[];
    },
    staleTime: 60_000
  });
}

/**
 * Receive stock: records a NEW batch (batch code + expiry date) of a
 * medicine into a location. Each delivery is its own batch so that
 * earliest-expiry-first selling and expiry reports work per batch.
 */
export default function RestockButton({
  fullWidth
}: Readonly<{ fullWidth?: boolean }> = {}) {
  const isMobile = useMediaQuery('(max-width: 48em)');
  const queryClient = useQueryClient();
  const locations = useLocations();
  const [opened, setOpened] = useState(false);
  const [partId, setPartId] = useState<number | null>(null);
  const [batch, setBatch] = useState('');
  const [expiry, setExpiry] = useState<Date | string | null>(null);
  const [quantity, setQuantity] = useState<number | ''>('');
  const [price, setPrice] = useState<number | ''>('');
  const [location, setLocation] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);

  // Default to the first location once they load
  useEffect(() => {
    if (!location && locations.data && locations.data.length > 0) {
      setLocation(locations.data[0].value);
    }
  }, [locations.data, location]);

  const reset = () => {
    setPartId(null);
    setBatch('');
    setExpiry(null);
    setQuantity('');
    setPrice('');
    setErrorDetail(null);
  };

  const mutation = useMutation({
    mutationFn: async () => {
      setErrorDetail(null);
      return api.post('/api/stock/', {
        part: partId,
        quantity,
        batch: batch.trim(),
        expiry_date: toIsoDate(expiry),
        location: location ? Number(location) : undefined,
        purchase_price: price === '' ? undefined : price
      });
    },
    onSuccess: () => {
      notifications.show({ message: t`Stock received`, color: 'green' });
      queryClient.invalidateQueries({ queryKey: ['nexa-batches'] });
      setOpened(false);
      reset();
    },
    onError: (error: any) => {
      const data = error?.response?.data;
      const first =
        data && typeof data === 'object'
          ? Object.entries(data)
              .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(' ') : v}`)
              .join('; ')
          : null;
      setErrorDetail(first || t`Could not receive stock`);
    }
  });

  const canSubmit =
    !!partId &&
    !!batch.trim() &&
    !!expiry &&
    typeof quantity === 'number' &&
    quantity > 0 &&
    !!location;

  return (
    <>
      <Button
        variant='light'
        size='md'
        fullWidth={fullWidth}
        leftSection={<IconPackageImport size={18} />}
        onClick={() => setOpened(true)}
      >
        {t`Receive Stock`}
      </Button>
      <Modal
        opened={opened}
        onClose={() => {
          setOpened(false);
          reset();
        }}
        title={t`Receive Stock`}
        centered
        fullScreen={isMobile}
        closeOnClickOutside={false}
      >
        <Stack>
          {errorDetail && (
            <Alert color='red' icon={<IconAlertCircle size={16} />}>
              {errorDetail}
            </Alert>
          )}
          <ProductPicker
            value={partId}
            onChange={(id) => setPartId(id)}
          />
          <SimpleGrid cols={{ base: 1, xs: 2 }}>
            <TextInput
              label={t`Batch Number`}
              value={batch}
              onChange={(e) => setBatch(e.currentTarget.value)}
              required
            />
            <DateInput
              label={t`Expiry Date`}
              value={expiry}
              onChange={setExpiry}
              valueFormat='YYYY-MM-DD'
              required
            />
            <NumberInput
              label={t`Quantity Received`}
              value={quantity}
              onChange={(v) => setQuantity(v as number)}
              min={0}
              required
            />
            <NumberInput
              label={t`Cost per Unit`}
              value={price}
              onChange={(v) => setPrice(v as number)}
              min={0}
              decimalScale={2}
            />
          </SimpleGrid>
          <Select
            label={t`Received Into`}
            data={locations.data ?? []}
            value={location}
            onChange={setLocation}
            searchable
            required
            nothingFoundMessage={t`No stock locations — create one under Stock`}
          />
          <Button
            fullWidth
            disabled={!canSubmit}
            loading={mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {t`Add Stock`}
          </Button>
        </Stack>
      </Modal>
    </>
  );
}

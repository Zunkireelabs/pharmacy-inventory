import { t } from '@lingui/core/macro';
import {
  Alert,
  Button,
  Modal,
  NumberInput,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput
} from '@mantine/core';
import { DateInput } from '@mantine/dates';
import { useMediaQuery } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { IconAlertCircle, IconPackageImport } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { api } from '../../App';
import { formatMoney } from './format';
import { ProductPicker } from './ProductPicker';
import { SLOW_REQUEST } from './slow';

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

/** Suppliers for the "supplier" selector. */
function useSuppliers() {
  return useQuery({
    queryKey: ['nexa-suppliers'],
    queryFn: async () => {
      const response = await api.get('/api/company/', {
        params: { is_supplier: true, active: true, limit: 200 }
      });
      return (response.data.results ?? response.data).map((c: any) => ({
        value: String(c.pk),
        label: c.name
      })) as { value: string; label: string }[];
    },
    staleTime: 60_000
  });
}

const PAYMENT_STATUS = [
  { value: 'unpaid', label: t`Unpaid` },
  { value: 'partial', label: t`Partially Paid` },
  { value: 'paid', label: t`Paid` }
];

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
  const suppliers = useSuppliers();
  const [opened, setOpened] = useState(false);
  const [partId, setPartId] = useState<number | null>(null);
  const [batch, setBatch] = useState('');
  const [expiry, setExpiry] = useState<Date | string | null>(null);
  const [quantity, setQuantity] = useState<number | ''>('');
  const [price, setPrice] = useState<number | ''>('');
  const [bonus, setBonus] = useState<number | ''>('');
  const [discount, setDiscount] = useState<number | ''>('');
  const [tax, setTax] = useState<number | ''>('');
  const [supplier, setSupplier] = useState<string | null>(null);
  const [invoiceNo, setInvoiceNo] = useState('');
  const [purchaseDate, setPurchaseDate] = useState<Date | string | null>(new Date());
  const [paymentStatus, setPaymentStatus] = useState('unpaid');
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
    setBonus('');
    setDiscount('');
    setTax('');
    setInvoiceNo('');
    setErrorDetail(null);
  };

  const mutation = useMutation({
    mutationFn: async () => {
      setErrorDetail(null);
      return api.post('/plugin/nexainventory/receive-stock/', {
        part_id: partId,
        quantity,
        bonus_quantity: bonus === '' ? undefined : bonus,
        batch: batch.trim(),
        expiry_date: toIsoDate(expiry),
        location_id: location ? Number(location) : undefined,
        unit_cost: price === '' ? undefined : price,
        discount: discount === '' ? undefined : discount,
        tax: tax === '' ? undefined : tax,
        supplier_id: supplier ? Number(supplier) : undefined,
        invoice_no: invoiceNo.trim(),
        purchase_date: toIsoDate(purchaseDate),
        payment_status: paymentStatus
      }, SLOW_REQUEST);
    },
    onSuccess: () => {
      notifications.show({ message: t`Stock received`, color: 'green' });
      queryClient.invalidateQueries({ queryKey: ['nexa-batches'] });
      setOpened(false);
      reset();
    },
    onError: (error: any) => {
      setErrorDetail(
        error?.response?.data?.detail ?? t`Could not receive stock`
      );
    }
  });

  const lineTotal =
    (typeof quantity === 'number' ? quantity : 0) *
      (typeof price === 'number' ? price : 0) -
    (typeof discount === 'number' ? discount : 0) +
    (typeof tax === 'number' ? tax : 0);

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
          <SimpleGrid cols={{ base: 1, xs: 2 }}>
            <Select
              label={t`Supplier`}
              data={suppliers.data ?? []}
              value={supplier}
              onChange={setSupplier}
              searchable
              clearable
              nothingFoundMessage={t`No suppliers — add one under Purchasing`}
            />
            <TextInput
              label={t`Purchase Invoice No.`}
              value={invoiceNo}
              onChange={(e) => setInvoiceNo(e.currentTarget.value)}
            />
            <DateInput
              label={t`Purchase Date`}
              value={purchaseDate}
              onChange={setPurchaseDate}
              valueFormat='YYYY-MM-DD'
            />
            <Select
              label={t`Payment Status`}
              data={PAYMENT_STATUS}
              value={paymentStatus}
              onChange={(v) => setPaymentStatus(v ?? 'unpaid')}
              allowDeselect={false}
            />
          </SimpleGrid>
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
              label={t`Free / Bonus Quantity`}
              value={bonus}
              onChange={(v) => setBonus(v as number)}
              min={0}
            />
            <NumberInput
              label={t`Unit Purchase Cost`}
              value={price}
              onChange={(v) => setPrice(v as number)}
              min={0}
              decimalScale={2}
            />
            <NumberInput
              label={t`Discount`}
              value={discount}
              onChange={(v) => setDiscount(v as number)}
              min={0}
              decimalScale={2}
            />
            <NumberInput
              label={t`Tax`}
              value={tax}
              onChange={(v) => setTax(v as number)}
              min={0}
              decimalScale={2}
            />
          </SimpleGrid>
          <Text size='sm' c='dimmed'>
            {t`Line total`}: {formatMoney(Math.max(0, lineTotal))}
          </Text>
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

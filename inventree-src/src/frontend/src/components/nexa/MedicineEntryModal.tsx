import { t } from '@lingui/core/macro';
import {
  Alert,
  Button,
  Collapse,
  Divider,
  Modal,
  NumberInput,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  TextInput
} from '@mantine/core';
import { DateInput } from '@mantine/dates';
import { useMediaQuery } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import {
  IconAlertCircle,
  IconChevronDown,
  IconChevronUp
} from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

import { api } from '../../App';
import { useUserState } from '../../states/UserState';
import { formatMoney } from './format';
import {
  EMPTY_MONTH_YEAR,
  type MonthYear,
  MonthYearInput
} from './MonthYearInput';
import { ProductPicker, useBranches } from './ProductPicker';
import { SLOW_REQUEST } from './slow';

export type EntryMode = 'new' | 'existing';

const NEW_CATEGORY = '__new__';
const NEW_SUPPLIER = '__new_supplier__';

const PAYMENT_STATUS = [
  { value: 'unpaid', label: t`Unpaid` },
  { value: 'partial', label: t`Partially Paid` },
  { value: 'paid', label: t`Paid` }
];

type Supplier = {
  id: number;
  name: string;
  phone: string;
  dda_reg_no: string;
};

type Medicine = {
  description: string;
  generic_name: string;
  strength: string;
  brand: string;
  manufacturer: string;
  mrp: string | null;
};

function toIsoDate(value: Date | string | null): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

/** Sent with every save, so a repeated request (double click, retry) is harmless. */
function newRequestId() {
  return globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function num(value: number | ''): number | undefined {
  return value === '' ? undefined : value;
}

/** Suppliers with phone and DDA registration number. */
function useSuppliers() {
  return useQuery({
    queryKey: ['nexa-suppliers'],
    queryFn: async () => {
      const response = await api.get('/plugin/nexainventory/suppliers/');
      return (response.data ?? []) as Supplier[];
    },
    staleTime: 60_000
  });
}

function useCategories(enabled: boolean) {
  return useQuery({
    queryKey: ['nexa-categories'],
    enabled,
    queryFn: async () => {
      const response = await api.get('/api/part/category/', {
        params: { limit: 500 }
      });
      return (response.data.results ?? response.data).map((c: any) => ({
        value: String(c.pk),
        label: c.pathstring || c.name
      })) as { value: string; label: string }[];
    },
    staleTime: 60_000
  });
}

/**
 * One form for medicine entry, in the order of the pharmacy's purchase
 * sheet. "New medicine" creates the medicine and its first batch in one
 * save (or the medicine only, with "No stock yet"); "Existing medicine"
 * receives a new batch of a medicine that is already in the list. Each
 * delivery is its own batch, so earlier batches are never changed.
 */
export function MedicineEntryModal({
  opened,
  onClose,
  initialMode,
  initialCategoryId,
  onSaved
}: Readonly<{
  opened: boolean;
  onClose: () => void;
  initialMode: EntryMode;
  initialCategoryId?: number | string | null;
  onSaved?: () => void;
}>) {
  const isMobile = useMediaQuery('(max-width: 48em)');
  const queryClient = useQueryClient();
  const user = useUserState();
  const isStaff = user.isStaff() || user.isSuperuser();

  const [mode, setMode] = useState<EntryMode>(initialMode);
  const isNew = mode === 'new' && isStaff;

  const branches = useBranches();
  const suppliers = useSuppliers();
  const categories = useCategories(opened && isNew);

  // Medicine
  const [partId, setPartId] = useState<number | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  const [newCategory, setNewCategory] = useState('');
  const [brand, setBrand] = useState('');
  const [generic, setGeneric] = useState('');
  const [strength, setStrength] = useState('');
  const [description, setDescription] = useState('');
  const [manufacturer, setManufacturer] = useState('');
  const [noStock, setNoStock] = useState(false);
  // Batch
  const [batch, setBatch] = useState('');
  const [expiry, setExpiry] = useState<MonthYear>(EMPTY_MONTH_YEAR);
  const [quantity, setQuantity] = useState<number | ''>('');
  const [rate, setRate] = useState<number | ''>('');
  const [mrp, setMrp] = useState<number | ''>('');
  // Supplier
  const [supplierId, setSupplierId] = useState<string | null>(null);
  const [dda, setDda] = useState('');
  const [newSupplier, setNewSupplier] = useState({ name: '', phone: '', dda: '' });
  const addingSupplier = supplierId === NEW_SUPPLIER;
  // More details
  const [moreOpen, setMoreOpen] = useState(false);
  const [invoiceNo, setInvoiceNo] = useState('');
  const [purchaseDate, setPurchaseDate] = useState<Date | string | null>(new Date());
  const [paymentStatus, setPaymentStatus] = useState('unpaid');
  const [bonus, setBonus] = useState<number | ''>('');
  const [discount, setDiscount] = useState<number | ''>('');
  const [tax, setTax] = useState<number | ''>('');
  const [location, setLocation] = useState<string | null>(null);

  const [requestId, setRequestId] = useState(newRequestId);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);

  const withStock = !(isNew && noStock);

  useEffect(() => {
    if (opened) {
      setMode(initialMode);
      setCategory(initialCategoryId ? String(initialCategoryId) : null);
    }
  }, [opened, initialMode, initialCategoryId]);

  // With one branch it is picked for you; with several, staff must pick
  // one every time so stock never lands in the wrong branch by accident.
  useEffect(() => {
    if (!location && branches.data?.length === 1) {
      setLocation(branches.data[0].value);
    }
  }, [branches.data, location]);
  const branchName =
    branches.data?.find((b) => b.value === location)?.label ?? '';

  // Existing medicine: show its details (locked) and its current MRP
  const medicine = useQuery({
    queryKey: ['nexa-medicine-info', partId],
    enabled: !isNew && partId !== null,
    queryFn: async () => {
      const response = await api.get(`/plugin/nexainventory/medicine/${partId}/`);
      return response.data as Medicine;
    }
  });

  useEffect(() => {
    if (!isNew) {
      const current = medicine.data?.mrp;
      setMrp(current ? Number(current) : '');
    }
  }, [medicine.data, isNew]);

  const supplier = useMemo(
    () => (suppliers.data ?? []).find((s) => String(s.id) === supplierId),
    [suppliers.data, supplierId]
  );

  useEffect(() => {
    setDda(supplier?.dda_reg_no ?? '');
  }, [supplier]);

  const reset = () => {
    setLocation(null);
    setPartId(null);
    setNewCategory('');
    setBrand('');
    setGeneric('');
    setStrength('');
    setDescription('');
    setManufacturer('');
    setNoStock(false);
    setBatch('');
    setExpiry(EMPTY_MONTH_YEAR);
    setQuantity('');
    setRate('');
    setMrp('');
    setSupplierId(null);
    setNewSupplier({ name: '', phone: '', dda: '' });
    setInvoiceNo('');
    setBonus('');
    setDiscount('');
    setTax('');
    setMoreOpen(false);
    setErrorDetail(null);
    setRequestId(newRequestId());
  };

  const close = () => {
    onClose();
    reset();
  };

  const mutation = useMutation({
    mutationFn: async () => {
      setErrorDetail(null);

      // The supplier's DDA number lives on the supplier record
      if (withStock && supplier && isStaff && dda.trim() !== supplier.dda_reg_no) {
        await api.patch(`/plugin/nexainventory/suppliers/${supplier.id}/`, {
          dda_reg_no: dda.trim()
        });
        queryClient.invalidateQueries({ queryKey: ['nexa-suppliers'] });
      }

      const line = withStock
        ? {
            batch: batch.trim(),
            expiry_month: expiry.month,
            expiry_year: expiry.year,
            quantity,
            unit_cost: num(rate),
            supplier_id:
              supplierId && !addingSupplier ? Number(supplierId) : undefined,
            // a new supplier is created in the same save (staff only)
            ...(addingSupplier
              ? {
                  new_supplier_name: newSupplier.name.trim(),
                  new_supplier_phone: newSupplier.phone.trim(),
                  new_supplier_dda: newSupplier.dda.trim()
                }
              : {}),
            location_id: location ? Number(location) : undefined,
            bonus_quantity: num(bonus),
            discount: num(discount),
            tax: num(tax),
            invoice_no: invoiceNo.trim(),
            purchase_date: toIsoDate(purchaseDate),
            payment_status: paymentStatus
          }
        : {};

      if (isNew) {
        return api.post(
          '/plugin/nexainventory/add-medicine/',
          {
            category_id:
              category && category !== NEW_CATEGORY ? Number(category) : undefined,
            new_category_name:
              category === NEW_CATEGORY ? newCategory.trim() : undefined,
            brand: brand.trim(),
            generic_name: generic.trim(),
            strength: strength.trim(),
            description: description.trim(),
            manufacturer: manufacturer.trim(),
            mrp: num(mrp),
            no_stock: noStock,
            request_id: requestId,
            ...line
          },
          SLOW_REQUEST
        );
      }

      return api.post(
        '/plugin/nexainventory/receive-stock/',
        {
          part_id: partId,
          // only staff can change the MRP; others send nothing
          mrp: isStaff ? num(mrp) : undefined,
          request_id: requestId,
          ...line
        },
        SLOW_REQUEST
      );
    },
    onSuccess: () => {
      notifications.show({
        message: isNew
          ? noStock
            ? t`Product added`
            : t`Product and stock added to ${branchName}`
          : t`Stock received at ${branchName}`,
        color: 'green'
      });
      for (const key of [
        'nexa-batches',
        'nexa-purchases',
        'nexa-part-picker',
        'nexa-medicine-info',
        'nexa-medicine',
        'nexa-medicine-details',
        'nexa-dashboard-expiry',
        'nexa-categories',
        'nexa-suppliers'
      ]) {
        queryClient.invalidateQueries({ queryKey: [key] });
      }
      onSaved?.();
      close();
    },
    onError: (error: any) => {
      setErrorDetail(
        error?.response?.data?.detail ?? t`Could not save — please try again`
      );
    }
  });

  const lineTotal =
    (typeof quantity === 'number' ? quantity : 0) *
      (typeof rate === 'number' ? rate : 0) -
    (typeof discount === 'number' ? discount : 0) +
    (typeof tax === 'number' ? tax : 0);

  const medicineReady = isNew
    ? !!brand.trim() && (category !== NEW_CATEGORY || !!newCategory.trim())
    : partId !== null;
  const stockReady =
    !withStock ||
    (!!batch.trim() &&
      !!expiry.month &&
      !!expiry.year &&
      typeof quantity === 'number' &&
      quantity > 0 &&
      !!location &&
      (!addingSupplier || !!newSupplier.name.trim()));
  const canSubmit = medicineReady && stockReady && !mutation.isPending;

  const locked = medicine.data;

  return (
    <Modal
      opened={opened}
      onClose={close}
      title={isNew ? t`New Product` : t`Receive Stock`}
      centered
      size='lg'
      fullScreen={isMobile}
      closeOnClickOutside={false}
    >
      <Stack>
        {errorDetail && (
          <Alert color='red' icon={<IconAlertCircle size={16} />}>
            {errorDetail}
          </Alert>
        )}

        {isStaff && (
          <SegmentedControl
            fullWidth
            value={mode}
            onChange={(v) => {
              setMode(v as EntryMode);
              setErrorDetail(null);
            }}
            data={[
              { value: 'new', label: t`New product` },
              { value: 'existing', label: t`Existing product` }
            ]}
          />
        )}

        <Divider label={t`Product`} labelPosition='left' />
        {isNew ? (
          <>
            <Select
              label={t`Category`}
              placeholder={t`Select a category (optional)`}
              data={[
                ...(categories.data ?? []),
                { value: NEW_CATEGORY, label: t`+ New category` }
              ]}
              value={category}
              onChange={setCategory}
              searchable
              clearable
            />
            {category === NEW_CATEGORY && (
              <TextInput
                label={t`New category name`}
                value={newCategory}
                onChange={(e) => setNewCategory(e.currentTarget.value)}
                required
              />
            )}
            <TextInput
              label={t`Product`}
              placeholder={t`e.g. Nico`}
              value={brand}
              onChange={(e) => setBrand(e.currentTarget.value)}
              required
            />
            <SimpleGrid cols={{ base: 1, xs: 2 }}>
              <TextInput
                label={t`Generic Name`}
                placeholder={t`e.g. Paracetamol`}
                value={generic}
                onChange={(e) => setGeneric(e.currentTarget.value)}
              />
              <TextInput
                label={t`Strength`}
                placeholder={t`e.g. 500 mg`}
                value={strength}
                onChange={(e) => setStrength(e.currentTarget.value)}
              />
            </SimpleGrid>
            <TextInput
              label={t`Description`}
              placeholder={t`e.g. For fever and pain, after food`}
              value={description}
              onChange={(e) => setDescription(e.currentTarget.value)}
              maxLength={250}
            />
            <Switch
              label={t`No stock yet (add the product only)`}
              checked={noStock}
              onChange={(e) => setNoStock(e.currentTarget.checked)}
            />
          </>
        ) : (
          <>
            <ProductPicker value={partId} onChange={(id) => setPartId(id)} />
            {locked && (
              <SimpleGrid cols={{ base: 1, xs: 2 }}>
                <TextInput label={t`Generic Name`} value={locked.generic_name || '-'} disabled />
                <TextInput label={t`Strength`} value={locked.strength || '-'} disabled />
                <TextInput
                  label={t`Description`}
                  value={locked.description || '-'}
                  disabled
                  style={{ gridColumn: '1 / -1' }}
                />
              </SimpleGrid>
            )}
          </>
        )}

        {withStock && (
          <>
            <Divider label={t`Batch`} labelPosition='left' />
            <Select
              label={t`Branch`}
              description={t`Which branch is this stock going to?`}
              placeholder={t`Pick a branch`}
              data={branches.data ?? []}
              value={location}
              onChange={setLocation}
              allowDeselect={false}
              required
              nothingFoundMessage={t`No branches yet — add one under Stock`}
            />
            <SimpleGrid cols={{ base: 1, xs: 2 }}>
              <TextInput
                label={t`Batch No.`}
                value={batch}
                onChange={(e) => setBatch(e.currentTarget.value)}
                required
              />
              <MonthYearInput
                label={t`Expiry`}
                value={expiry}
                onChange={setExpiry}
                required
              />
              <NumberInput
                label={t`Quantity`}
                value={quantity}
                onChange={(v) => setQuantity(v as number)}
                min={0}
                required
              />
              <NumberInput
                label={t`Purchase Rate (per unit)`}
                value={rate}
                onChange={(v) => setRate(v as number)}
                min={0}
                decimalScale={2}
              />
            </SimpleGrid>
          </>
        )}

        <NumberInput
          label={t`MRP (per unit)`}
          value={mrp}
          onChange={(v) => setMrp(v as number)}
          min={0}
          decimalScale={2}
          disabled={!isStaff}
          description={
            !isNew && isStaff ? t`Changing it updates this product's MRP` : undefined
          }
        />

        <Divider
          label={withStock ? t`Supplier & manufacturer` : t`Manufacturer`}
          labelPosition='left'
        />
        {withStock && (
          <>
            <Select
              label={t`Supplier`}
              data={[
                ...(suppliers.data ?? []).map((s) => ({
                  value: String(s.id),
                  label: s.name
                })),
                ...(isStaff ? [{ value: NEW_SUPPLIER, label: t`+ New supplier` }] : [])
              ]}
              value={supplierId}
              onChange={setSupplierId}
              searchable
              clearable
              nothingFoundMessage={t`No suppliers — add one under Purchasing`}
            />
            {addingSupplier && (
              <SimpleGrid cols={{ base: 1, xs: 3 }}>
                <TextInput
                  label={t`Supplier Name`}
                  value={newSupplier.name}
                  onChange={(e) => {
                    const name = e.currentTarget.value;
                    setNewSupplier((n) => ({ ...n, name }));
                  }}
                  maxLength={100}
                  required
                />
                <TextInput
                  label={t`Supplier Phone`}
                  value={newSupplier.phone}
                  onChange={(e) => {
                    const phone = e.currentTarget.value;
                    setNewSupplier((n) => ({ ...n, phone }));
                  }}
                  maxLength={50}
                />
                <TextInput
                  label={t`Supplier DDA Reg. No.`}
                  value={newSupplier.dda}
                  onChange={(e) => {
                    const dda = e.currentTarget.value;
                    setNewSupplier((n) => ({ ...n, dda }));
                  }}
                  maxLength={100}
                />
              </SimpleGrid>
            )}
            {supplier && (
              <SimpleGrid cols={{ base: 1, xs: 2 }}>
                <TextInput
                  label={t`Supplier Phone`}
                  value={supplier.phone || '-'}
                  disabled
                />
                <TextInput
                  label={t`Supplier DDA Reg. No.`}
                  value={dda}
                  onChange={(e) => setDda(e.currentTarget.value)}
                  disabled={!isStaff}
                  description={
                    isStaff ? t`Saved on the supplier for next time` : undefined
                  }
                />
              </SimpleGrid>
            )}
          </>
        )}
        {isNew ? (
          <TextInput
            label={t`Manufacturer`}
            value={manufacturer}
            onChange={(e) => setManufacturer(e.currentTarget.value)}
          />
        ) : (
          locked && (
            <TextInput label={t`Manufacturer`} value={locked.manufacturer || '-'} disabled />
          )
        )}

        {withStock && (
          <>
            <Button
              variant='subtle'
              size='compact-sm'
              onClick={() => setMoreOpen((o) => !o)}
              rightSection={
                moreOpen ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />
              }
              style={{ alignSelf: 'flex-start' }}
            >
              {t`More details (supplier invoice, free qty, discount, tax)`}
            </Button>
            <Collapse expanded={moreOpen}>
              <SimpleGrid cols={{ base: 1, xs: 2 }}>
                <TextInput
                  label={t`Supplier Invoice No.`}
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
                <NumberInput
                  label={t`Free Qty`}
                  value={bonus}
                  onChange={(v) => setBonus(v as number)}
                  min={0}
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
            </Collapse>
            <Text size='sm' c='dimmed'>
              {t`Line total`}: {formatMoney(Math.max(0, lineTotal))}
            </Text>
          </>
        )}

        <Button
          fullWidth
          disabled={!canSubmit}
          loading={mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          {isNew ? (noStock ? t`Save Product` : t`Save Product & Stock`) : t`Add Stock`}
        </Button>
      </Stack>
    </Modal>
  );
}

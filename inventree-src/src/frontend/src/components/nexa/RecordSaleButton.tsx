import { t } from '@lingui/core/macro';
import {
  ActionIcon,
  Alert,
  Button,
  Divider,
  Group,
  Modal,
  NumberInput,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Textarea,
  ThemeIcon
} from '@mantine/core';
import { DateInput } from '@mantine/dates';
import { useMediaQuery } from '@mantine/hooks';
import {
  IconAlertCircle,
  IconCash,
  IconCircleCheck,
  IconPill,
  IconPlus,
  IconReceipt2,
  IconTrash,
  IconWorld
} from '@tabler/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { api } from '../../App';
import { CustomerPicker } from './CustomerPicker';
import { formatMoney } from './format';
import {
  BatchPreview,
  ProductPicker,
  flagsFor,
  sellableQuantity,
  useBatches,
  useBranches,
  useMedicineFlags
} from './ProductPicker';
import { TransactionStatusBadge } from './TransactionStatusBadge';
import { TransactionTypeCard } from './TransactionTypeCard';
import { SLOW_REQUEST } from './slow';

type SaleType = 'b2b_credit' | 'b2c_cash' | 'b2c_online' | 'prescription';

const TYPE_OPTIONS: {
  value: SaleType;
  label: string;
  icon: React.ReactNode;
  color: string;
}[] = [
  {
    value: 'b2c_cash',
    label: t`Cash Sale (OTC)`,
    icon: <IconCash size={28} />,
    color: 'green'
  },
  {
    value: 'prescription',
    label: t`Prescription`,
    icon: <IconPill size={28} />,
    color: 'orange'
  },
  {
    value: 'b2b_credit',
    label: t`Credit Sale`,
    icon: <IconReceipt2 size={28} />,
    color: 'blue'
  },
  {
    value: 'b2c_online',
    label: t`Online / Mobile`,
    icon: <IconWorld size={28} />,
    color: 'teal'
  }
];

type LineItem = {
  key: string;
  partId: number | null;
  partName: string | null;
  quantity: number | '';
  unitValue: number | '';
  // filled in by LineEditor once batches / flags are known
  sellable: number | null;
  rx: boolean;
  controlled: boolean;
};

function newLine(): LineItem {
  return {
    key: Math.random().toString(36).slice(2),
    partId: null,
    partName: null,
    quantity: '',
    unitValue: '',
    sellable: null,
    rx: false,
    controlled: false
  };
}

/**
 * One product line: medicine picker, the batches that will be used (earliest
 * expiry first), quantity and price. Reports sellable stock and the
 * prescription flags up to the form for validation.
 */
function LineEditor({
  line,
  index,
  count,
  branchId,
  onChange,
  onRemove
}: Readonly<{
  line: LineItem;
  index: number;
  count: number;
  branchId: string | null;
  onChange: (patch: Partial<LineItem>) => void;
  onRemove: () => void;
}>) {
  const batches = useBatches(line.partId, branchId);
  const flags = flagsFor(useMedicineFlags(), line.partId);
  const sellable = line.partId === null ? null : sellableQuantity(batches.data);

  // Prefill the unit price from the medicine's selling price (editable)
  const info = useQuery({
    queryKey: ['nexa-medicine', line.partId],
    enabled: line.partId !== null,
    queryFn: async () =>
      (await api.get(`/plugin/nexainventory/medicine/${line.partId}/`)).data
  });
  const sellingPrice = info.data?.selling_price;

  useEffect(() => {
    if (sellingPrice && line.unitValue === '') {
      onChange({ unitValue: Number(sellingPrice) });
    }
  }, [sellingPrice, line.partId]);

  useEffect(() => {
    if (
      line.sellable !== sellable ||
      line.rx !== flags.requiresPrescription ||
      line.controlled !== flags.isControlled
    ) {
      onChange({
        sellable,
        rx: flags.requiresPrescription,
        controlled: flags.isControlled
      });
    }
  }, [sellable, flags.requiresPrescription, flags.isControlled]);

  const tooMany =
    typeof line.quantity === 'number' &&
    sellable !== null &&
    line.quantity > sellable;

  return (
    <Stack gap='xs'>
      {count > 1 && (
        <Group justify='space-between'>
          <Text size='xs' c='dimmed' fw={700}>
            {t`Medicine`} {index + 1}
          </Text>
          <ActionIcon
            color='red'
            variant='subtle'
            size='sm'
            onClick={onRemove}
            aria-label={t`Remove medicine`}
          >
            <IconTrash size={14} />
          </ActionIcon>
        </Group>
      )}
      <ProductPicker
        value={line.partId}
        onChange={(partId, partName) =>
          onChange({
            partId,
            partName,
            sellable: null,
            quantity: '',
            unitValue: ''
          })
        }
      />
      {line.partId !== null && <BatchPreview batches={batches.data} />}
      <SimpleGrid cols={{ base: 1, xs: 2 }}>
        <NumberInput
          label={t`Quantity`}
          value={line.quantity}
          onChange={(v) => onChange({ quantity: v as number })}
          min={0}
          required
          error={tooMany ? t`More than the ${sellable} available` : undefined}
        />
        <NumberInput
          label={t`Unit Value`}
          value={line.unitValue}
          onChange={(v) => onChange({ unitValue: v as number })}
          min={0}
          decimalScale={2}
          required
        />
      </SimpleGrid>
      {index < count - 1 && <Divider variant='dashed' />}
    </Stack>
  );
}

type BillLine = { particulars: string; batch: string; quantity: string; amount: string };

type SuccessState =
  | { kind: 'b2b'; reference: string; total: string; outstanding: string; invoiceId: number }
  | {
      kind: 'bill';
      saleType: SaleType;
      billId: number;
      reference: string;
      lines: BillLine[];
      subtotal: string;
      discount: string;
      net: string;
    };

const PAYMENT_MODES = [
  { value: 'cash', label: t`Cash` },
  { value: 'online', label: t`Online` },
  { value: 'qr', label: t`QR` },
  { value: 'other', label: t`Other` }
];

const INITIAL_FORM = {
  customerId: null as number | null,
  dueDate: null as string | null,
  notes: '',
  prescriber: '',
  prescriptionRef: '',
  customerName: '',
  customerPhone: '',
  customerAddress: '',
  customerPan: '',
  branchId: null as string | null,
  paymentMode: 'cash',
  discount: '' as number | '',
  discountReason: ''
};

/**
 * The primary "New Sale" workflow — one button, one modal, a large 4-way
 * type selector (not a dropdown), a repeatable line-item cart (multiple
 * products in one sale), and a success state. Built with plain Mantine
 * inputs + a direct mutation rather than the generic ApiForm wrapper:
 * ApiForm is schema/OPTIONS-driven and meant for CRUD-style forms, whereas
 * this screen needs bespoke layout (live running total, inline stock
 * availability, type-conditional fields, a custom success panel) that's
 * simpler to build directly than to bend a generic form renderer around.
 *
 * B2B credit sends all lines in one atomic request (one invoice, one
 * InvoiceLineItem per line). Cash/Online have no grouping document —
 * each line is its own independent stock movement, so those are recorded
 * with one record-sale/ call per line, sequentially.
 */
export default function RecordSaleButton({
  onSuccess,
  fullWidth
}: Readonly<{ onSuccess?: () => void; fullWidth?: boolean }>) {
  const navigate = useNavigate();
  const isMobile = useMediaQuery('(max-width: 48em)');
  const [opened, setOpened] = useState(false);
  const [saleType, setSaleType] = useState<SaleType>('b2c_cash');
  const [lines, setLines] = useState<LineItem[]>([newLine()]);
  const [form, setForm] = useState(INITIAL_FORM);
  const [success, setSuccess] = useState<SuccessState | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);

  const isB2B = saleType === 'b2b_credit';

  // Default to the first branch once they load
  const branches = useBranches();
  useEffect(() => {
    if (!form.branchId && branches.data && branches.data.length > 0) {
      setForm((f) => ({ ...f, branchId: branches.data[0].value }));
    }
  }, [branches.data, form.branchId]);

  const updateLine = (key: string, patch: Partial<LineItem>) => {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  };

  const removeLine = (key: string) => {
    setLines((ls) => (ls.length > 1 ? ls.filter((l) => l.key !== key) : ls));
  };

  const lineTotal = (l: LineItem) =>
    (typeof l.quantity === 'number' ? l.quantity : 0) *
    (typeof l.unitValue === 'number' ? l.unitValue : 0);

  const runningTotal = lines.reduce((sum, l) => sum + lineTotal(l), 0);

  const linesValid = lines.every(
    (l) =>
      !!l.partId &&
      typeof l.quantity === 'number' &&
      l.quantity > 0 &&
      (l.sellable === null || l.quantity <= l.sellable) &&
      typeof l.unitValue === 'number' &&
      l.unitValue > 0
  );

  const isRx = saleType === 'prescription';
  const anyRx = lines.some((l) => l.rx || l.controlled);
  const otcBlockedByRx =
    (saleType === 'b2c_cash' || saleType === 'b2c_online') && anyRx;
  const rxFieldsMissing =
    isRx && (!form.prescriber.trim() || !form.prescriptionRef.trim());

  const discountValue = typeof form.discount === 'number' ? form.discount : 0;
  const discountInvalid =
    !isB2B &&
    (discountValue < 0 ||
      discountValue > runningTotal ||
      (discountValue > 0 && !form.discountReason.trim()));
  const netTotal = Math.max(0, runningTotal - (isB2B ? 0 : discountValue));

  const canSubmit =
    linesValid &&
    !discountInvalid &&
    (!isB2B || !!form.customerId) &&
    !otcBlockedByRx &&
    !rxFieldsMissing;

  const mutation = useMutation({
    mutationFn: async () => {
      setErrorDetail(null);

      if (isB2B) {
        const response = await api.post('/plugin/nexainventory/record-b2b-sale/', {
          items: lines.map((l) => ({
            part_id: l.partId,
            quantity: l.quantity,
            unit_value: l.unitValue || 0
          })),
          customer_id: form.customerId,
          branch_id: form.branchId ? Number(form.branchId) : undefined,
          due_date: form.dueDate || undefined,
          notes: form.notes
        }, SLOW_REQUEST);
        return { kind: 'b2b' as const, data: response.data };
      }

      const response = await api.post('/plugin/nexainventory/record-bill/', {
        sale_type: saleType,
        branch_id: form.branchId ? Number(form.branchId) : undefined,
        items: lines.map((l) => ({
          part_id: l.partId,
          quantity: l.quantity,
          unit_value: l.unitValue || 0
        })),
        customer_name: form.customerName.trim(),
        customer_phone: form.customerPhone.trim(),
        customer_address: form.customerAddress.trim(),
        customer_pan: form.customerPan.trim(),
        payment_mode: form.paymentMode,
        discount: discountValue || undefined,
        discount_reason: form.discountReason.trim(),
        remarks: form.notes,
        prescriber: isRx ? form.prescriber.trim() : undefined,
        prescription_ref: isRx ? form.prescriptionRef.trim() : undefined
      }, SLOW_REQUEST);
      return { kind: 'bill' as const, data: response.data };
    },
    onSuccess: (result) => {
      if (result.kind === 'b2b') {
        setSuccess({
          kind: 'b2b',
          reference: result.data.reference,
          total: result.data.total,
          outstanding: result.data.outstanding,
          invoiceId: result.data.invoice_id
        });
      } else {
        const bill = result.data;
        setSuccess({
          kind: 'bill',
          saleType,
          billId: bill.id,
          reference: bill.reference,
          lines: bill.lines.map((l: any) => ({
            particulars: l.particulars,
            batch: l.batch,
            quantity: l.quantity,
            amount: l.amount
          })),
          subtotal: bill.subtotal,
          discount: bill.discount,
          net: bill.net_amount
        });
      }
      onSuccess?.();
    },
    onError: (error: any) => {
      setErrorDetail(
        error?.response?.data?.detail ?? t`Something went wrong recording this sale`
      );
    }
  });

  const resetForNewSale = () => {
    setLines([newLine()]);
    setForm(INITIAL_FORM);
    setSuccess(null);
    setErrorDetail(null);
  };

  const closeModal = () => {
    setOpened(false);
    resetForNewSale();
  };

  return (
    <>
      <Button
        size='md'
        fullWidth={fullWidth}
        onClick={() => setOpened(true)}
        leftSection={<IconReceipt2 size={18} />}
      >
        {t`New Sale`}
      </Button>

      <Modal
        opened={opened}
        onClose={closeModal}
        title={t`New Sale`}
        size='lg'
        centered
        fullScreen={isMobile}
        // On mobile, Chrome's native autofill suggestion strip (passwords/
        // payment/addresses) popping up above the keyboard while typing in
        // Customer/Product search causes a focus/touch event that Mantine
        // was reading as a click outside the modal, closing and reopening
        // it on every keystroke - visible as the whole screen flickering
        // back to the dashboard. The form has an explicit close (X) button,
        // so disabling outside-click dismissal here is safe.
        closeOnClickOutside={false}
      >
        {success ? (
          <Stack align='center' py='md'>
            <ThemeIcon color='green' size={56} radius='xl' variant='light'>
              <IconCircleCheck size={32} />
            </ThemeIcon>
            {success.kind === 'b2b' ? (
              <Stack align='center' gap={4}>
                <Text fw={700} size='lg'>
                  {t`Invoice ${success.reference} created`}
                </Text>
                <Text c='dimmed'>
                  {t`Total`}: {formatMoney(success.total)} · {t`Outstanding`}:{' '}
                  {formatMoney(success.outstanding)}
                </Text>
              </Stack>
            ) : (
              <Stack align='center' gap={4}>
                <Group gap='xs'>
                  <TransactionStatusBadge saleType={success.saleType} />
                  <Text fw={700} size='lg'>
                    {t`Bill ${success.reference} saved`}
                  </Text>
                </Group>
                <Stack gap={0} align='center'>
                  {success.lines.map((l, i) => (
                    <Text key={i} c='dimmed' size='sm'>
                      {l.particulars} ({l.batch || '-'}) × {l.quantity} —{' '}
                      {formatMoney(l.amount)}
                    </Text>
                  ))}
                </Stack>
                {Number(success.discount) > 0 && (
                  <Text size='sm' c='dimmed'>
                    {t`Discount`}: −{formatMoney(success.discount)}
                  </Text>
                )}
                <Text fw={700} size='lg'>
                  {t`Net Amount`}: {formatMoney(success.net)}
                </Text>
              </Stack>
            )}

            <Group mt='md'>
              <Button variant='light' onClick={resetForNewSale}>
                {t`New Sale`}
              </Button>
              {success.kind === 'b2b' && (
                <Button
                  onClick={() => {
                    closeModal();
                    navigate(`/receivables/invoice/${success.invoiceId}`);
                  }}
                >
                  {t`View Invoice`}
                </Button>
              )}
              {success.kind === 'bill' && (
                <Button
                  onClick={() => {
                    closeModal();
                    navigate(`/bills/${success.billId}`);
                  }}
                >
                  {t`View / Print Bill`}
                </Button>
              )}
            </Group>
          </Stack>
        ) : (
          <Stack>
            <SimpleGrid cols={{ base: 2, sm: 4 }} spacing='xs'>
              {TYPE_OPTIONS.map((opt) => (
                <TransactionTypeCard
                  key={opt.value}
                  label={opt.label}
                  icon={opt.icon}
                  color={opt.color}
                  active={saleType === opt.value}
                  onClick={() => setSaleType(opt.value)}
                />
              ))}
            </SimpleGrid>

            <Divider />

            {errorDetail && (
              <Alert color='red' icon={<IconAlertCircle size={16} />}>
                {errorDetail}
              </Alert>
            )}

            {(branches.data?.length ?? 0) > 0 && (
              <Select
                label={t`Branch`}
                data={branches.data ?? []}
                value={form.branchId}
                onChange={(v) => setForm((f) => ({ ...f, branchId: v }))}
                allowDeselect={false}
              />
            )}

            {isB2B && (
              <CustomerPicker
                value={form.customerId}
                onChange={(customerId) => setForm((f) => ({ ...f, customerId }))}
              />
            )}

            <Stack gap='md'>
              {lines.map((line, index) => (
                <LineEditor
                  key={line.key}
                  line={line}
                  index={index}
                  count={lines.length}
                  branchId={form.branchId}
                  onChange={(patch) => updateLine(line.key, patch)}
                  onRemove={() => removeLine(line.key)}
                />
              ))}

              <Button
                variant='subtle'
                size='sm'
                leftSection={<IconPlus size={16} />}
                onClick={() => setLines((ls) => [...ls, newLine()])}
              >
                {t`Add Medicine`}
              </Button>
            </Stack>

            {otcBlockedByRx && (
              <Alert color='orange' icon={<IconAlertCircle size={16} />}>
                {t`Prescription-only medicine in this sale. Choose Prescription as the sale type.`}
              </Alert>
            )}

            {isRx && (
              <SimpleGrid cols={{ base: 1, xs: 2 }}>
                <TextInput
                  label={t`Prescriber`}
                  placeholder={t`Doctor's name`}
                  value={form.prescriber}
                  onChange={(e) => {
                    const value = e.currentTarget.value;
                    setForm((f) => ({ ...f, prescriber: value }));
                  }}
                  required
                />
                <TextInput
                  label={t`NMC Number`}
                  placeholder={t`Doctor's NMC registration no.`}
                  value={form.prescriptionRef}
                  onChange={(e) => {
                    const value = e.currentTarget.value;
                    setForm((f) => ({ ...f, prescriptionRef: value }));
                  }}
                  required
                />
              </SimpleGrid>
            )}

            {isB2B && (
              <DateInput
                label={t`Due Date`}
                placeholder={t`Defaults to 30 days from today`}
                value={form.dueDate}
                onChange={(v) => setForm((f) => ({ ...f, dueDate: v }))}
                clearable
              />
            )}

            {!isB2B && (
              <>
                <SimpleGrid cols={{ base: 1, xs: 2 }}>
                  <TextInput
                    label={t`Customer Name`}
                    value={form.customerName}
                    onChange={(e) => {
                    const value = e.currentTarget.value;
                    setForm((f) => ({ ...f, customerName: value }));
                  }}
                  />
                  <TextInput
                    label={t`Phone`}
                    value={form.customerPhone}
                    onChange={(e) => {
                    const value = e.currentTarget.value;
                    setForm((f) => ({ ...f, customerPhone: value }));
                  }}
                  />
                  <TextInput
                    label={t`Address`}
                    value={form.customerAddress}
                    onChange={(e) => {
                    const value = e.currentTarget.value;
                    setForm((f) => ({ ...f, customerAddress: value }));
                  }}
                  />
                  <TextInput
                    label={t`Customer PAN`}
                    value={form.customerPan}
                    onChange={(e) => {
                    const value = e.currentTarget.value;
                    setForm((f) => ({ ...f, customerPan: value }));
                  }}
                  />
                </SimpleGrid>
                <SimpleGrid cols={{ base: 1, xs: 3 }}>
                  <Select
                    label={t`Payment Mode`}
                    data={PAYMENT_MODES}
                    value={form.paymentMode}
                    onChange={(v) =>
                      setForm((f) => ({ ...f, paymentMode: v ?? 'cash' }))
                    }
                    allowDeselect={false}
                  />
                  <NumberInput
                    label={t`Discount`}
                    value={form.discount}
                    onChange={(v) => setForm((f) => ({ ...f, discount: v as number }))}
                    min={0}
                    decimalScale={2}
                    error={
                      discountValue > runningTotal
                        ? t`More than the bill total`
                        : undefined
                    }
                  />
                  <TextInput
                    label={t`Reason for Discount`}
                    value={form.discountReason}
                    onChange={(e) => {
                    const value = e.currentTarget.value;
                    setForm((f) => ({ ...f, discountReason: value }));
                  }}
                    required={discountValue > 0}
                  />
                </SimpleGrid>
              </>
            )}

            <Textarea
              label={t`Notes`}
              value={form.notes}
              onChange={(e) => {
                    const value = e.currentTarget.value;
                    setForm((f) => ({ ...f, notes: value }));
                  }}
              autosize
              minRows={1}
            />

            <Divider />

            {!isB2B && discountValue > 0 && (
              <Group justify='space-between'>
                <Text size='sm' c='dimmed'>
                  {t`Sub-total`}: {formatMoney(runningTotal)}
                </Text>
                <Text size='sm' c='dimmed'>
                  {t`Discount`}: −{formatMoney(discountValue)}
                </Text>
              </Group>
            )}
            <Group justify='space-between' align='center'>
              <Text size='sm' c='dimmed'>
                {isB2B ? t`Total` : t`Net Amount`}
              </Text>
              <Text size='xl' fw={800}>
                {formatMoney(netTotal)}
              </Text>
            </Group>

            <Button
              size='md'
              fullWidth
              disabled={!canSubmit}
              loading={mutation.isPending}
              onClick={() => mutation.mutate()}
            >
              {t`Complete Sale`}
            </Button>
          </Stack>
        )}
      </Modal>
    </>
  );
}

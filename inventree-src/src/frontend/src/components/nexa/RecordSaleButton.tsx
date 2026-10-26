import { t } from '@lingui/core/macro';
import {
  ActionIcon,
  Alert,
  Button,
  Divider,
  Group,
  Modal,
  NumberInput,
  SimpleGrid,
  Stack,
  Text,
  Textarea,
  ThemeIcon
} from '@mantine/core';
import { DateInput } from '@mantine/dates';
import { useMediaQuery } from '@mantine/hooks';
import {
  IconAlertCircle,
  IconCash,
  IconCircleCheck,
  IconGift,
  IconPlus,
  IconReceipt2,
  IconTrash,
  IconWorld
} from '@tabler/icons-react';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { api } from '../../App';
import { CustomerPicker } from './CustomerPicker';
import { formatMoney } from './format';
import { ProductPicker, StockAvailabilityHint } from './ProductPicker';
import { TransactionStatusBadge } from './TransactionStatusBadge';
import { TransactionTypeCard } from './TransactionTypeCard';

type SaleType = 'b2b_credit' | 'b2c_cash' | 'b2c_online' | 'gift';

const TYPE_OPTIONS: {
  value: SaleType;
  label: string;
  icon: React.ReactNode;
  color: string;
}[] = [
  {
    value: 'b2b_credit',
    label: t`B2B Credit`,
    icon: <IconReceipt2 size={28} />,
    color: 'blue'
  },
  {
    value: 'b2c_cash',
    label: t`Cash Sale`,
    icon: <IconCash size={28} />,
    color: 'green'
  },
  {
    value: 'b2c_online',
    label: t`Online Sale`,
    icon: <IconWorld size={28} />,
    color: 'teal'
  },
  {
    value: 'gift',
    label: t`Gift`,
    icon: <IconGift size={28} />,
    color: 'grape'
  }
];

type LineItem = {
  key: string;
  stockItemId: number | null;
  stockQty: number | null;
  partName: string | null;
  quantity: number | '';
  unitValue: number | '';
};

function newLine(): LineItem {
  return {
    key: Math.random().toString(36).slice(2),
    stockItemId: null,
    stockQty: null,
    partName: null,
    quantity: '',
    unitValue: ''
  };
}

type MovementSummary = { partName: string; quantity: string; total: string };

type SuccessState =
  | { kind: 'b2b'; reference: string; total: string; outstanding: string; invoiceId: number }
  | { kind: 'movement'; saleType: SaleType; lines: MovementSummary[]; total: string };

const INITIAL_FORM = {
  customerId: null as number | null,
  dueDate: null as string | null,
  notes: ''
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
 * InvoiceLineItem per line). Cash/Online/Gift have no grouping document —
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
  const isGift = saleType === 'gift';

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
      !!l.stockItemId &&
      typeof l.quantity === 'number' &&
      l.quantity > 0 &&
      typeof l.unitValue === 'number' &&
      l.unitValue > 0
  );

  const canSubmit = linesValid && (!isB2B || !!form.customerId);

  const mutation = useMutation({
    mutationFn: async () => {
      setErrorDetail(null);

      if (isB2B) {
        const response = await api.post('/plugin/nexainventory/record-b2b-sale/', {
          items: lines.map((l) => ({
            stock_item_id: l.stockItemId,
            quantity: l.quantity,
            unit_value: l.unitValue || 0
          })),
          customer_id: form.customerId,
          due_date: form.dueDate || undefined,
          notes: form.notes
        });
        return { kind: 'b2b' as const, data: response.data };
      }

      const summaries: MovementSummary[] = [];
      for (const l of lines) {
        await api.post('/plugin/nexainventory/record-sale/', {
          stock_item_id: l.stockItemId,
          sale_type: saleType,
          quantity: l.quantity,
          unit_value: l.unitValue || 0,
          notes: form.notes
        });
        summaries.push({
          partName: l.partName ?? '',
          quantity: String(l.quantity),
          total: String(lineTotal(l))
        });
      }
      return { kind: 'movement' as const, summaries };
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
        setSuccess({
          kind: 'movement',
          saleType,
          lines: result.summaries,
          total: String(runningTotal)
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
                    {t`Sale recorded`}
                  </Text>
                </Group>
                <Stack gap={0} align='center'>
                  {success.lines.map((l, i) => (
                    <Text key={i} c='dimmed' size='sm'>
                      {l.partName} × {l.quantity} — {formatMoney(l.total)}
                    </Text>
                  ))}
                </Stack>
                <Text fw={600}>
                  {t`Total`}: {formatMoney(success.total)}
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

            {isB2B && (
              <CustomerPicker
                value={form.customerId}
                onChange={(customerId) => setForm((f) => ({ ...f, customerId }))}
              />
            )}

            <Stack gap='md'>
              {lines.map((line, index) => (
                <Stack key={line.key} gap='xs'>
                  {lines.length > 1 && (
                    <Group justify='space-between'>
                      <Text size='xs' c='dimmed' fw={700}>
                        {t`Product`} {index + 1}
                      </Text>
                      <ActionIcon
                        color='red'
                        variant='subtle'
                        size='sm'
                        onClick={() => removeLine(line.key)}
                        aria-label={t`Remove product`}
                      >
                        <IconTrash size={14} />
                      </ActionIcon>
                    </Group>
                  )}
                  <ProductPicker
                    value={line.stockItemId}
                    onChange={(stockItemId, stockQty, partName) =>
                      updateLine(line.key, { stockItemId, stockQty, partName })
                    }
                  />
                  <StockAvailabilityHint quantity={line.stockQty} />
                  <SimpleGrid cols={{ base: 1, xs: 2 }}>
                    <NumberInput
                      label={t`Quantity`}
                      value={line.quantity}
                      onChange={(v) => updateLine(line.key, { quantity: v as number })}
                      min={0}
                      required
                    />
                    <NumberInput
                      label={isGift ? t`Gift Value` : t`Unit Value`}
                      value={line.unitValue}
                      onChange={(v) => updateLine(line.key, { unitValue: v as number })}
                      min={0}
                      decimalScale={2}
                      required
                      description={isGift ? t`Required for gifts` : undefined}
                    />
                  </SimpleGrid>
                  {index < lines.length - 1 && <Divider variant='dashed' />}
                </Stack>
              ))}

              <Button
                variant='subtle'
                size='sm'
                leftSection={<IconPlus size={16} />}
                onClick={() => setLines((ls) => [...ls, newLine()])}
              >
                {t`Add Product`}
              </Button>
            </Stack>

            {isB2B && (
              <DateInput
                label={t`Due Date`}
                placeholder={t`Defaults to 30 days from today`}
                value={form.dueDate}
                onChange={(v) => setForm((f) => ({ ...f, dueDate: v }))}
                clearable
              />
            )}

            <Textarea
              label={t`Notes`}
              value={form.notes}
              onChange={(e) =>
                setForm((f) => ({ ...f, notes: e.currentTarget.value }))
              }
              autosize
              minRows={1}
            />

            <Divider />

            <Group justify='space-between' align='center'>
              <Text size='sm' c='dimmed'>
                {t`Total`}
              </Text>
              <Text size='xl' fw={800}>
                {formatMoney(runningTotal)}
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

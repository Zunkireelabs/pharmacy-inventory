import { t } from '@lingui/core/macro';
import {
  Alert,
  Button,
  Modal,
  NumberInput,
  Select,
  Stack,
  TextInput
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { IconAlertCircle, IconCash } from '@tabler/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { api } from '../../App';
import { CustomerPicker } from './CustomerPicker';
import { formatMoney } from './format';
import { SLOW_REQUEST } from './slow';

const METHOD_OPTIONS = [
  { value: 'cash', label: t`Cash` },
  { value: 'online', label: t`Online` },
  { value: 'cheque', label: t`Cheque` }
];

/**
 * Minimal "receive payment" quick-action from the dashboard — pick a
 * customer, pick one of their outstanding invoices, record the payment.
 * Reuses the existing customer receivables + payment endpoints; no new
 * API. Full payment recording from an Invoice Detail page already exists
 * (a later phase); this is the dashboard-level shortcut into the same
 * existing endpoint.
 */
export default function ReceivePaymentButton({
  fullWidth
}: Readonly<{ fullWidth?: boolean }> = {}) {
  const isMobile = useMediaQuery('(max-width: 48em)');
  const [opened, setOpened] = useState(false);
  const [customerId, setCustomerId] = useState<number | null>(null);
  const [invoiceId, setInvoiceId] = useState<number | null>(null);
  const [amount, setAmount] = useState<number | ''>('');
  const [method, setMethod] = useState<string | null>('cash');
  const [reference, setReference] = useState('');
  const [errorDetail, setErrorDetail] = useState<string | null>(null);

  const invoicesQuery = useQuery({
    queryKey: ['nexa-customer-invoices', customerId],
    queryFn: async () => {
      const response = await api.get(
        `/plugin/nexainventory/customers/${customerId}/receivables/`
      );
      return response.data.invoices as {
        id: number;
        reference: string;
        outstanding: string;
      }[];
    },
    enabled: !!customerId
  });

  const reset = () => {
    setCustomerId(null);
    setInvoiceId(null);
    setAmount('');
    setMethod('cash');
    setReference('');
    setErrorDetail(null);
  };

  const mutation = useMutation({
    mutationFn: async () => {
      setErrorDetail(null);
      return api.post(
        `/plugin/nexainventory/invoices/${invoiceId}/payments/`,
        { amount, method, reference }
      , SLOW_REQUEST);
    },
    onSuccess: () => {
      notifications.show({ message: t`Payment recorded`, color: 'green' });
      setOpened(false);
      reset();
    },
    onError: (error: any) => {
      setErrorDetail(
        error?.response?.data?.detail ?? t`Could not record payment`
      );
    }
  });

  const invoiceOptions = (invoicesQuery.data ?? []).map((inv) => ({
    value: String(inv.id),
    label: `${inv.reference} — ${t`Outstanding`}: ${formatMoney(inv.outstanding)}`
  }));

  return (
    <>
      <Button
        variant='light'
        size='md'
        fullWidth={fullWidth}
        leftSection={<IconCash size={18} />}
        onClick={() => setOpened(true)}
      >
        {t`Receive Payment`}
      </Button>
      <Modal
        opened={opened}
        onClose={() => {
          setOpened(false);
          reset();
        }}
        title={t`Receive Payment`}
        centered
        fullScreen={isMobile}
      >
        <Stack>
          {errorDetail && (
            <Alert color='red' icon={<IconAlertCircle size={16} />}>
              {errorDetail}
            </Alert>
          )}
          <CustomerPicker
            value={customerId}
            onChange={(id) => {
              setCustomerId(id);
              setInvoiceId(null);
            }}
          />
          {customerId && (
            <Select
              label={t`Invoice`}
              placeholder={
                invoicesQuery.isFetching
                  ? t`Loading...`
                  : t`Select an outstanding invoice`
              }
              data={invoiceOptions}
              value={invoiceId ? String(invoiceId) : null}
              onChange={(v) => setInvoiceId(v ? Number(v) : null)}
              nothingFoundMessage={t`No outstanding invoices for this customer`}
              required
            />
          )}
          <NumberInput
            label={t`Amount`}
            value={amount}
            onChange={(v) => setAmount(v as number)}
            min={0}
            decimalScale={2}
            required
          />
          <Select
            label={t`Method`}
            data={METHOD_OPTIONS}
            value={method}
            onChange={setMethod}
            required
          />
          <TextInput
            label={t`Reference`}
            value={reference}
            onChange={(e) => setReference(e.currentTarget.value)}
          />
          <Button
            fullWidth
            disabled={!invoiceId || !amount || Number(amount) <= 0 || !method}
            loading={mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {t`Record Payment`}
          </Button>
        </Stack>
      </Modal>
    </>
  );
}

import { t } from '@lingui/core/macro';
import { Alert, Button, Group, Loader, Stack } from '@mantine/core';
import { IconArrowLeft, IconPrinter } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';

import { api } from '../../App';
import { formatMoney, formatQty } from '../../components/nexa/format';

type Bill = {
  id: number;
  reference: string;
  created_at: string;
  header: {
    pharmacy_name: string;
    pharmacy_address: string;
    pharmacy_pan: string;
    pharmacy_dda_reg: string;
    pharmacy_phone: string;
    bill_footer: string;
  };
  customer: { name: string; address: string; phone: string; pan: string };
  prescriber: string;
  prescription_ref: string;
  payment_mode: string;
  lines: {
    sn: number;
    particulars: string;
    brand: string;
    batch: string;
    expiry_date: string | null;
    quantity: string;
    rate: string;
    amount: string;
  }[];
  subtotal: string;
  discount: string;
  discount_reason: string;
  net_amount: string;
  amount_in_words: string;
  dispensed_by: string;
};

const PAYMENT_LABEL: Record<string, string> = {
  cash: 'Cash',
  online: 'Online',
  qr: 'QR',
  other: 'Other'
};

// Print only the bill, not the app chrome around it
const PRINT_CSS = `
@media print {
  body * { visibility: hidden !important; }
  #nexa-bill, #nexa-bill * { visibility: visible !important; }
  #nexa-bill { position: absolute; left: 0; top: 0; width: 100%; box-shadow: none !important; border: none !important; }
  .nexa-no-print { display: none !important; }
}
`;

const cell = { border: '1px solid #444', padding: '4px 8px' } as const;

/** Customer bill, laid out like the pharmacy's patient bill, ready to print. */
export default function BillPage() {
  const { id } = useParams();
  const navigate = useNavigate();

  const query = useQuery({
    queryKey: ['nexa-bill', id],
    queryFn: async () =>
      (await api.get<Bill>(`/plugin/nexainventory/bills/${id}/`)).data
  });

  if (query.isLoading) return <Loader />;
  if (query.isError || !query.data) {
    return <Alert color='red'>{t`Bill not found`}</Alert>;
  }

  const bill = query.data;
  const h = bill.header;
  const hasDiscount = Number(bill.discount) > 0;

  return (
    <Stack gap='md'>
      <style>{PRINT_CSS}</style>
      <Group className='nexa-no-print'>
        <Button
          variant='default'
          leftSection={<IconArrowLeft size={16} />}
          onClick={() => navigate('/bills/')}
        >
          {t`All Bills`}
        </Button>
        <Button leftSection={<IconPrinter size={16} />} onClick={() => window.print()}>
          {t`Print Bill`}
        </Button>
      </Group>

      <div
        id='nexa-bill'
        style={{
          background: 'white',
          color: 'black',
          maxWidth: 800,
          padding: 24,
          border: '1px solid #ccc',
          fontSize: 14,
          lineHeight: 1.4
        }}
      >
        <div style={{ textAlign: 'center', marginBottom: 12 }}>
          <div style={{ fontSize: 22, fontWeight: 800 }}>{h.pharmacy_name}</div>
          {h.pharmacy_address && <div>{h.pharmacy_address}</div>}
          {h.pharmacy_pan && <div>PAN: {h.pharmacy_pan}</div>}
          {h.pharmacy_dda_reg && <div>DDA REG. NO.: {h.pharmacy_dda_reg}</div>}
          {h.pharmacy_phone && <div>Phone No.: {h.pharmacy_phone}</div>}
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
          <div>
            <div>Customer&apos;s name: {bill.customer.name}</div>
            <div>Customer&apos;s Address: {bill.customer.address}</div>
            <div>Contact No: {bill.customer.phone}</div>
            <div>Customer&apos;s PAN: {bill.customer.pan}</div>
            {bill.prescriber && <div>Prescribed By: {bill.prescriber}</div>}
            {bill.prescription_ref && <div>Prescription No: {bill.prescription_ref}</div>}
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontWeight: 700 }}>Bill No: {bill.reference}</div>
            <div>{new Date(bill.created_at).toLocaleString('en-GB')}</div>
            <div>Mode of Payment: {PAYMENT_LABEL[bill.payment_mode] ?? bill.payment_mode}</div>
          </div>
        </div>

        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {['SN.', 'Particulars', 'Batch No.', 'Expiry Date', 'Quantity', 'Rate', 'Amount'].map(
                (head) => (
                  <th key={head} style={{ ...cell, textAlign: 'left' }}>
                    {head}
                  </th>
                )
              )}
            </tr>
          </thead>
          <tbody>
            {bill.lines.map((l) => (
              <tr key={l.sn}>
                <td style={cell}>{l.sn}</td>
                <td style={cell}>{l.particulars}</td>
                <td style={cell}>{l.batch}</td>
                <td style={cell}>{l.expiry_date ?? ''}</td>
                <td style={{ ...cell, textAlign: 'right' }}>{formatQty(l.quantity)}</td>
                <td style={{ ...cell, textAlign: 'right' }}>{formatMoney(l.rate)}</td>
                <td style={{ ...cell, textAlign: 'right' }}>{formatMoney(l.amount)}</td>
              </tr>
            ))}
            <tr>
              <td colSpan={5} style={{ ...cell, border: 'none' }} />
              <td style={{ ...cell, textAlign: 'right' }}>Sub total</td>
              <td style={{ ...cell, textAlign: 'right' }}>{formatMoney(bill.subtotal)}</td>
            </tr>
            <tr>
              <td colSpan={5} style={{ ...cell, border: 'none' }}>
                {hasDiscount && bill.discount_reason
                  ? `Discount reason: ${bill.discount_reason}`
                  : ''}
              </td>
              <td style={{ ...cell, textAlign: 'right' }}>Discount</td>
              <td style={{ ...cell, textAlign: 'right' }}>{formatMoney(bill.discount)}</td>
            </tr>
            <tr>
              <td colSpan={5} style={{ ...cell, border: 'none' }}>
                Amount in words: {bill.amount_in_words}
              </td>
              <td style={{ ...cell, textAlign: 'right', fontWeight: 700 }}>Net Amount</td>
              <td style={{ ...cell, textAlign: 'right', fontWeight: 700 }}>
                {formatMoney(bill.net_amount)}
              </td>
            </tr>
          </tbody>
        </table>

        <div style={{ marginTop: 8 }}>E. &amp; O. E.</div>
        {h.bill_footer && <div style={{ marginTop: 8, fontSize: 12 }}>{h.bill_footer}</div>}

        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            marginTop: 40,
            fontSize: 13
          }}
        >
          <div>Customer&apos;s Signature</div>
          <div>Dispensed By: {bill.dispensed_by}</div>
          <div>Authorized signature</div>
        </div>
      </div>
    </Stack>
  );
}

import { t } from '@lingui/core/macro';

import { ModelType } from '@lib/enums/ModelType';
import type { ApiFormFieldSet } from '@lib/types/Forms';

/**
 * Field definitions for the nexa_inventory plugin's record-sale /
 * record-b2b-sale / payment endpoints. These are plain DRF APIViews with no
 * serializer, so there is no OPTIONS-introspectable schema — every field is
 * fully defined here rather than relying on ApiForm's auto-introspection
 * (which InvenTree's own ModelSerializer-backed endpoints get for free).
 */

export type NonB2BSaleType =
  | 'b2c_cash'
  | 'b2c_online'
  | 'restock'
  | 'correction';

/**
 * Fields for POST /plugin/nexainventory/record-sale/ — covers every sale
 * type except b2b_credit (which has its own endpoint + field set below).
 * sale_type is preset/hidden to the chosen type rather than re-selected in
 * the form, since the type was already chosen to get here (see
 * RecordSaleButton).
 */
export function nonB2BSaleFields(saleType: NonB2BSaleType): ApiFormFieldSet {
  return {
    stock_item_id: {
      label: t`Stock Item`,
      field_type: 'related field',
      model: ModelType.stockitem,
      api_url: '/api/stock/',
      required: true
    },
    quantity: {
      label: t`Quantity`,
      field_type: 'decimal',
      required: true
    },
    unit_value: {
      label: t`Unit Value`,
      field_type: 'decimal',
      required: false
    },
    notes: {
      label: t`Notes`,
      field_type: 'string',
      required: false
    },
    sale_type: {
      field_type: 'string',
      value: saleType,
      hidden: true,
      exclude: false
    }
  };
}

/** Fields for POST /plugin/nexainventory/record-b2b-sale/. */
export function b2bSaleFields(): ApiFormFieldSet {
  return {
    stock_item_id: {
      label: t`Stock Item`,
      field_type: 'related field',
      model: ModelType.stockitem,
      api_url: '/api/stock/',
      required: true
    },
    quantity: {
      label: t`Quantity`,
      field_type: 'decimal',
      required: true
    },
    unit_value: {
      label: t`Unit Value`,
      field_type: 'decimal',
      required: true
    },
    customer_id: {
      label: t`Customer`,
      field_type: 'related field',
      model: ModelType.company,
      api_url: '/api/company/',
      filters: { is_customer: true },
      required: true
    },
    due_date: {
      label: t`Due Date`,
      field_type: 'date',
      required: false,
      description: t`Defaults to 30 days from today if not set`
    },
    notes: {
      label: t`Notes`,
      field_type: 'string',
      required: false
    }
  };
}

export function recordPaymentFields(): ApiFormFieldSet {
  return {
    amount: {
      label: t`Amount`,
      field_type: 'decimal',
      required: true
    },
    method: {
      label: t`Payment Method`,
      field_type: 'choice',
      required: true,
      choices: [
        { value: 'cash', display_name: t`Cash` },
        { value: 'online', display_name: t`Online` },
        { value: 'cheque', display_name: t`Cheque` }
      ]
    },
    payment_date: {
      label: t`Payment Date`,
      field_type: 'date',
      required: false,
      description: t`Defaults to today if not set`
    },
    reference: {
      label: t`Reference`,
      field_type: 'string',
      required: false
    }
  };
}

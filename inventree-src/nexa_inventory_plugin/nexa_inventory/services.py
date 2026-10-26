"""Shared stock-mutation + SaleTypeMovement creation logic, used by every
endpoint that records a sale-type-tagged stock movement (plain record-sale
and the B2B-credit-with-invoice flow). Must be called from inside a caller-
owned transaction.atomic() block — this function does not open its own, so
that callers can extend the same transaction to cover invoice creation.
"""

from stock.status_codes import StockHistoryCode

from .models import SaleTypeMovement

# Sale types that decrease stock (StockItem.take_stock)
OUTBOUND_TYPES = {
    SaleTypeMovement.SaleType.B2B_CREDIT,
    SaleTypeMovement.SaleType.B2C_CASH,
    SaleTypeMovement.SaleType.B2C_ONLINE,
    SaleTypeMovement.SaleType.GIFT,
}

TRACKING_CODE_BY_SALE_TYPE = {
    SaleTypeMovement.SaleType.B2B_CREDIT: StockHistoryCode.SENT_TO_CUSTOMER,
    SaleTypeMovement.SaleType.B2C_CASH: StockHistoryCode.STOCK_REMOVE,
    SaleTypeMovement.SaleType.B2C_ONLINE: StockHistoryCode.STOCK_REMOVE,
    SaleTypeMovement.SaleType.GIFT: StockHistoryCode.STOCK_REMOVE,
    SaleTypeMovement.SaleType.RESTOCK: StockHistoryCode.STOCK_ADD,
    SaleTypeMovement.SaleType.CORRECTION: StockHistoryCode.STOCK_COUNT,
}


class SaleRecordingError(Exception):
    """Raised when the underlying stock mutation fails. Callers should catch
    this from inside their transaction.atomic() block so the whole
    transaction (stock + movement + anything built on top, e.g. an invoice)
    rolls back together.
    """


def record_sale_movement(*, stock_item, sale_type, quantity, unit_value, customer, user, notes=''):
    """Mutate stock and create the corresponding SaleTypeMovement row.

    Caller is responsible for: validating sale_type is a known value,
    validating quantity > 0, validating customer for b2b_credit, checking
    stock sufficiency for outbound types, and wrapping this call in
    transaction.atomic().
    """
    tracking_code = TRACKING_CODE_BY_SALE_TYPE[sale_type]

    if sale_type in OUTBOUND_TYPES:
        ok = stock_item.take_stock(
            quantity,
            user,
            code=tracking_code,
            notes=notes,
            record_tracking=False,
        )
    else:
        ok = stock_item.add_stock(quantity, user, notes=notes)

    if not ok:
        raise SaleRecordingError('Stock update failed')

    if sale_type in OUTBOUND_TYPES:
        tracking_entry = stock_item.add_tracking_entry(
            tracking_code,
            user,
            notes=notes,
            deltas={'removed': float(quantity), 'quantity': float(stock_item.quantity)},
        )
    else:
        # add_stock() already created its own tracking entry via
        # add_tracking_entry() internally — fetch that same entry
        # rather than creating a second one.
        tracking_entry = stock_item.tracking_info.order_by('-date').first()

    return SaleTypeMovement.objects.create(
        tracking_entry=tracking_entry,
        part=stock_item.part,
        sale_type=sale_type,
        quantity=quantity,
        unit_value=unit_value,
        total_value=unit_value * quantity,
        customer=customer,
        notes=notes,
        created_by=user,
    )

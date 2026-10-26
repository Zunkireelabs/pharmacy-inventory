"""Shared stock-mutation + SaleTypeMovement creation logic, used by every
endpoint that records a sale-type-tagged stock movement (plain record-sale
and the B2B-credit-with-invoice flow). Must be called from inside a caller-
owned transaction.atomic() block — this function does not open its own, so
that callers can extend the same transaction to cover invoice creation.
"""

from decimal import Decimal

from django.db.models import F

from common.settings import get_global_setting
from stock.models import StockItem
from stock.status_codes import StockHistoryCode

from .models import MedicineInfo, SaleTypeMovement

# Sale types that decrease stock (StockItem.take_stock)
OUTBOUND_TYPES = {
    SaleTypeMovement.SaleType.B2B_CREDIT,
    SaleTypeMovement.SaleType.B2C_CASH,
    SaleTypeMovement.SaleType.B2C_ONLINE,
    SaleTypeMovement.SaleType.PRESCRIPTION,
    SaleTypeMovement.SaleType.EXPIRY_WRITEOFF,
}

# Outbound types that are real sales: expired stock is blocked, and part_id
# (earliest-expiry-first) allocation is available. Write-offs deliberately
# target a named (usually expired) batch instead.
SELLING_TYPES = OUTBOUND_TYPES - {SaleTypeMovement.SaleType.EXPIRY_WRITEOFF}

# Sale types that need a prescriber and prescription reference
PRESCRIPTION_TYPES = {SaleTypeMovement.SaleType.PRESCRIPTION}

TRACKING_CODE_BY_SALE_TYPE = {
    SaleTypeMovement.SaleType.B2B_CREDIT: StockHistoryCode.SENT_TO_CUSTOMER,
    SaleTypeMovement.SaleType.B2C_CASH: StockHistoryCode.STOCK_REMOVE,
    SaleTypeMovement.SaleType.B2C_ONLINE: StockHistoryCode.STOCK_REMOVE,
    SaleTypeMovement.SaleType.PRESCRIPTION: StockHistoryCode.STOCK_REMOVE,
    SaleTypeMovement.SaleType.EXPIRY_WRITEOFF: StockHistoryCode.STOCK_REMOVE,
    SaleTypeMovement.SaleType.RETURN: StockHistoryCode.STOCK_ADD,
    SaleTypeMovement.SaleType.RESTOCK: StockHistoryCode.STOCK_ADD,
    SaleTypeMovement.SaleType.CORRECTION: StockHistoryCode.STOCK_COUNT,
}


class SaleValidationError(Exception):
    """Raised when a sale request is invalid for a business reason (expired
    or insufficient stock). The message is safe to return to the client.
    """


def expired_sale_blocked():
    """True when expiry tracking is on and selling expired stock is not allowed."""
    return bool(get_global_setting('STOCK_ENABLE_EXPIRY')) and not bool(
        get_global_setting('STOCK_ALLOW_EXPIRED_SALE')
    )


def ensure_sellable(stock_item):
    """Reject a sale from a specific batch that has expired (when blocked)."""
    if expired_sale_blocked() and stock_item.is_expired():
        raise SaleValidationError(
            f'Batch {stock_item.batch or stock_item.pk} of {stock_item.part.name} '
            f'expired on {stock_item.expiry_date}'
        )


def allocate_fefo(part, quantity):
    """Pick stock for `quantity` of `part`, earliest expiry first (FEFO).

    Items with no expiry date are used last. Expired batches are skipped when
    expired sales are blocked. Returns a list of (stock_item, qty) whose qty
    sums to `quantity`. Call inside transaction.atomic(): rows are locked.
    """
    items = StockItem.objects.select_for_update().filter(
        StockItem.IN_STOCK_FILTER, part=part, quantity__gt=0
    )
    if expired_sale_blocked():
        items = items.exclude(StockItem.get_expired_filter())
    items = items.order_by(F('expiry_date').asc(nulls_last=True), 'pk')

    remaining = Decimal(quantity)
    picked = []
    for item in items:
        if remaining <= 0:
            break
        take = min(Decimal(item.quantity), remaining)
        picked.append((item, take))
        remaining -= take

    if remaining > 0:
        available = Decimal(quantity) - remaining
        raise SaleValidationError(
            f'Insufficient sellable stock for {part.name}: {available} available, '
            f'{quantity} requested'
        )
    return picked


def check_prescription_rules(part, sale_type, prescriber='', prescription_ref=''):
    """Light prescription control (no compliance register).

    - Prescription-only or controlled medicines cannot be sold over the counter
      (cash / online); they need a Prescription Sale. Credit sales to
      institutions are not restricted.
    - A Prescription Sale needs the prescriber; controlled medicines also need
      the prescription reference.
    """
    info = MedicineInfo.objects.filter(part=part).first()
    restricted = bool(info and (info.requires_prescription or info.is_controlled))

    if restricted and sale_type in (
        SaleTypeMovement.SaleType.B2C_CASH,
        SaleTypeMovement.SaleType.B2C_ONLINE,
    ):
        raise SaleValidationError(
            f'{part.name} is prescription-only: record it as a Prescription Sale'
        )

    if sale_type in PRESCRIPTION_TYPES:
        if not (prescriber or '').strip():
            raise SaleValidationError('prescriber is required for a prescription sale')
        if info and info.is_controlled and not (prescription_ref or '').strip():
            raise SaleValidationError(
                f'{part.name} is a controlled medicine: prescription_ref is required'
            )


def plain_quantity(value):
    """Decimal as a clean string for API output: 4.00000 -> '4', 2.50 -> '2.5'."""
    value = Decimal(value)
    text = format(value.normalize(), 'f')
    return text if text != '-0' else '0'


def resolve_allocations(*, stock_item=None, part=None, quantity):
    """Allocations for one sale line: a chosen batch, or FEFO across a part."""
    if stock_item is not None:
        ensure_sellable(stock_item)
        return [(stock_item, Decimal(quantity))]
    return allocate_fefo(part, quantity)


class SaleRecordingError(Exception):
    """Raised when the underlying stock mutation fails. Callers should catch
    this from inside their transaction.atomic() block so the whole
    transaction (stock + movement + anything built on top, e.g. an invoice)
    rolls back together.
    """


def record_sale_movement(
    *, stock_item, sale_type, quantity, unit_value, customer, user, notes='',
    prescriber='', prescription_ref=''
):
    """Mutate stock and create the corresponding SaleTypeMovement row.

    Caller is responsible for: validating sale_type is a known value,
    validating quantity > 0, validating customer for b2b_credit, checking
    stock sufficiency for outbound types, and wrapping this call in
    transaction.atomic().
    """
    tracking_code = TRACKING_CODE_BY_SALE_TYPE[sale_type]

    if sale_type in OUTBOUND_TYPES:
        # InvenTree deletes a stock item when it reaches zero (delete_on_deplete),
        # and deleting it cascades to its tracking entries - which would also
        # delete the SaleTypeMovement rows (and so the sale history) for that
        # batch. Keep depleted batches instead.
        if stock_item.delete_on_deplete:
            stock_item.delete_on_deplete = False
            stock_item.save(update_fields=['delete_on_deplete'])

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
        prescriber=prescriber,
        prescription_ref=prescription_ref,
        created_by=user,
    )

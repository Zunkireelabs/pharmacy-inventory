"""SaleTypeMovement: first-class sale-type dimension linked to InvenTree's own stock tracking.
Also: Invoice / InvoiceLineItem / Payment for B2B receivables, built on top of it.
"""

from decimal import Decimal

import InvenTree.models
from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models
from django.utils import timezone

from InvenTree.helpers import pui_url

from .validators import generate_next_invoice_reference, validate_invoice_reference


class SaleTypeMovement(models.Model):
    """One row per sale-type-tagged stock movement, linked 1:1 to the InvenTree
    StockItemTracking entry it corresponds to. InvenTree's own tracking entry
    remains the source of truth for the physical stock change; this table adds
    the business dimension (why did the stock move) on top of it.
    """

    class SaleType(models.TextChoices):
        B2B_CREDIT = 'b2b_credit', 'B2B Credit'
        B2C_CASH = 'b2c_cash', 'B2C Cash'
        B2C_ONLINE = 'b2c_online', 'B2C Online'
        RESTOCK = 'restock', 'Restock'
        CORRECTION = 'correction', 'Correction'

    tracking_entry = models.OneToOneField(
        'stock.StockItemTracking',
        on_delete=models.CASCADE,
        related_name='sale_type_movement',
    )
    part = models.ForeignKey('part.Part', on_delete=models.PROTECT, related_name='+')
    sale_type = models.CharField(max_length=20, choices=SaleType.choices)
    quantity = models.DecimalField(max_digits=15, decimal_places=5)
    unit_value = models.DecimalField(max_digits=15, decimal_places=5, default=0)
    total_value = models.DecimalField(max_digits=15, decimal_places=5, default=0)
    customer = models.ForeignKey(
        'company.Company', on_delete=models.PROTECT, related_name='+', null=True, blank=True
    )
    notes = models.TextField(blank=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name='+'
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f'{self.get_sale_type_display()} — {self.part} x{self.quantity}'


class Invoice(InvenTree.models.ReferenceIndexingMixin, models.Model):
    """A B2B receivable invoice. Reference numbering reuses InvenTree's
    ReferenceIndexingMixin algorithm (same as SalesOrder), but sources its
    pattern from a plugin-scoped setting rather than a core global setting —
    see the Deviation Note in the implementation plan for why.
    """

    DEFAULT_REFERENCE_PATTERN = 'INV-{ref:04d}'

    class Status(models.TextChoices):
        UNPAID = 'unpaid', 'Unpaid'
        PARTIALLY_PAID = 'partially_paid', 'Partially Paid'
        PAID = 'paid', 'Paid'
        CANCELLED = 'cancelled', 'Cancelled'

    reference = models.CharField(
        max_length=64,
        unique=True,
        default=generate_next_invoice_reference,
        validators=[validate_invoice_reference],
    )
    customer = models.ForeignKey(
        'company.Company',
        on_delete=models.PROTECT,
        related_name='+',
        limit_choices_to={'is_customer': True},
    )
    invoice_date = models.DateField(default=timezone.localdate)
    due_date = models.DateField()
    total = models.DecimalField(max_digits=15, decimal_places=5, default=0)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.UNPAID)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name='+'
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f'{self.reference} — {self.customer.name}'

    def get_absolute_url(self) -> str:
        """Get the frontend URL for this invoice."""
        return pui_url(f'/receivables/invoice/{self.pk}')

    def save(self, *args, **kwargs):
        # Keep reference_int in sync on every save — ReferenceIndexingMixin's
        # get_next_reference() falls back to reference_int when the pattern
        # can't be extracted from the latest reference, so this must always
        # reflect the true numeric value (same pattern Order.save() uses).
        self.reference_int = self.rebuild_reference_field(self.reference)
        super().save(*args, **kwargs)

    @classmethod
    def get_reference_pattern(cls):
        """Override: source the pattern from our plugin's own SettingsMixin
        setting instead of InvenTree's core global-settings registry (which
        would require a core-file edit to register the key — see Deviation
        Note in the plan).
        """
        from plugin.models import PluginConfig, PluginSetting

        plugin_config = PluginConfig.objects.filter(key='nexainventory').first()
        if not plugin_config:
            return cls.DEFAULT_REFERENCE_PATTERN

        pattern = PluginSetting.get_setting(
            'INVOICE_REFERENCE_PATTERN',
            plugin=plugin_config,
            backup_value=cls.DEFAULT_REFERENCE_PATTERN,
        )
        return (pattern or cls.DEFAULT_REFERENCE_PATTERN).strip()

    @property
    def amount_paid(self):
        total = self.payments.aggregate(total=models.Sum('amount'))['total']
        return total or Decimal('0')

    @property
    def outstanding(self):
        value = self.total - self.amount_paid
        return value if value > 0 else Decimal('0')

    @property
    def is_overdue(self):
        return (
            self.status not in (self.Status.PAID, self.Status.CANCELLED)
            and self.due_date < timezone.localdate()
            and self.outstanding > 0
        )

    @property
    def aging_bucket(self):
        """Aging bucket based on due_date. None if not currently receivable
        (paid/cancelled/no outstanding balance).
        """
        if self.status == self.Status.CANCELLED or self.outstanding <= 0:
            return None

        days_overdue = (timezone.localdate() - self.due_date).days

        if days_overdue <= 0:
            return 'current'
        if days_overdue <= 30:
            return '1-30'
        if days_overdue <= 60:
            return '31-60'
        if days_overdue <= 90:
            return '61-90'
        return '90+'

    def refresh_status(self, *, save=True):
        """Recompute status from amount_paid vs total. Call after any
        payment is recorded, inside the same atomic block as that payment.
        Does nothing to a cancelled invoice's status (cancellation is a
        terminal, explicitly-set state — payments are rejected against it
        before this method is ever reached in the payment flow).
        """
        if self.status == self.Status.CANCELLED:
            return

        if self.outstanding <= 0:
            new_status = self.Status.PAID
        elif self.amount_paid > 0:
            new_status = self.Status.PARTIALLY_PAID
        else:
            new_status = self.Status.UNPAID

        if new_status != self.status:
            self.status = new_status
            if save:
                self.save(update_fields=['status', 'updated_at'])


class InvoiceLineItem(models.Model):
    """Ties an Invoice to the real stock transaction that backs it. Deliberately
    thin: quantity/unit_price/line_total are NOT duplicated here because
    SaleTypeMovement already stores them immutably (created_at auto_now_add,
    only PROTECT-ed FKs, no update path) — exposed as pass-through properties
    instead, so there is exactly one source of truth for the money.
    """

    invoice = models.ForeignKey('Invoice', on_delete=models.CASCADE, related_name='lines')
    sale_type_movement = models.OneToOneField(
        'SaleTypeMovement', on_delete=models.PROTECT, related_name='invoice_line'
    )

    class Meta:
        ordering = ['id']

    def __str__(self):
        return f'{self.invoice.reference} line: {self.sale_type_movement}'

    @property
    def quantity(self):
        return self.sale_type_movement.quantity

    @property
    def unit_price(self):
        return self.sale_type_movement.unit_value

    @property
    def line_total(self):
        return self.sale_type_movement.total_value

    def clean(self):
        if self.sale_type_movement.sale_type != SaleTypeMovement.SaleType.B2B_CREDIT:
            raise ValidationError(
                'Only b2b_credit SaleTypeMovement rows can be invoiced.'
            )


class Payment(models.Model):
    """One payment against an Invoice. Payment rows are the receivables
    ledger — there is no separate ledger/allocation model.
    """

    class Method(models.TextChoices):
        CASH = 'cash', 'Cash'
        ONLINE = 'online', 'Online'
        CHEQUE = 'cheque', 'Cheque'

    invoice = models.ForeignKey('Invoice', on_delete=models.PROTECT, related_name='payments')
    amount = models.DecimalField(max_digits=15, decimal_places=5)
    payment_date = models.DateField(default=timezone.localdate)
    method = models.CharField(max_length=20, choices=Method.choices)
    reference = models.CharField(max_length=255, blank=True)
    recorded_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name='+'
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['payment_date', 'created_at']

    def __str__(self):
        return f'{self.invoice.reference}: {self.amount} ({self.get_method_display()})'

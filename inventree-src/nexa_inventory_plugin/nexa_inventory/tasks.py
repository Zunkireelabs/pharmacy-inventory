"""Scheduled checks for B2B invoice due dates."""

from datetime import timedelta

from django.contrib.auth import get_user_model
from django.utils import timezone
from django.utils.translation import gettext_lazy as _

import common.notifications
import InvenTree.helpers_model
from InvenTree.helpers import pui_url

from .models import Invoice

DUE_SOON_LEAD_DAYS = 3


def _notify_invoice(invoice, category, name, message):
    users = get_user_model().objects.filter(is_active=True)

    context = {
        'name': name,
        'message': message,
        'link': InvenTree.helpers_model.construct_absolute_url(
            pui_url(f'/company/{invoice.customer_id}/receivables')
        ),
    }

    common.notifications.trigger_notification(
        None,
        category,
        targets=list(users),
        context=context,
        notification_uid=f'{category}-{invoice.pk}',
    )


def check_invoice_due_dates():
    """Notify active users about B2B invoices approaching or just past their due date.

    Runs once a day (see plugin.py's SCHEDULED_TASKS). Each invoice is matched
    against an exact due_date, so the lead-time alert fires exactly once (on
    the day 3 days before due_date) and the overdue alert fires exactly once
    (on the day due_date is reached) - no extra dedup bookkeeping needed
    beyond trigger_notification's own 1-day check_recent window.

    The notification links to the customer's receivables tab (not the single
    invoice) since that's where staff act on a customer's overall due balance.
    """
    today = timezone.localdate()
    open_invoices = Invoice.objects.select_related('customer').filter(
        status__in=[Invoice.Status.UNPAID, Invoice.Status.PARTIALLY_PAID]
    )

    for invoice in open_invoices.filter(due_date=today + timedelta(days=DUE_SOON_LEAD_DAYS)):
        _notify_invoice(
            invoice,
            'nexainventory.invoice_due_soon',
            _('Invoice due soon'),
            _(
                f'Invoice {invoice.reference} for {invoice.customer.name} '
                f'is due in {DUE_SOON_LEAD_DAYS} days'
            ),
        )

    for invoice in open_invoices.filter(due_date=today):
        _notify_invoice(
            invoice,
            'nexainventory.invoice_overdue',
            _('Invoice overdue'),
            _(f'Invoice {invoice.reference} for {invoice.customer.name} is now overdue'),
        )

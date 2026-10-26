from datetime import timedelta
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings
from django.utils import timezone

from common.models import NotificationMessage
from company.models import Company

from .models import Invoice
from .tasks import check_invoice_due_dates

User = get_user_model()


@override_settings(USE_TZ=True)
class CheckInvoiceDueDatesTest(TestCase):
    def setUp(self):
        self.active_user = User.objects.create_user('active-user', password='pw', is_active=True)
        self.inactive_user = User.objects.create_user(
            'inactive-user', password='pw', is_active=False
        )
        self.creator = User.objects.create_user('creator', password='pw', is_active=False)
        self.customer = Company.objects.create(name='Acme Pharma', is_customer=True)

    def _make_invoice(self, due_date, status=Invoice.Status.UNPAID):
        return Invoice.objects.create(
            customer=self.customer,
            due_date=due_date,
            total=Decimal('100.00'),
            status=status,
            created_by=self.creator,
        )

    def test_notifies_active_users_when_invoice_is_three_days_from_due(self):
        today = timezone.localdate()
        invoice = self._make_invoice(due_date=today + timedelta(days=3))

        check_invoice_due_dates()

        messages = NotificationMessage.objects.filter(category='nexainventory.invoice_due_soon')
        self.assertEqual(messages.count(), 1)
        message = messages.first()
        self.assertEqual(message.user, self.active_user)
        self.assertIn(invoice.reference, message.message)
        self.assertIn(self.customer.name, message.message)
        self.assertIn(f'/company/{self.customer.pk}/receivables', message.link)

    def test_does_not_notify_inactive_users(self):
        today = timezone.localdate()
        self._make_invoice(due_date=today + timedelta(days=3))

        check_invoice_due_dates()

        messages = NotificationMessage.objects.filter(category='nexainventory.invoice_due_soon')
        self.assertFalse(messages.filter(user=self.inactive_user).exists())

    def test_notifies_active_users_when_invoice_just_went_overdue(self):
        today = timezone.localdate()
        invoice = self._make_invoice(due_date=today)

        check_invoice_due_dates()

        messages = NotificationMessage.objects.filter(category='nexainventory.invoice_overdue')
        self.assertEqual(messages.count(), 1)
        message = messages.first()
        self.assertEqual(message.user, self.active_user)
        self.assertIn(invoice.reference, message.message)
        self.assertIn(self.customer.name, message.message)
        self.assertIn(f'/company/{self.customer.pk}/receivables', message.link)

    def test_does_not_notify_for_invoice_due_in_five_days(self):
        today = timezone.localdate()
        self._make_invoice(due_date=today + timedelta(days=5))

        check_invoice_due_dates()

        self.assertFalse(
            NotificationMessage.objects.filter(
                category='nexainventory.invoice_due_soon'
            ).exists()
        )
        self.assertFalse(
            NotificationMessage.objects.filter(
                category='nexainventory.invoice_overdue'
            ).exists()
        )

    def test_does_not_notify_for_paid_invoice_due_today(self):
        today = timezone.localdate()
        self._make_invoice(due_date=today, status=Invoice.Status.PAID)

        check_invoice_due_dates()

        self.assertFalse(
            NotificationMessage.objects.filter(
                category='nexainventory.invoice_overdue'
            ).exists()
        )

    def test_does_not_duplicate_notification_on_second_run_same_day(self):
        today = timezone.localdate()
        self._make_invoice(due_date=today)

        check_invoice_due_dates()
        check_invoice_due_dates()

        messages = NotificationMessage.objects.filter(category='nexainventory.invoice_overdue')
        self.assertEqual(messages.count(), 1)

"""Purchase entry: receive stock as a new batch with supplier invoice details."""

from datetime import date, timedelta
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import override_settings
from django.urls import reverse
from rest_framework.test import APITestCase

from company.models import Company
from InvenTree.unit_test import PluginRegistryMixin
from part.models import Part
from stock.models import StockItem, StockLocation

from .models import PurchaseReceipt

User = get_user_model()


def _days(n):
    return (date.today() + timedelta(days=n)).isoformat()


@override_settings(USE_TZ=True)
class ReceiveStockTest(PluginRegistryMixin, APITestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            'storekeeper', password='pw', is_staff=True, first_name='Hari', last_name='KC'
        )
        self.client.force_login(self.user)
        cache.clear()
        self.part = Part.objects.create(name='Amoxicillin 500 mg Capsule', description='x', purchaseable=True)
        self.location = StockLocation.objects.create(name='Main Branch')
        self.supplier = Company.objects.create(name='Medico Distributors', is_supplier=True)
        self.url = reverse('plugin:nexainventory:receive-stock')

    def receive(self, **extra):
        body = {
            'part_id': self.part.pk, 'batch': 'AMX-2201', 'expiry_date': _days(400),
            'quantity': 100, 'unit_cost': '10', 'location_id': self.location.pk,
            **extra,
        }
        return self.client.post(self.url, body, format='json')

    def test_creates_batch_with_bonus_and_receipt(self):
        response = self.receive(
            bonus_quantity=20, discount='50', tax='130', supplier_id=self.supplier.pk,
            invoice_no='INV-778', payment_status='partial', notes='checked, seals intact',
        )
        self.assertEqual(response.status_code, 201, response.content)
        # 100 x 10 - 50 + 130 = 1080
        self.assertEqual(response.data['line_total'], '1080.00')
        self.assertEqual(response.data['quantity'], '100')
        self.assertEqual(response.data['bonus_quantity'], '20')
        self.assertEqual(response.data['supplier'], 'Medico Distributors')
        self.assertEqual(response.data['received_by'], 'Hari KC')

        item = StockItem.objects.get(pk=response.data['stock_item_id'])
        self.assertEqual(item.quantity, 120)  # purchased + free
        self.assertEqual(item.batch, 'AMX-2201')
        self.assertEqual(item.location, self.location)
        self.assertEqual(item.expiry_date.isoformat(), _days(400))
        # effective cost per unit: 1080 / 120 = 9
        self.assertEqual(item.purchase_price.amount, Decimal('9'))
        self.assertFalse(item.delete_on_deplete)
        self.assertEqual(PurchaseReceipt.objects.get().invoice_no, 'INV-778')

    def test_defaults_without_supplier_or_extras(self):
        response = self.receive()
        self.assertEqual(response.status_code, 201, response.content)
        self.assertEqual(response.data['line_total'], '1000.00')
        self.assertEqual(response.data['payment_status'], 'unpaid')
        self.assertEqual(response.data['supplier'], '')

    def test_validation(self):
        self.assertEqual(self.receive(batch='').status_code, 400)
        self.assertEqual(self.receive(expiry_date=_days(-1)).status_code, 400)
        self.assertEqual(self.receive(expiry_date='soon').status_code, 400)
        self.assertEqual(self.receive(quantity=0).status_code, 400)
        self.assertEqual(self.receive(bonus_quantity=-1).status_code, 400)
        self.assertEqual(self.receive(unit_cost='-5').status_code, 400)
        self.assertEqual(self.receive(discount='5000').status_code, 400)
        self.assertEqual(self.receive(payment_status='later').status_code, 400)
        self.assertEqual(self.receive(location_id=999999).status_code, 400)
        self.assertEqual(self.receive(supplier_id=999999).status_code, 400)
        self.assertEqual(self.receive(part_id=999999).status_code, 400)
        self.assertEqual(StockItem.objects.count(), 0)
        self.assertEqual(PurchaseReceipt.objects.count(), 0)

    def test_customer_is_not_a_supplier(self):
        customer = Company.objects.create(name='Walk-in Clinic', is_customer=True, is_supplier=False)
        self.assertEqual(self.receive(supplier_id=customer.pk).status_code, 400)

    def test_received_batch_is_sold_earliest_expiry_first(self):
        self.receive(batch='LATE', expiry_date=_days(600))
        self.receive(batch='SOON', expiry_date=_days(60), quantity=10)
        bill = self.client.post(
            reverse('plugin:nexainventory:record-bill'),
            {
                'sale_type': 'b2c_cash',
                'items': [{'part_id': self.part.pk, 'quantity': 12, 'unit_value': '15'}],
            },
            format='json',
        )
        self.assertEqual(bill.status_code, 201, bill.content)
        self.assertEqual(
            [(l['batch'], l['quantity']) for l in bill.data['lines']],
            [('SOON', '10'), ('LATE', '2')],
        )

    def test_purchase_list_search_and_filter(self):
        self.receive(invoice_no='INV-1', supplier_id=self.supplier.pk, payment_status='paid')
        self.receive(invoice_no='INV-2', batch='B2')
        url = reverse('plugin:nexainventory:purchase-list')
        self.assertEqual(self.client.get(url).data['count'], 2)
        self.assertEqual(
            [r['invoice_no'] for r in self.client.get(url, {'search': 'medico'}).data['results']],
            ['INV-1'],
        )
        unpaid = self.client.get(url, {'payment_status': 'unpaid'})
        self.assertEqual([r['invoice_no'] for r in unpaid.data['results']], ['INV-2'])
        self.assertEqual(self.client.get(url, {'payment_status': 'x'}).status_code, 400)

    def test_purchase_shows_its_branch(self):
        self.assertEqual(self.receive().data['branch'], 'Main Branch')
        # stock put on a shelf still shows the branch the shelf belongs to
        shelf = StockLocation.objects.create(name='Shelf A', parent=self.location)
        self.assertEqual(self.receive(batch='B2', location_id=shelf.pk).data['branch'], 'Main Branch')
        rows = self.client.get(reverse('plugin:nexainventory:purchase-list')).data['results']
        self.assertEqual({r['branch'] for r in rows}, {'Main Branch'})

    def test_requires_login(self):
        self.client.logout()
        self.assertEqual(self.receive().status_code, 401)

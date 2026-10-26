"""Customer bills: grouping, discount rules, prescription rules, printing data."""

from datetime import date, timedelta
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import SimpleTestCase, TestCase, override_settings
from django.urls import reverse
from rest_framework.test import APITestCase

from common.models import InvenTreeSetting
from InvenTree.unit_test import PluginRegistryMixin
from part.models import Part
from stock.models import StockItem

from .models import MedicineInfo, SaleBill, SaleTypeMovement
from .services import amount_in_words, number_to_words

User = get_user_model()


def _days(n):
    return date.today() + timedelta(days=n)


class NumberToWordsTest(SimpleTestCase):
    def test_indian_grouping(self):
        self.assertEqual(number_to_words(0), 'Zero')
        self.assertEqual(number_to_words(19), 'Nineteen')
        self.assertEqual(number_to_words(21), 'Twenty One')
        self.assertEqual(number_to_words(100), 'One Hundred')
        self.assertEqual(number_to_words(1250), 'One Thousand Two Hundred Fifty')
        self.assertEqual(number_to_words(100000), 'One Lakh')
        self.assertEqual(
            number_to_words(12345678),
            'One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight',
        )


class AmountInWordsTest(TestCase):
    def setUp(self):
        InvenTreeSetting.set_setting('CURRENCY_CODES', 'NPR,INR,USD', None)
        InvenTreeSetting.set_setting('INVENTREE_DEFAULT_CURRENCY', 'NPR', None)

    def test_rupees_and_paisa(self):
        self.assertEqual(amount_in_words(Decimal('1250')), 'Rupees One Thousand Two Hundred Fifty Only')
        self.assertEqual(amount_in_words(Decimal('99.50')), 'Rupees Ninety Nine and Paisa Fifty Only')
        self.assertEqual(amount_in_words(Decimal('0')), 'Rupees Zero Only')


@override_settings(USE_TZ=True)
class BillApiTest(PluginRegistryMixin, APITestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            'cashier', password='pw', is_staff=True, first_name='Sita', last_name='Rai'
        )
        self.client.force_login(self.user)
        cache.clear()
        InvenTreeSetting.set_setting('STOCK_ENABLE_EXPIRY', True, None)
        InvenTreeSetting.set_setting('STOCK_ALLOW_EXPIRED_SALE', False, None)
        InvenTreeSetting.set_setting('CURRENCY_CODES', 'NPR,INR,USD', None)
        InvenTreeSetting.set_setting('INVENTREE_DEFAULT_CURRENCY', 'NPR', None)
        self.para = Part.objects.create(name='Paracetamol 500 mg Tablet', description='x', salable=True)
        self.amox = Part.objects.create(name='Amoxicillin 500 mg Capsule', description='x', salable=True)
        StockItem.objects.create(part=self.para, quantity=4, batch='P-SOON', expiry_date=_days(30))
        StockItem.objects.create(part=self.para, quantity=100, batch='P-LATE', expiry_date=_days(400))
        StockItem.objects.create(part=self.amox, quantity=50, batch='A-1', expiry_date=_days(200))
        self.url = reverse('plugin:nexainventory:record-bill')

    def bill(self, items=None, **extra):
        body = {
            'sale_type': 'b2c_cash',
            'items': items
            if items is not None
            else [{'part_id': self.para.pk, 'quantity': 6, 'unit_value': '2.50'}],
            **extra,
        }
        return self.client.post(self.url, body, format='json')

    def test_bill_groups_lines_and_uses_earliest_expiry_first(self):
        response = self.bill(
            [
                {'part_id': self.para.pk, 'quantity': 6, 'unit_value': '2.50'},
                {'part_id': self.amox.pk, 'quantity': 10, 'unit_value': '8'},
            ],
            customer_name='Ram Thapa', customer_phone='9800000000', payment_mode='qr',
        )
        self.assertEqual(response.status_code, 201, response.content)
        data = response.data
        self.assertEqual(data['reference'], f'BILL-{data["id"]:05d}')
        self.assertEqual(data['payment_mode'], 'qr')
        self.assertEqual(data['customer']['name'], 'Ram Thapa')
        # 6 paracetamol = 4 from the soon batch + 2 from the late batch; + 1 amoxicillin line
        batches = [(line['batch'], line['quantity']) for line in data['lines']]
        self.assertEqual(batches, [('P-SOON', '4'), ('P-LATE', '2'), ('A-1', '10')])
        self.assertEqual(data['subtotal'], '95.00')  # 6*2.50 + 10*8
        self.assertEqual(data['net_amount'], '95.00')
        self.assertEqual(data['amount_in_words'], 'Rupees Ninety Five Only')
        self.assertEqual(data['dispensed_by'], 'Sita Rai')
        self.assertEqual(SaleBill.objects.get().lines.count(), 3)

    def test_discount_needs_reason_and_cannot_exceed_total(self):
        self.assertEqual(self.bill(discount='5').status_code, 400)
        too_much = self.bill(discount='500', discount_reason='regular customer')
        self.assertEqual(too_much.status_code, 400)
        self.assertEqual(SaleBill.objects.count(), 0)
        self.assertEqual(
            StockItem.objects.get(batch='P-SOON').quantity, 4
        )  # rolled back

    def test_discount_reduces_net_amount(self):
        response = self.bill(discount='5', discount_reason='senior citizen')
        self.assertEqual(response.status_code, 201, response.content)
        self.assertEqual(response.data['subtotal'], '15.00')
        self.assertEqual(response.data['discount'], '5.00')
        self.assertEqual(response.data['net_amount'], '10.00')
        self.assertEqual(response.data['discount_reason'], 'senior citizen')

    def test_invalid_sale_type_payment_mode_and_discount(self):
        self.assertEqual(self.bill(sale_type='b2b_credit').status_code, 400)
        self.assertEqual(self.bill(payment_mode='barter').status_code, 400)
        self.assertEqual(self.bill(discount='-1', discount_reason='x').status_code, 400)
        self.assertEqual(self.bill(items=[]).status_code, 400)

    def test_one_bad_line_rolls_back_the_whole_bill(self):
        response = self.bill([
            {'part_id': self.amox.pk, 'quantity': 5, 'unit_value': '8'},
            {'part_id': self.para.pk, 'quantity': 5000, 'unit_value': '2.50'},
        ])
        self.assertEqual(response.status_code, 400)
        self.assertEqual(SaleBill.objects.count(), 0)
        self.assertEqual(SaleTypeMovement.objects.count(), 0)
        self.assertEqual(StockItem.objects.get(batch='A-1').quantity, 50)

    def test_prescription_only_medicine_needs_a_prescription_bill(self):
        MedicineInfo.objects.create(part=self.amox, requires_prescription=True)
        items = [{'part_id': self.amox.pk, 'quantity': 3, 'unit_value': '8'}]
        self.assertEqual(self.bill(items).status_code, 400)  # cash (OTC) refused
        no_doctor = self.bill(items, sale_type='prescription')
        self.assertEqual(no_doctor.status_code, 400)
        ok = self.bill(items, sale_type='prescription', prescriber='Dr. Adhikari', prescription_ref='RX-5')
        self.assertEqual(ok.status_code, 201, ok.content)
        self.assertEqual(ok.data['prescriber'], 'Dr. Adhikari')
        self.assertEqual(ok.data['sale_type'], 'prescription')

    def test_detail_returns_header_and_list_finds_bill(self):
        created = self.bill(customer_name='Gita Rai')
        detail = self.client.get(reverse('plugin:nexainventory:bill-detail', args=[created.data['id']]))
        self.assertEqual(detail.status_code, 200)
        self.assertEqual(detail.data['header']['pharmacy_name'], 'Nexa Pharmacia')
        self.assertIn('Return & Refund Policy', detail.data['header']['bill_footer'])
        self.assertEqual(detail.data['lines'][0]['expiry_date'], _days(30).isoformat())

        listing = self.client.get(reverse('plugin:nexainventory:bill-list'), {'search': 'gita'})
        self.assertEqual([b['reference'] for b in listing.data['results']], [created.data['reference']])
        missing = self.client.get(reverse('plugin:nexainventory:bill-detail', args=[99999]))
        self.assertEqual(missing.status_code, 404)

    def test_requires_login(self):
        self.client.logout()
        self.assertEqual(self.bill().status_code, 401)

"""One-form medicine entry: a new medicine with its first batch, month/year
expiry, repeat-safe saving, catalogue fields and supplier DDA numbers.
"""

from datetime import date
from unittest import mock

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import override_settings
from django.urls import reverse
from rest_framework.test import APITestCase

from company.models import Company
from InvenTree.unit_test import PluginRegistryMixin
from part.models import Part, PartCategory
from stock.models import StockItem, StockLocation

from .api import end_of_month
from .models import MedicineInfo, PurchaseReceipt

User = get_user_model()

NEXT_YEAR = date.today().year + 1


@override_settings(USE_TZ=True)
class AddMedicineTest(PluginRegistryMixin, APITestCase):
    def setUp(self):
        self.owner = User.objects.create_user('owner', password='pw', is_staff=True)
        self.clerk = User.objects.create_user('clerk', password='pw')
        self.client.force_login(self.owner)
        cache.clear()
        self.location = StockLocation.objects.create(name='Main Branch')
        self.supplier = Company.objects.create(
            name='Medico Distributors', is_supplier=True, phone='9800000000'
        )
        self.category = PartCategory.objects.create(name='Tablets')
        self.url = reverse('plugin:nexainventory:add-medicine')
        self.receive_url = reverse('plugin:nexainventory:receive-stock')

    def add(self, **extra):
        body = {
            'category_id': self.category.pk,
            'brand': 'Nico',
            'generic_name': 'Paracetamol',
            'strength': '500 mg',
            'description': 'For fever and pain, after food',
            'manufacturer': 'Nepal Pharma',
            'mrp': '2.50',
            'batch': 'NC-01',
            'expiry_month': 8,
            'expiry_year': NEXT_YEAR,
            'quantity': 100,
            'unit_cost': '1.80',
            'supplier_id': self.supplier.pk,
            'location_id': self.location.pk,
            **extra,
        }
        return self.client.post(self.url, body, format='json')

    def test_new_medicine_with_first_batch(self):
        response = self.add()
        self.assertEqual(response.status_code, 201, response.content)

        part = Part.objects.get(pk=response.data['part_id'])
        self.assertEqual(part.name, 'Nico 500 mg')
        # description is what staff typed, not generated
        self.assertEqual(part.description, 'For fever and pain, after food')
        self.assertEqual(part.category, self.category)
        self.assertFalse(part.IPN)  # IPN stays free for the medicine code

        info = MedicineInfo.objects.get(part=part)
        self.assertEqual(
            (info.brand, info.generic_name, info.strength, info.manufacturer, str(info.mrp)),
            ('Nico', 'Paracetamol', '500 mg', 'Nepal Pharma', '2.50'),
        )

        item = StockItem.objects.get(part=part)
        self.assertEqual(item.quantity, 100)
        self.assertEqual(item.batch, 'NC-01')
        # month/year is stored as the last day of that month
        self.assertEqual(item.expiry_date, date(NEXT_YEAR, 8, 31))

        receipt = PurchaseReceipt.objects.get(part=part)
        self.assertEqual(receipt.expiry_date, date(NEXT_YEAR, 8, 31))
        self.assertEqual(response.data['receipt']['line_total'], '180.00')
        self.assertEqual(response.data['receipt']['supplier'], 'Medico Distributors')

    def test_no_stock_yet(self):
        response = self.add(no_stock=True, batch='', quantity=None)
        self.assertEqual(response.status_code, 201, response.content)
        self.assertIsNone(response.data['receipt'])
        part = Part.objects.get(pk=response.data['part_id'])
        self.assertEqual(MedicineInfo.objects.get(part=part).generic_name, 'Paracetamol')
        self.assertFalse(StockItem.objects.filter(part=part).exists())
        self.assertFalse(PurchaseReceipt.objects.exists())

    def test_new_category_is_created_or_reused(self):
        response = self.add(category_id=None, new_category_name='Syrups')
        self.assertEqual(response.status_code, 201, response.content)
        syrups = PartCategory.objects.get(name='Syrups')
        self.assertIsNone(syrups.parent)
        self.assertEqual(Part.objects.get(pk=response.data['part_id']).category, syrups)

        again = self.add(new_category_name='syrups', brand='Cofsil', batch='CF-1')
        self.assertEqual(again.status_code, 201, again.content)
        self.assertEqual(PartCategory.objects.filter(name__iexact='syrups').count(), 1)

    def test_failure_saves_nothing(self):
        counts = lambda: (  # noqa: E731
            Part.objects.count(), MedicineInfo.objects.count(), StockItem.objects.count(),
            PurchaseReceipt.objects.count(), PartCategory.objects.count(),
        )
        before = counts()

        # bad input is rejected before anything is written
        self.assertEqual(self.add(brand='').status_code, 400)
        self.assertEqual(self.add(expiry_month=13).status_code, 400)
        self.assertEqual(self.add(quantity=0).status_code, 400)
        self.assertEqual(self.add(location_id=999999).status_code, 400)
        self.assertEqual(self.add(category_id=999999).status_code, 400)

        # a failure while saving the batch rolls back the medicine and category too
        with mock.patch(
            'nexa_inventory.api.PurchaseReceipt.objects.create', side_effect=ValueError('boom')
        ):
            response = self.add(category_id=None, new_category_name='Drops')
        self.assertEqual(response.status_code, 400)
        self.assertEqual(counts(), before)

    def test_staff_only(self):
        self.client.force_login(self.clerk)
        self.assertEqual(self.add().status_code, 403)
        self.assertFalse(Part.objects.exists())

    def test_repeat_request_adds_stock_once(self):
        first = self.add(request_id='req-1')
        second = self.add(request_id='req-1')
        self.assertEqual(first.status_code, 201, first.content)
        self.assertEqual(second.status_code, 200, second.content)
        self.assertEqual(second.data['part_id'], first.data['part_id'])
        self.assertEqual(Part.objects.count(), 1)
        self.assertEqual(StockItem.objects.count(), 1)
        self.assertEqual(PurchaseReceipt.objects.count(), 1)

    def test_second_batch_leaves_first_untouched(self):
        part_id = self.add().data['part_id']
        first = StockItem.objects.get(part_id=part_id)

        response = self.client.post(self.receive_url, {
            'part_id': part_id, 'batch': 'NC-02', 'expiry_month': 2,
            'expiry_year': NEXT_YEAR + 1, 'quantity': 50, 'unit_cost': '1.90',
            'location_id': self.location.pk,
        }, format='json')
        self.assertEqual(response.status_code, 201, response.content)

        first.refresh_from_db()
        self.assertEqual((first.batch, first.quantity), ('NC-01', 100))
        self.assertEqual(first.expiry_date, date(NEXT_YEAR, 8, 31))
        second = StockItem.objects.get(pk=response.data['stock_item_id'])
        self.assertEqual(second.expiry_date, end_of_month(NEXT_YEAR + 1, 2))
        self.assertEqual(StockItem.objects.filter(part_id=part_id).count(), 2)


@override_settings(USE_TZ=True)
class ReceiveStockMonthYearTest(PluginRegistryMixin, APITestCase):
    def setUp(self):
        self.owner = User.objects.create_user('owner', password='pw', is_staff=True)
        self.clerk = User.objects.create_user('clerk', password='pw')
        self.client.force_login(self.clerk)
        cache.clear()
        self.part = Part.objects.create(name='Nico 500 mg', description='x', purchaseable=True)
        MedicineInfo.objects.create(part=self.part, mrp='2.50')
        self.location = StockLocation.objects.create(name='Main Branch')
        self.url = reverse('plugin:nexainventory:receive-stock')

    def receive(self, **extra):
        body = {
            'part_id': self.part.pk, 'batch': 'NC-01', 'expiry_month': 2,
            'expiry_year': NEXT_YEAR, 'quantity': 10, 'unit_cost': '1',
            'location_id': self.location.pk, **extra,
        }
        return self.client.post(self.url, body, format='json')

    def test_last_day_of_month_including_leap_february(self):
        response = self.receive()
        self.assertEqual(response.status_code, 201, response.content)
        self.assertEqual(
            StockItem.objects.get().expiry_date, end_of_month(NEXT_YEAR, 2)
        )
        self.assertEqual(end_of_month(2028, 2), date(2028, 2, 29))
        self.assertEqual(end_of_month(2029, 2), date(2029, 2, 28))

    def test_current_month_is_allowed_past_month_is_not(self):
        today = date.today()
        self.assertEqual(
            self.receive(expiry_month=today.month, expiry_year=today.year).status_code, 201
        )
        last_year = self.receive(batch='OLD', expiry_month=today.month, expiry_year=today.year - 1)
        self.assertEqual(last_year.status_code, 400)

    def test_month_year_validation(self):
        self.assertEqual(self.receive(expiry_month=0).status_code, 400)
        self.assertEqual(self.receive(expiry_month=13).status_code, 400)
        self.assertEqual(self.receive(expiry_year='').status_code, 400)
        self.assertEqual(self.receive(expiry_month='x').status_code, 400)
        self.assertEqual(StockItem.objects.count(), 0)

    def test_repeat_request_adds_stock_once(self):
        first = self.receive(request_id='abc')
        second = self.receive(request_id='abc')
        self.assertEqual(first.status_code, 201)
        self.assertEqual(second.status_code, 200)
        self.assertEqual(second.data['id'], first.data['id'])
        self.assertEqual(StockItem.objects.count(), 1)
        # a new request id is a new delivery
        self.assertEqual(self.receive(request_id='def').status_code, 201)
        self.assertEqual(StockItem.objects.count(), 2)

    def test_mrp_change_needs_staff(self):
        # same MRP: anyone can receive
        self.assertEqual(self.receive(mrp='2.50').status_code, 201)
        # a different MRP from a non-staff user is refused and nothing is saved
        self.assertEqual(self.receive(batch='B2', mrp='3.00').status_code, 403)
        self.assertEqual(StockItem.objects.count(), 1)
        self.client.force_login(self.owner)
        self.assertEqual(self.receive(batch='B3', mrp='3.00').status_code, 201)
        self.assertEqual(str(MedicineInfo.objects.get(part=self.part).mrp), '3.00')


@override_settings(USE_TZ=True)
class CatalogueAndSupplierTest(PluginRegistryMixin, APITestCase):
    def setUp(self):
        self.owner = User.objects.create_user('owner', password='pw', is_staff=True)
        self.clerk = User.objects.create_user('clerk', password='pw')
        self.client.force_login(self.owner)
        cache.clear()
        self.part = Part.objects.create(name='Nico 500 mg', description='x')
        self.supplier = Company.objects.create(name='Medico', is_supplier=True, phone='01-4000000')

    def test_medicine_info_saves_catalogue_fields(self):
        url = reverse('plugin:nexainventory:medicine-detail', kwargs={'part_id': self.part.pk})
        response = self.client.put(url, {
            'generic_name': 'Paracetamol', 'strength': '500 mg', 'brand': 'Nico',
            'manufacturer': 'Nepal Pharma', 'mrp': '2.50',
        }, format='json')
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.data['generic_name'], 'Paracetamol')
        self.assertEqual(response.data['mrp'], '2.50')
        info = MedicineInfo.objects.get(part=self.part)
        self.assertFalse(info.requires_prescription)
        self.assertEqual(info.manufacturer, 'Nepal Pharma')

        self.assertEqual(self.client.put(url, {'mrp': '-1'}, format='json').status_code, 400)
        self.assertEqual(self.client.put(url, {'strength': 5}, format='json').status_code, 400)

        self.client.force_login(self.clerk)
        self.assertEqual(self.client.put(url, {'mrp': '9'}, format='json').status_code, 403)

    def test_edit_keeps_name_and_description_in_sync(self):
        url = reverse('plugin:nexainventory:medicine-detail', kwargs={'part_id': self.part.pk})
        response = self.client.put(url, {
            'brand': 'Nico', 'strength': '650 mg', 'description': 'For high fever',
        }, format='json')
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.data['description'], 'For high fever')
        self.part.refresh_from_db()
        self.assertEqual(self.part.name, 'Nico 650 mg')
        self.assertEqual(self.part.description, 'For high fever')

        # editing other fields leaves the name alone
        self.client.put(url, {'manufacturer': 'Nepal Pharma'}, format='json')
        self.part.refresh_from_db()
        self.assertEqual(self.part.name, 'Nico 650 mg')

        self.assertEqual(
            self.client.put(url, {'description': 'x' * 300}, format='json').status_code, 400
        )

    def test_search_by_brand_and_generic_name_follows_edits(self):
        # the core product list needs part view rights, which a superuser has
        self.client.force_login(User.objects.create_superuser('boss', password='pw'))

        def found(term):
            response = self.client.get(reverse('api-part-list'), {'search': term, 'limit': 50})
            rows = response.data.get('results', response.data)
            return [p['pk'] for p in rows]

        url = reverse('plugin:nexainventory:medicine-detail', kwargs={'part_id': self.part.pk})
        self.client.put(url, {'brand': 'Nico', 'generic_name': 'Paracetamol'}, format='json')
        self.assertEqual(found('paracetamol'), [self.part.pk])
        self.assertEqual(found('nico'), [self.part.pk])

        # after changing the generic name, search finds the new one, not the old
        self.client.put(url, {'generic_name': 'Acetaminophen'}, format='json')
        self.assertEqual(found('acetaminophen'), [self.part.pk])
        self.assertEqual(found('paracetamol'), [])

    def test_all_medicines_list(self):
        flagged = Part.objects.create(name='Tramadol 50 mg', description='')
        MedicineInfo.objects.create(part=flagged, requires_prescription=True)
        MedicineInfo.objects.create(part=self.part, generic_name='Paracetamol', mrp='2.50')
        url = reverse('plugin:nexainventory:medicine-list')

        self.assertEqual([r['part_id'] for r in self.client.get(url).data], [flagged.pk])
        rows = {r['part_id']: r for r in self.client.get(url, {'all': 1}).data}
        self.assertEqual(set(rows), {flagged.pk, self.part.pk})
        self.assertEqual(rows[self.part.pk]['generic_name'], 'Paracetamol')
        self.assertEqual(rows[self.part.pk]['mrp'], '2.50')

    def test_supplier_phone_and_dda(self):
        list_url = reverse('plugin:nexainventory:supplier-list')
        detail = reverse('plugin:nexainventory:supplier-detail', kwargs={'pk': self.supplier.pk})

        rows = self.client.get(list_url).data
        self.assertEqual(rows, [{
            'id': self.supplier.pk, 'name': 'Medico', 'phone': '01-4000000', 'dda_reg_no': '',
        }])

        response = self.client.patch(detail, {'dda_reg_no': ' DDA-1234 '}, format='json')
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(self.client.get(list_url).data[0]['dda_reg_no'], 'DDA-1234')

        self.client.force_login(self.clerk)
        self.assertEqual(
            self.client.patch(detail, {'dda_reg_no': 'X'}, format='json').status_code, 403
        )

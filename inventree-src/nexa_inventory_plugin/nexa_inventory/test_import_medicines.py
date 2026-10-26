"""The medicine master importer: strengths, categories, flags, re-runs."""

import os
import tempfile
from datetime import date
from io import StringIO

import openpyxl
from django.core.management import call_command
from django.test import TestCase

from part.models import Part, PartCategory
from stock.models import StockItem

from .management.commands.import_medicines import category_for, clean_strength
from .models import MedicineInfo

HEADER = [
    'Medicine Code/SKU', 'Generic Medicine Name', 'Strength', 'Dosage Form',
    'Brand Name', 'Manufacturer', 'Purchase Date', 'Purchase Invoice No.',
    'Supplier Name', 'Supplier PAN/VAT', 'Batch Number', 'Expiry Date',
    'Quantity Received', 'Free/Bonus Quantity', 'Unit Purchase Price',
    'MRP per Unit', 'Selling Price per Unit', 'Storage Location',
    'Reorder Level', 'Prescription Required (Yes/No)', 'Remarks',
]


def row(sku, generic, strength, form, **kw):
    cells = {h: None for h in HEADER}
    cells.update({
        'Medicine Code/SKU': sku, 'Generic Medicine Name': generic,
        'Strength': strength, 'Dosage Form': form,
    })
    cells.update(kw)
    return [cells[h] for h in HEADER]


def write_sheet(rows):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(HEADER)
    for r in rows:
        ws.append(r)
    handle, path = tempfile.mkstemp(suffix='.xlsx')
    os.close(handle)
    wb.save(path)
    return path


class StrengthAndCategoryTest(TestCase):
    def test_excel_percentages_are_restored(self):
        self.assertEqual(clean_strength(0.01), '1%')
        self.assertEqual(clean_strength(0.025), '2.5%')
        self.assertEqual(clean_strength(0.00025), '0.025%')
        self.assertEqual(clean_strength(5e-05), '0.005%')
        self.assertEqual(clean_strength(0.1), '10%')

    def test_text_strengths_unchanged(self):
        self.assertEqual(clean_strength('500 mg'), '500 mg')
        self.assertEqual(clean_strength('125 mg/5 mL'), '125 mg/5 mL')
        self.assertEqual(clean_strength(None), '')

    def test_categories(self):
        self.assertEqual(category_for('Tablet'), 'Tablets & Capsules')
        self.assertEqual(category_for('Oral suspension'), 'Syrups & Liquids')
        self.assertEqual(category_for('Injection'), 'Injections & Infusions')
        self.assertEqual(category_for('Topical gel'), 'Creams, Gels & Ointments')
        self.assertEqual(category_for('Eye drops'), 'Eye & Ear')
        self.assertEqual(category_for('Inhaler'), 'Respiratory')
        self.assertEqual(category_for('Suppository'), 'Other Dosage Forms')


class ImportCommandTest(TestCase):
    def run_import(self, rows, *args):
        path = write_sheet(rows)
        self.addCleanup(os.remove, path)
        out = StringIO()
        call_command('import_medicines', path, *args, stdout=out)
        return out.getvalue()

    def test_creates_parts_with_details(self):
        self.run_import([
            row('NEXA-MED-00001', 'Paracetamol', '500 mg', 'Tablet', **{
                'Brand Name': 'Dolo', 'Selling Price per Unit': 2.5,
                'MRP per Unit': 3, 'Reorder Level': 100,
            }),
            row('NEXA-MED-00009', 'Diclofenac', 0.01, 'Topical gel'),
        ])
        para = Part.objects.get(IPN='NEXA-MED-00001')
        self.assertEqual(para.name, 'Paracetamol 500 mg Tablet')
        self.assertEqual(para.category.name, 'Tablets & Capsules')
        self.assertEqual(para.minimum_stock, 100)
        self.assertTrue(para.salable and para.purchaseable and para.active)
        info = para.medicine_info
        self.assertEqual((info.generic_name, info.brand), ('Paracetamol', 'Dolo'))
        self.assertEqual(str(info.selling_price), '2.50')
        self.assertEqual(str(info.mrp), '3.00')
        gel = Part.objects.get(IPN='NEXA-MED-00009')
        self.assertEqual(gel.name, 'Diclofenac 1% Topical gel')
        self.assertEqual(gel.category.name, 'Creams, Gels & Ointments')

    def test_rerun_updates_instead_of_duplicating(self):
        self.run_import([row('NEXA-MED-00001', 'Paracetamol', '500 mg', 'Tablet')])
        self.run_import([
            row('NEXA-MED-00001', 'Paracetamol', '500 mg', 'Tablet', **{'Brand Name': 'Crocin'})
        ])
        self.assertEqual(Part.objects.filter(IPN='NEXA-MED-00001').count(), 1)
        self.assertEqual(MedicineInfo.objects.get().brand, 'Crocin')
        self.assertEqual(PartCategory.objects.filter(name='Tablets & Capsules').count(), 1)

    def test_prescription_column_and_controlled_defaults(self):
        self.run_import([
            row('A', 'Amoxicillin', '500 mg', 'Capsule', **{'Prescription Required (Yes/No)': 'Yes'}),
            row('B', 'Paracetamol', '500 mg', 'Tablet', **{'Prescription Required (Yes/No)': 'No'}),
            row('C', 'Morphine', '10 mg/mL', 'Injection', **{'Prescription Required (Yes/No)': 'No'}),
            row('D', 'Cetirizine', '10 mg', 'Tablet'),
        ])
        flags = {
            p.part.IPN: (p.requires_prescription, p.is_controlled)
            for p in MedicineInfo.objects.select_related('part')
        }
        self.assertEqual(flags['A'], (True, False))
        self.assertEqual(flags['B'], (False, False))
        self.assertEqual(flags['C'], (True, True))  # controlled cannot be downgraded
        self.assertEqual(flags['D'], (False, False))  # blank column leaves it unflagged

    def test_blank_prescription_column_keeps_existing_flag(self):
        self.run_import([
            row('A', 'Amoxicillin', '500 mg', 'Capsule', **{'Prescription Required (Yes/No)': 'Yes'})
        ])
        self.run_import([row('A', 'Amoxicillin', '500 mg', 'Capsule')])
        self.assertTrue(MedicineInfo.objects.get().requires_prescription)

    def test_opening_stock_created_once(self):
        stocked = row('A', 'Paracetamol', '500 mg', 'Tablet', **{
            'Batch Number': 'B-77', 'Expiry Date': date(2027, 6, 30),
            'Quantity Received': 100, 'Free/Bonus Quantity': 10,
            'Storage Location': 'Main Branch',
        })
        self.run_import([stocked])
        self.run_import([stocked])
        item = StockItem.objects.get()
        self.assertEqual((item.batch, item.quantity, item.expiry_date), ('B-77', 110, date(2027, 6, 30)))
        self.assertEqual(item.location.name, 'Main Branch')

    def test_incomplete_batch_line_creates_no_stock(self):
        self.run_import([row('A', 'Paracetamol', '500 mg', 'Tablet', **{'Batch Number': 'B-1'})])
        self.assertEqual(StockItem.objects.count(), 0)

    def test_dry_run_saves_nothing(self):
        output = self.run_import([row('A', 'Paracetamol', '500 mg', 'Tablet')], '--dry-run')
        self.assertIn('DRY RUN', output)
        self.assertEqual(Part.objects.count(), 0)

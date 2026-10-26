"""Import the pharmacy medicine master sheet (.xlsx) as Parts.

    python manage.py import_medicines "Medicine Entry and Sales.xlsx" [--dry-run]

Re-runnable: medicines are matched on SKU (Part.IPN) and updated, never
duplicated. Reads the first sheet, whose columns are:

    Medicine Code/SKU | Generic Medicine Name | Strength | Dosage Form |
    Brand Name | Manufacturer | ... | Batch Number | Expiry Date |
    Quantity Received | ... | MRP per Unit | Selling Price per Unit |
    Storage Location | Reorder Level | Prescription Required (Yes/No) | Remarks

If a row has batch, expiry and quantity it also creates that batch as
opening stock (once per part + batch).
"""

from datetime import date, datetime
from decimal import Decimal, InvalidOperation

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from part.models import Part, PartCategory
from stock.models import StockItem, StockLocation

from nexa_inventory.models import MedicineInfo

# Narcotic / psychotropic medicines found in the master list. These are
# always imported as controlled (and so prescription-only). The sheet's own
# "Prescription Required" column cannot downgrade them.
CONTROLLED_GENERICS = {'morphine', 'tramadol', 'diazepam', 'clonazepam'}

CATEGORY_BY_FORM = {
    'Tablets & Capsules': (
        'tablet', 'capsule', 'chewable tablet', 'extended-release tablet',
        'vaginal tablet', 'dispersible tablet', 'sublingual tablet',
        'modified-release tablet', 'controlled-release tablet',
        'modified-release capsule',
    ),
    'Syrups & Liquids': (
        'oral suspension', 'oral solution', 'syrup', 'powder', 'powder sachet',
    ),
    'Injections & Infusions': ('injection', 'infusion'),
    'Creams, Gels & Ointments': (
        'topical cream', 'topical gel', 'topical ointment', 'shampoo',
    ),
    'Eye & Ear': ('eye drops', 'ear drops'),
    'Respiratory': ('inhaler', 'nebulizer solution', 'nebulizer suspension'),
}
OTHER_CATEGORY = 'Other Dosage Forms'


def category_for(dosage_form):
    form = (dosage_form or '').strip().lower()
    for category, forms in CATEGORY_BY_FORM.items():
        if form in forms:
            return category
    return OTHER_CATEGORY


def clean_strength(value):
    """Strength as text. Excel stores '1%' as 0.01, so a bare number below 1
    is a percentage and is converted back ('1%', '0.025%', '0.005%').
    """
    if value is None:
        return ''
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        number = Decimal(str(value))
        if 0 < number < 1:
            percent = (number * 100).normalize()
            return f'{format(percent, "f")}%'
        return format(number.normalize(), 'f')
    return str(value).strip()


def to_decimal(value):
    if value in (None, ''):
        return None
    try:
        return Decimal(str(value)).quantize(Decimal('0.01'))
    except (InvalidOperation, ValueError):
        return None


def to_date(value):
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, str) and value.strip():
        try:
            return date.fromisoformat(value.strip()[:10])
        except ValueError:
            return None
    return None


def yes_no(value):
    text = str(value or '').strip().lower()
    if text in ('yes', 'y', 'true', '1'):
        return True
    if text in ('no', 'n', 'false', '0'):
        return False
    return None


def display_name(generic, strength, form):
    return ' '.join(p for p in (generic, strength, form) if p)


class Command(BaseCommand):
    help = 'Import the medicine master sheet (.xlsx) as parts (re-runnable)'

    def add_arguments(self, parser):
        parser.add_argument('path', help='Path to the .xlsx file (first sheet is read)')
        parser.add_argument(
            '--dry-run', action='store_true', help='Show what would change, write nothing'
        )

    def handle(self, *args, **options):
        try:
            import openpyxl
        except ImportError as exc:  # pragma: no cover
            raise CommandError('openpyxl is required to read .xlsx files') from exc

        try:
            workbook = openpyxl.load_workbook(options['path'], data_only=True)
        except Exception as exc:
            raise CommandError(f'Cannot read {options["path"]}: {exc}') from exc

        rows = [
            r for r in workbook.worksheets[0].iter_rows(min_row=2, values_only=True)
            if r and r[0] and str(r[0]).strip()
        ]
        if not rows:
            raise CommandError('No medicine rows found on the first sheet')

        stats = dict(created=0, updated=0, stock=0, controlled=0, skipped=0)
        with transaction.atomic():
            for row in rows:
                self._import_row(row, stats)
            if options['dry_run']:
                transaction.set_rollback(True)

        prefix = 'DRY RUN - nothing saved. ' if options['dry_run'] else ''
        self.stdout.write(self.style.SUCCESS(
            f'{prefix}{len(rows)} rows: {stats["created"]} created, {stats["updated"]} updated, '
            f'{stats["controlled"]} controlled, {stats["stock"]} opening batches, '
            f'{stats["skipped"]} skipped'
        ))

    def _import_row(self, row, stats):
        cell = list(row) + [None] * (21 - len(row))
        sku = str(cell[0]).strip()
        generic = str(cell[1] or '').strip()
        if not generic:
            stats['skipped'] += 1
            return

        strength = clean_strength(cell[2])
        form = str(cell[3] or '').strip()
        brand = str(cell[4] or '').strip()
        manufacturer = str(cell[5] or '').strip()
        batch = str(cell[10] or '').strip()
        expiry = to_date(cell[11])
        received = to_decimal(cell[12])
        bonus = to_decimal(cell[13]) or Decimal('0')
        mrp = to_decimal(cell[15])
        selling = to_decimal(cell[16])
        storage = str(cell[17] or '').strip()
        reorder = to_decimal(cell[18])
        rx_flag = yes_no(cell[19])

        name = display_name(generic, strength, form)
        description = name if not brand else f'{name} ({brand})'
        category, _ = PartCategory.objects.get_or_create(name=category_for(form), parent=None)

        part = Part.objects.filter(IPN=sku).first()
        values = dict(
            name=name,
            description=description[:250],
            category=category,
            keywords=' '.join(x for x in (generic, brand, form) if x)[:250],
            salable=True,
            purchaseable=True,
            active=True,
        )
        if reorder is not None:
            values['minimum_stock'] = reorder

        if part is None:
            part = Part(IPN=sku, **values)
            part.save()
            stats['created'] += 1
        else:
            for key, value in values.items():
                setattr(part, key, value)
            part.save()
            stats['updated'] += 1

        info, _ = MedicineInfo.objects.get_or_create(part=part)
        info.generic_name = generic
        info.strength = strength
        info.dosage_form = form
        info.brand = brand
        info.manufacturer = manufacturer
        if mrp is not None:
            info.mrp = mrp
        if selling is not None:
            info.selling_price = selling
        if rx_flag is not None:
            info.requires_prescription = rx_flag
        if generic.lower() in CONTROLLED_GENERICS:
            info.is_controlled = True
            info.requires_prescription = True
            stats['controlled'] += 1
        info.save()

        # Opening stock only when the sheet gives a complete batch line
        if batch and expiry and received and received + bonus > 0:
            if not StockItem.objects.filter(part=part, batch=batch).exists():
                location = None
                if storage:
                    location, _ = StockLocation.objects.get_or_create(name=storage, parent=None)
                StockItem.objects.create(
                    part=part,
                    quantity=received + bonus,
                    batch=batch,
                    expiry_date=expiry,
                    location=location,
                )
                stats['stock'] += 1

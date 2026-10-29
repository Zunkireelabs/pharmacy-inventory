"""Nepali (B.S.) dates printed on bills."""

from datetime import date, timedelta

from django.test import SimpleTestCase

from .bs_date import MONTH_DAYS, ad_to_bs, bs_to_ad, format_bs


class BsDateTest(SimpleTestCase):
    def test_new_year_days(self):
        # 1 Baisakh of each year, as printed in Nepali calendars
        self.assertEqual(format_bs(date(2019, 4, 14)), '2076/01/01')
        self.assertEqual(format_bs(date(2023, 4, 14)), '2080/01/01')
        self.assertEqual(format_bs(date(2024, 4, 13)), '2081/01/01')
        self.assertEqual(format_bs(date(2025, 4, 14)), '2082/01/01')
        self.assertEqual(format_bs(date(2026, 4, 14)), '2083/01/01')

    def test_last_day_of_year_and_round_trip(self):
        self.assertEqual(ad_to_bs(date(2026, 4, 13)), (2082, 12, 30))
        day = date(2018, 4, 14)
        while day < date(2039, 4, 1):
            self.assertEqual(bs_to_ad(*ad_to_bs(day)), day)
            day += timedelta(days=17)

    def test_out_of_range(self):
        self.assertEqual(format_bs(date(2010, 1, 1)), '')
        self.assertEqual(format_bs(date(2060, 1, 1)), '')

    def test_table_is_sane(self):
        for year, months in MONTH_DAYS.items():
            self.assertEqual(len(months), 12, year)
            self.assertIn(sum(months), (365, 366), year)

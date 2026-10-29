"""Nepali (Bikram Sambat, B.S.) dates for printed bills.

B.S. month lengths change every year, so they come from a table, not a
formula. Years 2075-2095 B.S. (April 2018 - April 2039); later years in the
source are projections (2096 even sums to 364 days), so they are left out.
Source: the month table of the open-source nepali-datetime package
(calendar_bs.csv), copied here so the image needs no extra dependency.
"""

from datetime import date, timedelta

# 1 Baisakh 2075 B.S.
FIRST_DAY_AD = date(2018, 4, 14)
FIRST_YEAR = 2075

MONTH_DAYS = {
    2075: (31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30),
    2076: (31, 32, 31, 32, 31, 30, 30, 30, 29, 29, 30, 30),
    2077: (31, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 31),
    2078: (31, 31, 31, 32, 31, 31, 30, 29, 30, 29, 30, 30),
    2079: (31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30),
    2080: (31, 32, 31, 32, 31, 30, 30, 30, 29, 29, 30, 30),
    2081: (31, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 31),
    2082: (31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30),
    2083: (31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30),
    2084: (31, 31, 32, 31, 31, 30, 30, 30, 29, 30, 30, 30),
    2085: (31, 32, 31, 32, 30, 31, 30, 30, 29, 30, 30, 30),
    2086: (30, 32, 31, 32, 31, 30, 30, 30, 29, 30, 30, 30),
    2087: (31, 31, 32, 31, 31, 31, 30, 29, 30, 30, 30, 30),
    2088: (30, 31, 32, 32, 30, 31, 30, 30, 29, 30, 30, 30),
    2089: (30, 32, 31, 32, 31, 30, 30, 30, 29, 30, 30, 30),
    2090: (30, 32, 31, 32, 31, 30, 30, 30, 29, 30, 30, 30),
    2091: (31, 31, 32, 31, 31, 31, 30, 30, 29, 30, 30, 30),
    2092: (30, 31, 32, 32, 31, 30, 30, 30, 29, 30, 30, 30),
    2093: (30, 32, 31, 32, 31, 30, 30, 30, 29, 30, 30, 30),
    2094: (31, 31, 32, 31, 31, 30, 30, 30, 29, 30, 30, 30),
    2095: (31, 31, 32, 31, 31, 31, 30, 29, 30, 30, 30, 30),
}


def ad_to_bs(day):
    """(year, month, day) in B.S. for an English (A.D.) date, or None if the
    date is outside the table.
    """
    offset = (day - FIRST_DAY_AD).days
    if offset < 0:
        return None
    for year in range(FIRST_YEAR, FIRST_YEAR + len(MONTH_DAYS)):
        for month, length in enumerate(MONTH_DAYS[year], start=1):
            if offset < length:
                return year, month, offset + 1
            offset -= length
    return None


def bs_to_ad(year, month, day):
    """English (A.D.) date for a B.S. date (used by tests and checks)."""
    offset = sum(sum(MONTH_DAYS[y]) for y in range(FIRST_YEAR, year))
    offset += sum(MONTH_DAYS[year][: month - 1]) + day - 1
    return FIRST_DAY_AD + timedelta(days=offset)


def format_bs(day):
    """"2083/07/12" style B.S. date, or '' when out of range."""
    bs = ad_to_bs(day)
    return f'{bs[0]}/{bs[1]:02d}/{bs[2]:02d}' if bs else ''

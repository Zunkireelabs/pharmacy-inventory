import { t } from '@lingui/core/macro';
import { Button } from '@mantine/core';
import { IconPackageImport } from '@tabler/icons-react';
import { useState } from 'react';

import { MedicineEntryModal } from './MedicineEntryModal';

/**
 * Receive stock: records a NEW batch (batch code + expiry month/year) of a
 * medicine that is already in the list. Each delivery is its own batch so
 * that earliest-expiry-first selling and expiry reports work per batch.
 */
export default function RestockButton({
  fullWidth,
  onSaved
}: Readonly<{ fullWidth?: boolean; onSaved?: () => void }> = {}) {
  const [opened, setOpened] = useState(false);

  return (
    <>
      <Button
        variant='light'
        size='md'
        fullWidth={fullWidth}
        leftSection={<IconPackageImport size={18} />}
        onClick={() => setOpened(true)}
      >
        {t`Receive Stock`}
      </Button>
      <MedicineEntryModal
        opened={opened}
        onClose={() => setOpened(false)}
        initialMode='existing'
        onSaved={onSaved}
      />
    </>
  );
}

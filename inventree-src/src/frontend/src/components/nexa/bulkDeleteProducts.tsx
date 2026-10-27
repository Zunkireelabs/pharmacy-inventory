import { t } from '@lingui/core/macro';
import { Text } from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';

import { api } from '../../App';
import { SLOW_REQUEST } from './slow';

/**
 * Ask for confirmation, then delete the selected products in one go.
 * Products with stock or sales history are made inactive instead, so old
 * bills and reports stay correct.
 */
export function openBulkDeleteProducts(
  ids: number[],
  onDone: () => void
) {
  modals.openConfirmModal({
    title: t`Delete ${ids.length} products?`,
    children: (
      <Text size='sm'>
        {t`Products that were never stocked or sold are deleted. Products with stock or sales history are made inactive instead, so old bills stay correct.`}
      </Text>
    ),
    labels: { confirm: t`Delete`, cancel: t`Cancel` },
    confirmProps: { color: 'red' },
    onConfirm: async () => {
      try {
        const response = await api.post(
          '/plugin/nexainventory/products/bulk-delete/',
          { part_ids: ids },
          SLOW_REQUEST
        );
        const { deleted, deactivated } = response.data;
        notifications.show({
          title: t`Products updated`,
          message: t`${deleted} deleted, ${deactivated} made inactive`,
          color: 'green'
        });
      } catch (error: any) {
        notifications.show({
          title: t`Could not delete products`,
          message: error?.response?.data?.detail ?? t`Please try again`,
          color: 'red'
        });
      }
      onDone();
    }
  });
}

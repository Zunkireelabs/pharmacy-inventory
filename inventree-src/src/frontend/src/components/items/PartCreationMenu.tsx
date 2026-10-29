import { ApiEndpoints } from '@lib/enums/ApiEndpoints';
import { ModelType } from '@lib/enums/ModelType';
import { UserRoles } from '@lib/enums/Roles';
import { t } from '@lingui/core/macro';
import {
  IconFileUpload,
  IconPackageImport,
  IconPlus
} from '@tabler/icons-react';
import { type RefObject, useMemo, useState } from 'react';
import { dataImporterSessionFields } from '../../forms/ImporterForms';
import { usePartFields } from '../../forms/PartForms';
import { useCreateApiFormModal } from '../../hooks/UseForm';
import { usePluginsWithMixin } from '../../hooks/UsePlugins';
import { openGlobalImporter } from '../../states/ImporterState';
import { useUserState } from '../../states/UserState';
import ImportPartWizard from '../wizards/ImportPartWizard';
import { MedicineEntryModal } from '../nexa/MedicineEntryModal';
import { ActionDropdown } from './ActionDropdown';

export function PartCreationMenu({
  categoryId,
  initialData,
  basePartInstance,
  enableImport = true,
  refreshRef
}: Readonly<{
  categoryId?: any;
  initialData?: Record<string, any>;
  basePartInstance?: any;
  enableImport?: boolean;
  refreshRef?: RefObject<() => void>;
}>) {
  const user = useUserState();

  const importSessionFields = useMemo(() => {
    const fields = dataImporterSessionFields({ modelType: ModelType.part });
    fields.field_defaults.value = initialData ?? { category: categoryId };
    return fields;
  }, [categoryId, initialData]);

  const importParts = useCreateApiFormModal({
    url: ApiEndpoints.import_session_list,
    title: t`Import Parts`,
    fields: importSessionFields,
    onFormSuccess: (response: any) => {
      openGlobalImporter(response.pk, { onClose: refreshRef?.current });
    }
  });

  const partInitialData = useMemo(
    () => initialData ?? { category: categoryId },
    [categoryId, initialData]
  );

  const newPartFields = usePartFields({
    create: true,
    duplicatePartInstance: basePartInstance
  });

  const newPart = useCreateApiFormModal({
    url: ApiEndpoints.part_list,
    title: t`Add Part`,
    fields: newPartFields,
    initialData: partInitialData,
    follow: true,
    modelType: ModelType.part,
    keepOpenOption: true
  });

  const supplierPlugins = usePluginsWithMixin('supplier');
  const importPartWizard = ImportPartWizard({ categoryId });

  // Nexa: medicines are added with the pharmacy form (medicine + first
  // batch in one save). The generic part form stays for edit / duplicate.
  const [medicineOpen, setMedicineOpen] = useState(false);
  const isStaff = user.isStaff() || user.isSuperuser();

  return (
    <>
      <MedicineEntryModal
        opened={medicineOpen}
        onClose={() => setMedicineOpen(false)}
        initialMode='new'
        initialCategoryId={categoryId ?? initialData?.category}
        onSaved={() => refreshRef?.current?.()}
      />
      {newPart.modal}
      {importParts.modal}
      {importPartWizard.wizard}
      <ActionDropdown
        key='add-parts-actions'
        tooltip={t`Add Parts`}
        position='bottom-start'
        icon={<IconPlus />}
        hidden={!user.hasAddRole(UserRoles.part)}
        actions={[
          {
            name: t`New Medicine`,
            icon: <IconPlus />,
            tooltip: t`Add a new medicine and its first batch`,
            hidden: !isStaff,
            onClick: () => setMedicineOpen(true)
          },
          {
            name: t`Create Part`,
            icon: <IconPlus />,
            tooltip: t`Create a new part`,
            hidden: true,
            onClick: () => newPart.open()
          },
          {
            name: t`Import from File`,
            icon: <IconFileUpload />,
            tooltip: t`Import parts from a file`,
            onClick: () => importParts.open(),
            hidden: !enableImport
          },
          {
            name: t`Import from Supplier`,
            icon: <IconPackageImport />,
            tooltip: t`Import parts from a supplier plugin`,
            hidden: !enableImport || supplierPlugins.length === 0,
            onClick: () => importPartWizard.openWizard()
          }
        ]}
      />
    </>
  );
}

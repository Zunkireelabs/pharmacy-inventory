import { t } from '@lingui/core/macro';
import PageTitle from '../../components/nav/PageTitle';
import NexaDashboard from '../../components/nexa/NexaDashboard';

// The Nexa dashboard replaces InvenTree's generic configurable widget
// dashboard as the primary landing experience — this app's home page is
// the business dashboard, not a widget picker.
export default function Home() {
  return (
    <>
      <PageTitle title={t`Dashboard`} />
      <NexaDashboard />
    </>
  );
}

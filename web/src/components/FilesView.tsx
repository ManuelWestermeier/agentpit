import { FilesPanel } from './FilesPanel';
import { PreviewPanel } from './PreviewPanel';

export function FilesView() {
  return (
    <div className="filesview">
      <div className="filesview-list"><FilesPanel /></div>
      <div className="filesview-preview"><PreviewPanel /></div>
    </div>
  );
}

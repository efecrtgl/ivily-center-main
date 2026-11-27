import { Icon } from '../../icons/Icon.jsx';

/** Explorer placeholder: folders cannot be opened until the workspace system (Phase 3) and
 *  file explorer (Phase 4) exist, and the UI says so plainly. */
export function ExplorerView() {
  return (
    <div className="empty-state">
      <Icon name="files" size={28} />
      <div>No folder open</div>
      <div className="subtle">Opening folders and browsing files is not available yet in this development build.</div>
    </div>
  );
}
